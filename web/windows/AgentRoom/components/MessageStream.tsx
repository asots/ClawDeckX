// 消息流容器 —— 虚拟滚动（>50 条时启用，@tanstack/react-virtual）
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Member, Message } from '../types';
import type { SystemModel } from '../service';
import MessageBubble from './MessageBubble';
import { MemberAvatar, formatTime } from '../shared';

// v0.9：聚合项的内部类型。
//   message    → 单条普通消息，继续走 MessageBubble
//   tool-group → 连续同作者的 N 条工具调用，走 ToolRunGroup 单卡片
type RenderItem =
  | { kind: 'message'; message: Message }
  | { kind: 'tool-group'; key: string; authorId: string; messages: Message[] };

// ── ToolRunGroup ──
// 把 agent 一轮里连发的 N 个工具（典型场景：exec → write → exec → ...）聚合成一张卡片。
//
// 设计：
//   - 头部：作者头像 + 作者名 + "运行 N 个工具 · X 成功 / Y 失败 / Z 运行中" + 时间段 + 折叠箭头
//   - 折叠态（默认）：只显示头部 + 一行"最近一次：{toolName} {首行预览}"
//   - 展开态：按时间顺序纵向列出每个 ToolCallCard（复用单条工具的单行折叠 UI）
//
// 为了复用 MessageBubble 里的 ToolCallCard 逻辑，这里直接把 `message.kind === 'tool'` 的
// MessageBubble 拼出来——不重复实现头部/状态/乱码检测。
const ToolRunGroup: React.FC<{
  messages: Message[];
  author?: Member;
  members: Map<string, Member>;
  onApproveTool?: (messageId: string) => void;
  onRejectTool?: (messageId: string) => void;
}> = ({ messages, author, members, onApproveTool, onRejectTool }) => {
  const [expanded, setExpanded] = useState(false);

  const okCount = messages.filter(m => m.toolStatus === 'success').length;
  const failCount = messages.filter(m => m.toolStatus === 'failure' || m.toolStatus === 'timeout' || m.toolStatus === 'rejected').length;
  const runningCount = messages.filter(m => m.toolStatus === 'running' || m.toolStatus === 'pending').length;
  const pendingApproval = messages.some(m => m.toolStatus === 'pending');

  const firstTs = messages[0].timestamp;
  const lastTs = messages[messages.length - 1].timestamp;
  const durationSec = Math.max(0, Math.round((lastTs - firstTs) / 1000));

  // 折叠时的一行摘要：取最近一条工具
  const last = messages[messages.length - 1];
  const lastName = last.toolName || 'tool';
  const lastFirstLine = (last.toolResult || '').split(/\r?\n/).find(l => l.trim().length > 0)?.trim() ?? '';
  const lastPreview = lastFirstLine.length > 100 ? lastFirstLine.slice(0, 100) + '…' : lastFirstLine;

  // 有任何 running/pending 整组标记为进行中；否则有 fail 显示警告；都 ok 显示完成。
  const accent = runningCount > 0
    ? 'border-cyan-500/30 bg-cyan-500/[0.04]'
    : failCount > 0
    ? 'border-amber-500/30 bg-amber-500/[0.04]'
    : 'border-green-500/25 bg-green-500/[0.03]';
  const statusIcon = runningCount > 0 ? 'progress_activity' : failCount > 0 ? 'warning' : 'check_circle';
  const statusColor = runningCount > 0 ? 'text-cyan-500' : failCount > 0 ? 'text-amber-500' : 'text-green-500';

  return (
    <div className="group flex gap-2 py-1 px-3">
      {author && <MemberAvatar member={author} size="xs" />}
      <div className={`flex-1 min-w-0 rounded-lg border ${accent} overflow-hidden`}>
        {/* 头部：整行可点 */}
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-start hover:bg-surface-sunken/40 transition-colors"
          aria-expanded={expanded}
        >
          <span className={`material-symbols-outlined text-[15px] shrink-0 ${statusColor} ${runningCount > 0 ? 'animate-spin' : ''}`}>{statusIcon}</span>
          <span className="text-[11.5px] font-semibold text-text shrink-0">
            {author?.name || '工具运行'} · {messages.length} 个工具
          </span>
          <span className="text-[10.5px] text-text-muted shrink-0">
            {okCount > 0 && <span className="text-green-600 dark:text-green-400">{okCount} 成功</span>}
            {okCount > 0 && (failCount > 0 || runningCount > 0) && ' · '}
            {failCount > 0 && <span className="text-red-600 dark:text-red-400">{failCount} 失败</span>}
            {failCount > 0 && runningCount > 0 && ' · '}
            {runningCount > 0 && <span className="text-cyan-600 dark:text-cyan-400 animate-pulse">{runningCount} 运行中</span>}
          </span>
          <span className="text-[10px] text-text-muted opacity-50 font-mono shrink-0">
            {formatTime(firstTs)}{durationSec > 0 ? ` · ${durationSec}s` : ''}
          </span>
          {/* 折叠态预览：最近一次工具 + 首行 */}
          {!expanded && (
            <span className="flex-1 min-w-0 truncate text-[11px] text-text-secondary font-mono">
              <span className="text-text-muted">最近 </span>
              <span className="text-text">{lastName}</span>
              {lastPreview && <span className="text-text-muted"> · {lastPreview}</span>}
            </span>
          )}
          {pendingApproval && !expanded && (
            <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 animate-pulse">
              待审批
            </span>
          )}
          <span className={`material-symbols-outlined text-[16px] text-text-muted shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}>expand_more</span>
        </button>

        {/* 展开态：内嵌每条工具的完整折叠卡（复用 MessageBubble 的 tool 分支） */}
        {expanded && (
          <div className="border-t border-border/60 py-0.5 bg-surface/40">
            {messages.map(m => (
              <div key={m.id} data-message-id={m.id} className="msg-jump-target">
                <MessageBubble
                  message={m}
                  author={author}
                  members={members}
                  onApproveTool={() => onApproveTool?.(m.id)}
                  onRejectTool={() => onRejectTool?.(m.id)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ── MemoMessageRow ──
// 每条消息的包装行：解析 author/actingActor/referencedMessage 后委托 MessageBubble。
// 回调通过 id-dispatch 模式传入（稳定引用），避免内联箭头击穿 React.memo。
interface MemoMessageRowProps {
  msg: Message;
  members: Map<string, Member>;
  meId: string;
  msgById: Map<string, Message>;
  systemModels?: SystemModel[];
  onEdit: (id: string, c: string) => void;
  onDelete: (id: string) => void;
  onFork: (id: string) => void;
  onReact: (id: string, e: string) => void;
  onReply: (id: string) => void;
  onWhisper: (id: string) => void;
  onApproveTool: (id: string) => void;
  onRejectTool: (id: string) => void;
  onPromoteDecision: (id: string, s?: string) => void;
  onDemoteDecision: (id: string) => void;
  onRerun: (id: string, m?: string) => void;
}

const MemoMessageRow = React.memo<MemoMessageRowProps>(({
  msg, members, meId, msgById, systemModels,
  onEdit, onDelete, onFork, onReact, onReply, onWhisper,
  onApproveTool, onRejectTool, onPromoteDecision, onDemoteDecision, onRerun,
}) => {
  const realAuthorId = msg.actingAsId || msg.authorId;
  // v1.0：兼容旧数据中 authorId="human:nudge" 的虚拟作者——
  // 找不到时 fallback 到房间里第一个人类成员，避免显示 "Unknown"。
  let author = members.get(realAuthorId);
  if (!author && realAuthorId === 'human:nudge') {
    for (const m of members.values()) {
      if (m.kind === 'human' && !m.isKicked) { author = m; break; }
    }
  }
  const actingActor = msg.actingAsId ? members.get(msg.authorId) : undefined;
  const ref = msg.referenceMessageId ? msgById.get(msg.referenceMessageId) : undefined;
  return (
    <div data-message-id={msg.id} className="msg-jump-target">
      <MessageBubble
        message={msg}
        author={author}
        actingActor={actingActor}
        members={members}
        isMe={msg.authorId === meId}
        referencedMessage={ref}
        onEdit={(c) => onEdit(msg.id, c)}
        onDelete={() => onDelete(msg.id)}
        onFork={() => onFork(msg.id)}
        onReact={(e) => onReact(msg.id, e)}
        onReply={() => onReply(msg.id)}
        onWhisper={() => author && onWhisper(author.id)}
        onApproveTool={() => onApproveTool(msg.id)}
        onRejectTool={() => onRejectTool(msg.id)}
        onPromoteDecision={(s) => onPromoteDecision(msg.id, s)}
        onDemoteDecision={() => onDemoteDecision(msg.id)}
        onRerun={(model) => onRerun(msg.id, model)}
        systemModels={systemModels}
      />
    </div>
  );
}, (prev, next) => {
  // 只在消息对象或关键 lookup 变更时重渲染
  if (prev.msg !== next.msg) return false;
  if (prev.members !== next.members) return false;
  if (prev.meId !== next.meId) return false;
  if (prev.systemModels !== next.systemModels) return false;
  // msgById 变更只在引用消息改变时才影响本行
  if (prev.msg.referenceMessageId) {
    const prevRef = prev.msgById.get(prev.msg.referenceMessageId);
    const nextRef = next.msgById.get(next.msg.referenceMessageId!);
    if (prevRef !== nextRef) return false;
  }
  return true;
});

interface Props {
  messages: Message[];
  members: Map<string, Member>;
  meId: string;
  onEdit?: (messageId: string, newContent: string) => void;
  onDelete?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  onReact?: (messageId: string, emoji: string) => void;
  onReply?: (messageId: string) => void;
  onWhisper?: (memberId: string) => void;
  onApproveTool?: (messageId: string) => void;
  onRejectTool?: (messageId: string) => void;
  thinkingMemberIds?: string[];
  onForceNext?: (memberId: string) => void;
  /** 时间旅行目标：置为非空时滚动到该消息并高亮 2.5s，然后自动清除 */
  highlightMessageId?: string | null;
  onHighlightConsumed?: () => void;
  // v0.6
  onPromoteDecision?: (messageId: string, summary?: string) => void;
  onDemoteDecision?: (messageId: string) => void;
  /**
   * 换模型重跑：model 为空走后端默认（成员当前绑定模型）；非空则用指定模型单次覆盖。
   * UI 侧会在菜单里弹"选择模型"小窗让用户显式确认后再调用，避免误点一键重跑。
   */
  onRerun?: (messageId: string, model?: string) => void;
  /** 供 MessageBubble 的"换模型重跑"弹窗构建模型下拉。缺省时只给原模型选项。 */
  systemModels?: SystemModel[];
}

const MessageStream: React.FC<Props> = ({
  messages, members, meId, thinkingMemberIds = [],
  onEdit, onDelete, onFork, onReact, onReply, onWhisper, onApproveTool, onRejectTool,
  highlightMessageId, onHighlightConsumed,
  onPromoteDecision, onDemoteDecision, onRerun, systemModels,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const initialScrollDone = useRef(false);

  // 虚拟滚动阈值：少于此数量时用原生渲染，避免小房间多余开销
  const VIRTUALIZE_THRESHOLD = 50;

  const msgById = useMemo(() => new Map(messages.map(m => [m.id, m])), [messages]);

  // 稳定回调：避免内联箭头函数每次渲染创建新引用击穿 React.memo
  const handleEdit     = useCallback((id: string, c: string) => onEdit?.(id, c), [onEdit]);
  const handleDelete   = useCallback((id: string) => onDelete?.(id), [onDelete]);
  const handleFork     = useCallback((id: string) => onFork?.(id), [onFork]);
  const handleReact    = useCallback((id: string, e: string) => onReact?.(id, e), [onReact]);
  const handleReply    = useCallback((id: string) => onReply?.(id), [onReply]);
  const handleWhisper  = useCallback((id: string) => onWhisper?.(id), [onWhisper]);
  const handleApprove  = useCallback((id: string) => onApproveTool?.(id), [onApproveTool]);
  const handleReject   = useCallback((id: string) => onRejectTool?.(id), [onRejectTool]);
  const handlePromote  = useCallback((id: string, s?: string) => onPromoteDecision?.(id, s), [onPromoteDecision]);
  const handleDemote   = useCallback((id: string) => onDemoteDecision?.(id), [onDemoteDecision]);
  const handleRerun    = useCallback((id: string, m?: string) => onRerun?.(id, m), [onRerun]);

  // v0.9：连续的 tool / tool_approval 消息（同一作者）聚合到 ToolRunGroup 单卡片里，
  // 避免 exec/write/process 一次调 5+ 个工具时中间窗被"5 个红框"填满。
  // 跨作者不合并；被非 tool 消息打断就开新组。
  const renderItems = useMemo<RenderItem[]>(() => {
    const out: RenderItem[] = [];
    const filtered = messages.filter(m => !m.deleted || m.kind !== 'chat');
    let i = 0;
    while (i < filtered.length) {
      const m = filtered[i];
      const isTool = m.kind === 'tool' || m.kind === 'tool_approval';
      if (!isTool) {
        out.push({ kind: 'message', message: m });
        i++;
        continue;
      }
      const runAuthor = m.actingAsId || m.authorId;
      const group: Message[] = [];
      let j = i;
      while (j < filtered.length) {
        const n = filtered[j];
        const nIsTool = n.kind === 'tool' || n.kind === 'tool_approval';
        if (!nIsTool) break;
        if ((n.actingAsId || n.authorId) !== runAuthor) break;
        group.push(n);
        j++;
      }
      if (group.length === 1) {
        out.push({ kind: 'message', message: group[0] });
      } else {
        out.push({ kind: 'tool-group', key: `tg-${group[0].id}`, authorId: runAuthor, messages: group });
      }
      i = j;
    }
    return out;
  }, [messages]);

  const useVirtual = renderItems.length > VIRTUALIZE_THRESHOLD;

  // ── 虚拟滚动器 ──
  const virtualizer = useVirtualizer({
    count: renderItems.length + (thinkingMemberIds.length > 0 ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 60,
    overscan: 8,
    enabled: useVirtual,
  });

  // 首次挂载滚到底（进入房间时消息流默认显示最新消息）
  useLayoutEffect(() => {
    if (initialScrollDone.current || renderItems.length === 0) return;
    initialScrollDone.current = true;
    if (useVirtual) {
      virtualizer.scrollToIndex(renderItems.length - 1, { align: 'end', behavior: 'auto' });
    } else {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  });

  // 自动滚到底（仅当用户在底部时）
  const prevCountRef = useRef(renderItems.length);
  useLayoutEffect(() => {
    if (renderItems.length <= prevCountRef.current) {
      prevCountRef.current = renderItems.length;
      return;
    }
    prevCountRef.current = renderItems.length;
    if (!atBottomRef.current) return;
    if (useVirtual) {
      virtualizer.scrollToIndex(renderItems.length - 1, { align: 'end', behavior: 'auto' });
    } else {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [renderItems.length, useVirtual, virtualizer]);

  // 时间旅行：滚动到目标消息 + 高亮
  useEffect(() => {
    if (!highlightMessageId) return;
    atBottomRef.current = false;

    if (useVirtual) {
      // 查找目标在 renderItems 中的索引
      const idx = renderItems.findIndex(item => {
        if (item.kind === 'message') return item.message.id === highlightMessageId;
        if (item.kind === 'tool-group') return item.messages.some(m => m.id === highlightMessageId);
        return false;
      });
      if (idx >= 0) {
        virtualizer.scrollToIndex(idx, { align: 'center', behavior: 'smooth' });
      }
    }

    // 高亮目标 DOM 节点（虚拟滚动情况下，scrollToIndex 后 DOM 才挂载，延迟查找）
    const tryHighlight = () => {
      const el = scrollRef.current;
      if (!el) return false;
      const target = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(highlightMessageId)}"]`);
      if (!target) return false;
      if (!useVirtual) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.add('msg-jump-highlight');
      return true;
    };

    // 立即尝试一次，失败后延迟重试（等虚拟 DOM 挂载）
    if (!tryHighlight()) {
      requestAnimationFrame(() => tryHighlight());
    }

    const timer = window.setTimeout(() => {
      const el = scrollRef.current;
      const target = el?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(highlightMessageId)}"]`);
      target?.classList.remove('msg-jump-highlight');
      onHighlightConsumed?.();
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [highlightMessageId, onHighlightConsumed, useVirtual, renderItems, virtualizer]);

  const scrollToBottom = useCallback(() => {
    if (useVirtual) {
      virtualizer.scrollToIndex(renderItems.length - 1, { align: 'end', behavior: 'smooth' });
    } else {
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
    atBottomRef.current = true;
    setShowScrollBtn(false);
  }, [useVirtual, virtualizer, renderItems.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const isBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = isBottom;
    setShowScrollBtn(!isBottom);
  };

  // ── 渲染单个 RenderItem ──
  const renderOneItem = (item: RenderItem) => {
    if (item.kind === 'tool-group') {
      return (
        <ToolRunGroup
          key={item.key}
          messages={item.messages}
          author={members.get(item.authorId)}
          members={members}
          onApproveTool={onApproveTool}
          onRejectTool={onRejectTool}
        />
      );
    }
    const msg = item.message;
    return (
      <MemoMessageRow
        key={msg.id}
        msg={msg}
        members={members}
        meId={meId}
        msgById={msgById}
        systemModels={systemModels}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onFork={handleFork}
        onReact={handleReact}
        onReply={handleReply}
        onWhisper={handleWhisper}
        onApproveTool={handleApprove}
        onRejectTool={handleReject}
        onPromoteDecision={handlePromote}
        onDemoteDecision={handleDemote}
        onRerun={handleRerun}
      />
    );
  };

  const thinkingRow = thinkingMemberIds.length > 0 ? (
    <div className="px-4 py-2 flex items-center gap-2 text-[11px] text-text-secondary">
      <span className="material-symbols-outlined text-[14px] text-cyan-500 animate-pulse">bubble_chart</span>
      <span>
        {thinkingMemberIds.map(id => members.get(id)?.name).filter(Boolean).join('、')} 正在思考...
      </span>
    </div>
  ) : null;

  // ── 空房间 ──
  if (messages.length === 0) {
    return (
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto neon-scrollbar py-1">
        <div className="h-full min-h-[280px] flex items-center justify-center text-center px-6">
          <div className="max-w-md">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500/10 via-blue-500/10 to-purple-500/10 border border-cyan-400/20 flex items-center justify-center mb-4">
              <span className="material-symbols-outlined text-[32px] text-cyan-500">forum</span>
            </div>
            <h3 className="text-base font-bold text-text mb-1.5">房间已就位</h3>
            <p className="text-[12px] text-text-secondary leading-relaxed">
              所有成员已到齐。发送第一条消息开始讨论，或在下方切换发言策略。
            </p>
          </div>
        </div>
        {thinkingRow}
      </div>
    );
  }

  const scrollBtnEl = showScrollBtn ? (
    <button
      onClick={scrollToBottom}
      className="absolute bottom-3 start-1/2 -translate-x-1/2 z-10 w-8 h-8 rounded-full bg-surface-overlay border border-border shadow-md backdrop-blur-sm flex items-center justify-center text-text-secondary hover:text-text hover:bg-surface-raised transition-all animate-fade-in"
      title="滚动到底部"
      aria-label="滚动到底部"
    >
      <span className="material-symbols-outlined text-[18px]">keyboard_arrow_down</span>
    </button>
  ) : null;

  // ── 虚拟滚动渲染 ──
  if (useVirtual) {
    return (
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-y-auto neon-scrollbar py-1"
        >
          <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {virtualizer.getVirtualItems().map(vItem => {
              const isThinkingRow = vItem.index === renderItems.length;
              return (
                <div
                  key={isThinkingRow ? '__thinking' : vItem.index}
                  data-index={vItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  {isThinkingRow ? thinkingRow : renderOneItem(renderItems[vItem.index])}
                </div>
              );
            })}
          </div>
        </div>
        {scrollBtnEl}
      </div>
    );
  }

  // ── 原生滚动渲染（<50 条消息）──
  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto neon-scrollbar py-1"
      >
        {renderItems.map(renderOneItem)}
        {thinkingRow}
      </div>
      {scrollBtnEl}
    </div>
  );
};

export default MessageStream;
