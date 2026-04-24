// useRoom —— 房间状态订阅 hook（含事件总线 → React state 桥接）
//
// v0.4：所有 agent 推理走 OpenClaw Gateway RPC，工具调用审批由 OpenClaw 原生流处理。
// 因此本 hook 不再维护 pendingApprovals — 审批 UI 由 OpenClaw 桌面/浏览器 UI 接管。
//
// v0.4 对齐 Sessions.tsx 的三个稳定性模式：
//   1) patch-grace —— 本地刚收到 WS patch 后，10s 内 refetch 的服务器值会与本地合并而不覆盖，
//      防止服务器写后读延迟（DB commit → 新事务 select 之间）让 UI 看到闪回旧值。
//   2) finalizedMessages —— 已收到 final 语义 (streaming=false/deleted) 的消息，
//      后续再来的 message.update 若试图把它改回 streaming 或覆盖内容一律忽略，
//      防止并发 runAgent / 重试导致同一条消息闪烁。
//   3) context_compaction 横幅 —— 订阅 orchestrator 转发的 context.compaction 事件，
//      UI 顶部给出"正在压缩上下文"提示。
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import type { Room, Member, Message, RoomMetrics, InterventionEvent } from './types';
import {
  getRoom, listMembers, listMessages, getMetrics, listInterventions,
  roomEvents, subscribeRoomChannel,
} from './service';

// patch-grace 窗口长度：对齐 Sessions.tsx 的 10s 约定。
const PATCH_GRACE_MS = 10_000;

export interface CompactionStatus {
  memberId?: string;
  sessionKey?: string;
  phase: 'start' | 'end';
  startedAt: number;
  endedAt?: number;
  willRetry?: boolean;
}

export interface RoomSnapshot {
  room: Room | null;
  members: Member[];
  memberMap: Map<string, Member>;
  messages: Message[];
  metrics: RoomMetrics | null;
  interventions: InterventionEvent[];
  loading: boolean;
  // v0.4：当前正在进行的上下文压缩；null = 空闲。UI 可据此渲染顶部横幅。
  compaction: CompactionStatus | null;
  // v1.0: bidding
  biddingInProgress: boolean;
}

