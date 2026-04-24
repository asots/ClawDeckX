// PlanningPanel —— planned 策略专属：展示当前阶段 + 执行队列 + 编辑/启动/继续讨论按钮
//
// 只在 room.policy === 'planned' 时渲染。
// 队列编辑：拖拽排序 + 点击移除；保存后调用 setExecutionQueue。
// 阶段切换：discussion → executing（startExecution） / review → discussion（continueDiscussion）。

import React, { useEffect, useMemo, useState } from 'react';
import type { Room, Member } from '../types';
import { setExecutionQueue, startExecution, continueDiscussion } from '../service';

interface Props {
  room: Room;
  members: Member[];
  meId: string;
}

const PHASE_META = {
  discussion: { label: '讨论', icon: 'forum', tone: 'text-violet-500' },
  executing:  { label: '执行中', icon: 'play_circle', tone: 'text-emerald-500' },
  review:     { label: '待 Review', icon: 'rate_review', tone: 'text-amber-500' },
} as const;

const PlanningPanel: React.FC<Props> = ({ room, members, meId }) => {
  const phase = (room.executionPhase ?? 'discussion') as keyof typeof PHASE_META;
  const meta = PHASE_META[phase];
  const queue = useMemo(() => room.executionQueue ?? [], [room.executionQueue]);
  const ownerIdx = room.executionOwnerIdx ?? 0;
  const agents = useMemo(
    () => members.filter(m => m.kind === 'agent' && !m.isKicked),
    [members],
  );
  const memberMap = useMemo(() => {
    const map: Record<string, Member> = {};
    for (const m of members) map[m.id] = m;
    return map;
  }, [members]);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(queue);
  useEffect(() => { if (!editing) setDraft(queue); }, [queue, editing]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const available = agents.filter(a => !draft.includes(a.id));

  const handleSave = async () => {
    if (draft.length === 0) { alert('队列不能为空'); return; }
    await setExecutionQueue(room.id, draft);
    setEditing(false);
  };

  const handleStart = async () => {
    if (queue.length === 0) { setEditing(true); return; }
    await startExecution(room.id).catch(() => { /* toast via service */ });
  };

  const handleBackToDiscussion = async () => {
    await continueDiscussion(room.id).catch(() => { /* toast via service */ });
  };

  return (
    <div className="space-y-3 text-[12px]">
      {/* 阶段徽章 + 操作 */}
      <div className="flex items-center justify-between">
        <div className={`inline-flex items-center gap-1.5 px-2 h-6 rounded-md bg-surface-sunken border border-border ${meta.tone}`}>
          <span className="material-symbols-outlined text-[14px]">{meta.icon}</span>
          <span className="font-semibold">{meta.label}</span>
        </div>
        <div className="flex items-center gap-1">
          {phase === 'discussion' && (
            <button
              type="button"
              onClick={handleStart}
              className="inline-flex items-center gap-1 px-2 h-6 rounded-md text-[11px] font-semibold bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30"
              title="按队列开始执行"
            >
              <span className="material-symbols-outlined text-[13px]">play_arrow</span>
              开始执行
            </button>
          )}
          {phase === 'review' && (
            <button
              type="button"
              onClick={handleBackToDiscussion}
              className="inline-flex items-center gap-1 px-2 h-6 rounded-md text-[11px] font-semibold bg-violet-500/10 hover:bg-violet-500/20 text-violet-600 dark:text-violet-400 border border-violet-500/30"
              title="回到讨论阶段"
            >
              <span className="material-symbols-outlined text-[13px]">arrow_back</span>
              继续讨论
            </button>
          )}
        </div>
      </div>

      {/* 当前 owner（executing 阶段） */}
      {phase === 'executing' && queue.length > 0 && (
        <div className="px-2 py-1.5 rounded-md bg-emerald-500/5 border border-emerald-500/20">
          <div className="text-[10px] text-text-muted">当前 owner · {ownerIdx + 1} / {queue.length}</div>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center text-[10px]">
              {memberMap[queue[ownerIdx]]?.emoji || '🤖'}
            </span>
            <span className="font-semibold text-text">{memberMap[queue[ownerIdx]]?.name ?? queue[ownerIdx]}</span>
          </div>
        </div>
      )}

      {/* 队列展示 / 编辑 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold">执行队列</div>
          {phase !== 'executing' && (
            editing ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => { setEditing(false); setDraft(queue); }}
                  className="px-1.5 h-5 rounded text-[10px] hover:bg-surface-sunken text-text-muted"
                >取消</button>
                <button
                  type="button"
                  onClick={handleSave}
                  className="px-1.5 h-5 rounded text-[10px] font-semibold bg-primary/10 text-primary hover:bg-primary/20 border border-primary/30"
                >保存</button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="px-1.5 h-5 rounded text-[10px] hover:bg-surface-sunken text-text-secondary inline-flex items-center gap-0.5"
              >
                <span className="material-symbols-outlined text-[12px]">edit</span>
                编辑
              </button>
            )
          )}
        </div>

        {(editing ? draft : queue).length === 0 && !editing && (
          <div className="px-2 py-3 rounded-md bg-surface-sunken/50 border border-border border-dashed text-center text-text-muted text-[11px]">
            还没有队列。点"编辑"把 agent 拖进来，讨论清楚后再"开始执行"。
          </div>
        )}

        <ol className="space-y-1">
          {(editing ? draft : queue).map((id, i) => {
            const m = memberMap[id];
            const isCurrent = phase === 'executing' && i === ownerIdx;
            const done = phase === 'executing' && i < ownerIdx;
            return (
              <li
                key={`${id}-${i}`}
                draggable={editing}
                onDragStart={() => setDragIdx(i)}
                onDragOver={e => { if (editing) e.preventDefault(); }}
                onDrop={() => {
                  if (!editing || dragIdx === null || dragIdx === i) return;
                  const next = [...draft];
                  const [it] = next.splice(dragIdx, 1);
                  next.splice(i, 0, it);
                  setDraft(next);
                  setDragIdx(null);
                }}
                className={`flex items-center gap-1.5 px-2 h-8 rounded-md border text-[12px] ${
                  isCurrent ? 'bg-emerald-500/10 border-emerald-500/40' :
                  done      ? 'bg-surface-sunken/60 border-border opacity-60' :
                              'bg-surface-raised border-border'
                } ${editing ? 'cursor-grab active:cursor-grabbing' : ''}`}
              >
                <span className="w-4 h-4 rounded-full bg-surface-sunken flex items-center justify-center text-[10px] text-text-muted font-mono shrink-0">
                  {i + 1}
                </span>
                <span className="text-[13px]">{m?.emoji ?? '🤖'}</span>
                <span className="flex-1 truncate text-text">{m?.name ?? id}</span>
                {done && <span className="material-symbols-outlined text-[14px] text-emerald-500">check</span>}
                {isCurrent && <span className="material-symbols-outlined text-[14px] text-emerald-500 animate-pulse">play_arrow</span>}
                {editing && (
                  <button
                    type="button"
                    onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                    className="w-5 h-5 rounded hover:bg-danger/10 text-text-muted hover:text-danger flex items-center justify-center"
                    title="移除"
                  >
                    <span className="material-symbols-outlined text-[14px]">close</span>
                  </button>
                )}
              </li>
            );
          })}
        </ol>

        {editing && available.length > 0 && (
          <div className="mt-2">
            <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1">可添加</div>
            <div className="flex flex-wrap gap-1">
              {available.map(a => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setDraft([...draft, a.id])}
                  className="inline-flex items-center gap-1 px-2 h-6 rounded-md text-[11px] bg-surface-raised hover:bg-surface-sunken border border-border text-text"
                >
                  <span>{a.emoji ?? '🤖'}</span>
                  <span className="truncate max-w-[100px]">{a.name}</span>
                  <span className="material-symbols-outlined text-[12px] text-primary">add</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {meId && (
        <div className="text-[10px] text-text-muted leading-relaxed">
          提示：执行阶段 agent 发言末尾 <code className="px-1 rounded bg-surface-sunken">@下一位</code> 会自动交棒；最后一位发言后进入 review，等你拍板。
        </div>
      )}
    </div>
  );
};

export default PlanningPanel;
