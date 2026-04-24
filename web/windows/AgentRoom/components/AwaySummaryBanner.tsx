// AwaySummaryBanner —— "你不在的这段时间发生了什么"
//
// 纯前端实现：
//   - 用 localStorage['agentroom:last-seen:<roomId>'] 追踪用户上次离开时间戳
//   - 切换房间 / 标签页 blur / 窗口 unload 时写入
//   - 房间渲染时若离开 > threshold（默认 10 分钟）且存在新消息，展示摘要横幅
//   - 统计：新消息条数、新决策、新的 humanNeeded、新工具调用、哪位 agent 最活跃
//   - 点"查看第一条"滚动到第一条未读；点"已读"把 lastSeen 更新到现在
//
// 和 HumanNeededBanner 的区别：这个是"回来时一次性概览"，HumanNeeded 是"持续性请求高亮"。

import React, { useEffect, useMemo, useState } from 'react';
import type { Member, Message } from '../types';

const LAST_SEEN_KEY = (roomId: string) => `agentroom:last-seen:${roomId}`;
const DISMISSED_KEY = (roomId: string) => `agentroom:away-dismissed:${roomId}`;
const THRESHOLD_MS = 10 * 60 * 1000; // 10 分钟

interface Props {
  roomId: string;
  messages: Message[];
  members: Map<string, Member>;
  meId: string;
  onJump?: (messageId: string) => void;
}

function readLastSeen(roomId: string): number {
  try { return parseInt(localStorage.getItem(LAST_SEEN_KEY(roomId)) || '0') || 0; }
  catch { return 0; }
}
function writeLastSeen(roomId: string, ts: number) {
  try { localStorage.setItem(LAST_SEEN_KEY(roomId), String(ts)); } catch { /* ignore */ }
}
function readDismissed(roomId: string): number {
  try { return parseInt(localStorage.getItem(DISMISSED_KEY(roomId)) || '0') || 0; }
  catch { return 0; }
}
function writeDismissed(roomId: string, ts: number) {
  try { localStorage.setItem(DISMISSED_KEY(roomId), String(ts)); } catch { /* ignore */ }
}

function fmtAwayDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  const d = Math.floor(h / 24);
  return `${d} 天 ${h % 24} 小时`;
}

const AwaySummaryBanner: React.FC<Props> = ({ roomId, messages, members, meId, onJump }) => {
  const [dismissedAt, setDismissedAt] = useState(() => readDismissed(roomId));
  const [lastSeen] = useState(() => readLastSeen(roomId));

  // 切房 / 标签 blur / 关闭 时刷新 lastSeen，但**此处 useState 已冻结 mount 时的值**，
  // 所以 banner 计算基于"打开房间那一刻"的 lastSeen 快照，符合"回来那瞬间快报"的语义。
  useEffect(() => {
    const flush = () => { writeLastSeen(roomId, Date.now()); };
    const onVis = () => { if (document.hidden) flush(); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      flush();
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [roomId]);

  const summary = useMemo(() => {
    // 触发窗口：lastSeen 有值、距今 > THRESHOLD_MS 且 > dismissedAt
    const now = Date.now();
    if (!lastSeen) return null;
    const away = now - lastSeen;
    if (away < THRESHOLD_MS) return null;
    if (dismissedAt > lastSeen) return null;

    // 新消息 = timestamp > lastSeen & 非自己
    const fresh = messages.filter(m =>
      !m.deleted &&
      m.timestamp > lastSeen &&
      m.authorId !== meId,
    );
    if (fresh.length === 0) return null;

    const decisions = fresh.filter(m => m.isDecision).length;
    const humanNeeded = fresh.filter(m => !!m.humanNeeded).length;
    const toolCalls = fresh.filter(m => m.kind === 'tool').length;
    const artifacts = fresh.filter(m => m.kind === 'artifact_ref' || m.kind === 'minutes').length;

    // 最活跃作者
    const authorCount = new Map<string, number>();
    for (const m of fresh) {
      authorCount.set(m.authorId, (authorCount.get(m.authorId) || 0) + 1);
    }
    let topAuthor: string | null = null;
    let topCount = 0;
    for (const [aid, c] of authorCount) {
      if (c > topCount) { topCount = c; topAuthor = aid; }
    }

    return {
      firstId: fresh[0].id,
      away,
      total: fresh.length,
      decisions,
      humanNeeded,
      toolCalls,
      artifacts,
      topAuthor,
      topCount,
    };
  }, [messages, meId, lastSeen, dismissedAt]);

  if (!summary) return null;

  const dismiss = () => {
    const now = Date.now();
    writeDismissed(roomId, now);
    writeLastSeen(roomId, now);
    setDismissedAt(now);
  };

  const jumpFirst = () => {
    onJump?.(summary.firstId);
    dismiss();
  };

  return (
    <div className="mx-3 my-2 rounded-lg border border-cyan-500/40 bg-cyan-500/10 p-2.5 animate-fade-in">
      <div className="flex items-start gap-2">
        <span className="material-symbols-outlined text-[20px] text-cyan-500 shrink-0">waving_hand</span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-cyan-700 dark:text-cyan-300">
            欢迎回来 · 你离开了 {fmtAwayDuration(summary.away)}
          </div>
          <div className="mt-0.5 text-[11px] text-text-secondary flex flex-wrap gap-x-3 gap-y-0.5">
            <span>新消息 <span className="font-bold text-text">{summary.total}</span></span>
            {summary.decisions > 0 && (
              <span className="text-emerald-600 dark:text-emerald-400">决策 {summary.decisions}</span>
            )}
            {summary.humanNeeded > 0 && (
              <span className="text-amber-600 dark:text-amber-400 font-semibold">需人介入 {summary.humanNeeded}</span>
            )}
            {summary.toolCalls > 0 && (
              <span className="text-blue-600 dark:text-blue-400">工具调用 {summary.toolCalls}</span>
            )}
            {summary.artifacts > 0 && (
              <span className="text-purple-600 dark:text-purple-400">产出 {summary.artifacts}</span>
            )}
            {summary.topAuthor && (
              <span>
                最活跃：<span className="font-semibold">{members.get(summary.topAuthor)?.name ?? summary.topAuthor}</span>（{summary.topCount}）
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onJump && (
            <button
              type="button"
              onClick={jumpFirst}
              className="px-2 h-6 rounded text-[11px] font-semibold bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-700 dark:text-cyan-200 border border-cyan-500/40"
              title="跳转到我离开后第一条消息"
            >
              跳到未读
            </button>
          )}
          <button
            type="button"
            onClick={dismiss}
            className="px-2 h-6 rounded text-[11px] text-text-muted hover:text-text hover:bg-surface-sunken"
            title="标记全部已读"
          >
            已读
          </button>
        </div>
      </div>
    </div>
  );
};

export default AwaySummaryBanner;
