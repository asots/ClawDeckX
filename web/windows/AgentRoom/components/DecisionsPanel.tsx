// DecisionsPanel —— 房间级决策流
//
// 列表 is_decision=true 的消息，按 seq 升序；展示一行摘要 + 作者 + 跳转到消息；支持撤销。
// v0.6 引入的"决策锚"是为了解决"讨论几百条后 我们到底定了啥" 的痛点。
//
// 数据源：initial = listDecisions(roomId) 拉一次；后续 message.update 事件若 patch.isDecision 变更则增量更新。

import React, { useEffect, useMemo, useState } from 'react';
import type { Member, Message } from '../types';
import { listDecisions, demoteDecision, roomEvents } from '../service';

interface Props {
  roomId: string;
  members: Map<string, Member>;
  onJump?: (messageId: string) => void;
}

const DecisionsPanel: React.FC<Props> = ({ roomId, members, onJump }) => {
  const [items, setItems] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = React.useCallback(() => {
    setLoading(true);
    listDecisions(roomId).then(setItems).finally(() => setLoading(false));
  }, [roomId]);

  useEffect(() => { refetch(); }, [refetch]);

  // 监听 message.update 里 isDecision 变更（后端 promote / demote 都会广播）。
  useEffect(() => {
    const off = roomEvents.on('message.update', ev => {
      if (ev.roomId !== roomId) return;
      const p: any = ev.patch;
      if (p && Object.prototype.hasOwnProperty.call(p, 'isDecision')) {
        refetch();
      }
    });
    return () => { if (off) off(); };
  }, [roomId, refetch]);

  const authorName = (m: Message) => {
    if (!m.authorId) return 'system';
    const mb = members.get(m.authorId);
    return mb ? mb.name : m.authorId;
  };

  const sorted = useMemo(() => [...items].sort((a, b) => a.timestamp - b.timestamp), [items]);

  const handleDemote = async (id: string) => {
    await demoteDecision(id);
    setItems(prev => prev.filter(m => m.id !== id));
  };

  if (loading) return <div className="text-[11px] text-text-muted">加载中…</div>;

  if (sorted.length === 0) {
    return (
      <div className="px-2 py-3 text-[11px] text-text-muted text-center border border-dashed border-border rounded-md leading-relaxed">
        还没有决策被锚定。选中任意消息 → 右键「推为决策」，会在这里留档。
      </div>
    );
  }

  return (
    <ol className="space-y-1.5">
      {sorted.map((m, i) => (
        <li
          key={m.id}
          className="group flex items-start gap-2 px-2 py-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10 transition"
        >
          <span className="w-5 h-5 rounded-full bg-emerald-500/30 flex items-center justify-center text-[10px] font-mono shrink-0">
            {i + 1}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[12px] text-text line-clamp-2 leading-snug">
              {m.decisionSummary?.trim() || m.content?.slice(0, 200)}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted">
              <span>{authorName(m)}</span>
              <span>·</span>
              <span className="font-mono">{new Date(m.timestamp).toLocaleString()}</span>
            </div>
          </div>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition shrink-0">
            {onJump && (
              <button
                type="button"
                onClick={() => onJump(m.id)}
                className="w-6 h-6 rounded hover:bg-surface-sunken flex items-center justify-center text-text-muted hover:text-text"
                title="跳转到此消息"
              >
                <span className="material-symbols-outlined text-[14px]">arrow_outward</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => handleDemote(m.id)}
              className="w-6 h-6 rounded hover:bg-danger/10 flex items-center justify-center text-text-muted hover:text-danger"
              title="撤销决策"
            >
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          </div>
        </li>
      ))}
    </ol>
  );
};

export default DecisionsPanel;