export function useRoom(roomId: string | null): RoomSnapshot {
  const [room, setRoom] = useState<Room | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [metrics, setMetrics] = useState<RoomMetrics | null>(null);
  const [interventions, setInterventions] = useState<InterventionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [compaction, setCompaction] = useState<CompactionStatus | null>(null);
  const [biddingInProgress, setBiddingInProgress] = useState(false);

  // patch-grace：memberId / roomId=="__room__" → { patch, until }。
  // 收到 WS member.update / room.update 时记录；refetch 结果合并时若还在窗口内，
  // 本地 patch 字段胜过服务器返回，避免闪回。
  type Grace = { patch: Record<string, any>; until: number };
  const memberGrace = useRef<Map<string, Grace>>(new Map());
  const roomGrace = useRef<Grace | null>(null);
  // finalizedMessages：已被标记为 final / deleted / 有 reactions-only 以外重大变更的消息。
  // 再收到的 message.update 只允许"兼容性"字段（reactions / contentEdited / humanNeeded / decisionSummary）修改。
  const finalizedMessages = useRef<Set<string>>(new Set());

  // 工具：合并服务器快照与 grace 缓冲。
  const mergeMemberWithGrace = useCallback((m: Member): Member => {
    const g = memberGrace.current.get(m.id);
    if (!g || Date.now() >= g.until) {
      memberGrace.current.delete(m.id);
      return m;
    }
    return { ...m, ...g.patch } as Member;
  }, []);
  const mergeRoomWithGrace = useCallback((r: Room | null): Room | null => {
    if (!r) return r;
    const g = roomGrace.current;
    if (!g || Date.now() >= g.until) {
      if (g) roomGrace.current = null;
      return r;
    }
    return { ...r, ...g.patch } as Room;
  }, []);

  // 公共拉取函数：初始加载 & 重连后重拉都用它
  const refetch = useCallback((rid: string): Promise<void> => {
    return Promise.all([
      getRoom(rid), listMembers(rid), listMessages(rid),
      getMetrics(rid), listInterventions(rid),
    ]).then(([r, ms, msgs, mt, iv]) => {
      // patch-grace 合并：成员 / 房间 一视同仁。
      setRoom(mergeRoomWithGrace(r));
      setMembers(ms.map(mergeMemberWithGrace));
      // 消息列表暂不做 grace（消息以服务端为准；final dedup 在增量路径上处理）。
      setMessages(msgs);
      setMetrics(mt);
      setInterventions(iv);
    });
  }, [mergeMemberWithGrace, mergeRoomWithGrace]);

  // 初始加载
  useEffect(() => {
    if (!roomId) {
      setRoom(null); setMembers([]); setMessages([]); setMetrics(null); setInterventions([]);
      setCompaction(null);
      finalizedMessages.current.clear();
      memberGrace.current.clear();
      roomGrace.current = null;
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    refetch(roomId).then(() => {
      if (!cancelled) setLoading(false);
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [roomId, refetch]);

  // 事件订阅（含 WS 频道订阅 → EventBus 桥接）
  useEffect(() => {
    if (!roomId) return;
    const unsubs: Array<() => void> = [];

    // 1) 打开 WS 频道 agentroom:{roomId}，接入后端实时推送
    unsubs.push(subscribeRoomChannel(roomId));

    unsubs.push(roomEvents.on('message.append', ev => {
      if (ev.roomId !== roomId) return;
      setMessages(prev => {
        // 去重：WS 可能比 POST 响应先到；另外若是本地乐观占位与后端真实消息，
        // 靠 idempotencyKey 匹配并替换占位（id 形如 "__pending_<key>"）。
        const idem = ev.message.idempotencyKey;
        if (idem) {
          const idx = prev.findIndex(m => m.idempotencyKey === idem);
          if (idx >= 0) {
            // 占位已存在：真实消息覆盖占位；占位覆盖占位（同 key 第二次乐观插入）则忽略。
            if (ev.message.id.startsWith('__pending_') && !prev[idx].id.startsWith('__pending_')) {
              return prev; // 真实消息已在，占位不覆盖
            }
            const next = prev.slice();
            next[idx] = ev.message;
            return next;
          }
        }
        if (prev.some(m => m.id === ev.message.id)) return prev;
        return [...prev, ev.message];
      });
      // 如果消息到达即 final（非流式），直接登记 finalized。
      if (ev.message && (ev.message as any).streaming === false) {
        finalizedMessages.current.add(ev.message.id);
      }
    }));
    unsubs.push(roomEvents.on('message.update', ev => {
      if (ev.roomId !== roomId) return;
      const mid = ev.messageId;
      const patch = ev.patch || {};
      const isFinalizing = patch.streaming === false || patch.deleted === true;
      // finalizedMessages 去重：已 final 的消息只允许少数 "post-final" 字段更新
      // （reactions / contentEdited / humanNeeded / decisionSummary / isDecision / deleted）。
      // 其他字段（尤其是 content / streaming=true）被忽略，避免并发 runAgent / 重试导致闪烁。
      if (finalizedMessages.current.has(mid)) {
        const ALLOWED_POST_FINAL = new Set([
          'reactions', 'contentEdited', 'humanNeeded',
          'decisionSummary', 'isDecision', 'deleted',
        ]);
        const filtered: Record<string, any> = {};
        for (const [k, v] of Object.entries(patch)) {
          if (ALLOWED_POST_FINAL.has(k)) filtered[k] = v;
        }
        if (Object.keys(filtered).length === 0) return;
        setMessages(prev => prev.map(m => m.id === mid ? { ...m, ...filtered } : m));
        return;
      }
      setMessages(prev => prev.map(m => m.id === mid ? { ...m, ...patch } : m));
      if (isFinalizing) finalizedMessages.current.add(mid);
    }));
    unsubs.push(roomEvents.on('member.update', ev => {
      if (ev.roomId !== roomId) return;
      // patch-grace：记录本地已应用的字段，refetch 时与服务器合并优先用本地。
      const prev = memberGrace.current.get(ev.memberId);
      memberGrace.current.set(ev.memberId, {
        patch: { ...(prev?.patch || {}), ...ev.patch },
        until: Date.now() + PATCH_GRACE_MS,
      });
      setMembers(prev => prev.map(m => m.id === ev.memberId ? { ...m, ...ev.patch } : m));
    }));
    unsubs.push(roomEvents.on('member.added', ev => {
      if (ev.roomId !== roomId) return;
      setMembers(prev => {
        // 去重：同一个成员可能已经被乐观插入
        if (prev.some(m => m.id === ev.member.id)) return prev;
        return [...prev, ev.member];
      });
    }));
    unsubs.push(roomEvents.on('member.removed', ev => {
      if (ev.roomId !== roomId) return;
      setMembers(prev => prev.filter(m => m.id !== ev.memberId));
      // 级联删除时也清理本地消息
      if (ev.cascade) {
        setMessages(prev => prev.filter(m => m.authorId !== ev.memberId));
      }
    }));
    unsubs.push(roomEvents.on('room.update', ev => {
      if (ev.roomId !== roomId) return;
      roomGrace.current = {
        patch: { ...(roomGrace.current?.patch || {}), ...ev.patch },
        until: Date.now() + PATCH_GRACE_MS,
      };
      setRoom(prev => prev ? { ...prev, ...ev.patch } : prev);
    }));
    unsubs.push(roomEvents.on('planning.update', ev => {
      if (ev.roomId !== roomId) return;
      setRoom(prev => prev ? {
        ...prev,
        executionPhase: ev.phase,
        executionQueue: ev.queue,
        executionOwnerIdx: ev.executionOwnerIdx,
      } : prev);
    }));
    unsubs.push(roomEvents.on('intervention', iv => {
      if (iv.roomId !== roomId) return;
      setInterventions(prev => [...prev, iv]);
    }));
    // v0.4：context_compaction 事件 —— orchestrator/bridge 检测到 OpenClaw 正在压缩上下文时转发。
    // 前端渲染一个"正在压缩上下文"顶部横幅，结束后自动隐藏。
    unsubs.push(roomEvents.on('context.compaction', ev => {
      if (ev.roomId !== roomId) return;
      if (ev.phase === 'start') {
        setCompaction({
          memberId: ev.memberId,
          sessionKey: ev.sessionKey,
          phase: 'start',
          startedAt: Date.now(),
        });
      } else if (ev.phase === 'end') {
        setCompaction(prev => prev ? {
          ...prev,
          phase: 'end',
          endedAt: Date.now(),
          willRetry: ev.willRetry,
        } : null);
        // 2s 后清理，让用户看到"压缩完成"的瞬间
        const t = window.setTimeout(() => setCompaction(null), 2000);
        unsubs.push(() => window.clearTimeout(t));
      }
    }));
    // v1.0: bidding.start / bidding.snapshot
    unsubs.push(roomEvents.on('bidding.start', ev => {
      if (ev.roomId !== roomId) return;
      setBiddingInProgress(true);
    }));
    unsubs.push(roomEvents.on('bidding.snapshot', ev => {
      if (ev.roomId !== roomId) return;
      setBiddingInProgress(false);
    }));
    // WS 重连后重拉整包状态（补齐断线期间丢失的事件）
    unsubs.push(roomEvents.on('ws.status', ev => {
      if (ev.status === 'open' && ev.reconnected) {
        refetch(roomId).catch(() => { /* fallback: 下次交互再拉 */ });
      }
    }));

    return () => { unsubs.forEach(fn => fn && fn()); };
  }, [roomId, refetch]);

  const memberMap = useMemo(() => new Map(members.map(m => [m.id, m])), [members]);

  return { room, members, memberMap, messages, metrics, interventions, loading, compaction, biddingInProgress };
}

export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // 在输入框中按 Space 不触发暂停
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const key = (mod ? '⌘' : '') + (e.shiftKey ? '⇧' : '') + e.key;
      const plainKey = e.key;
      if (map[key]) { e.preventDefault(); map[key](e); return; }
      if (map[plainKey]) { e.preventDefault(); map[plainKey](e); return; }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [map]);
}
