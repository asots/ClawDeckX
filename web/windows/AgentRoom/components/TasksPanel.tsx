// 右栏·任务清单
import React, { useState } from 'react';
import type { Member, RoomTask } from '../types';
import { MemberAvatar } from '../shared';
import CustomSelect from '../../../components/CustomSelect';

interface Props {
  tasks: RoomTask[];
  members: Map<string, Member>;
  meId: string;
  onAdd: (text: string, assigneeId?: string) => void;
  onToggle: (taskId: string) => void;
  onDelete: (taskId: string) => void;
}

const TasksPanel: React.FC<Props> = ({ tasks, members, meId, onAdd, onToggle, onDelete }) => {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);

  const save = () => {
    if (!draft.trim()) return;
    onAdd(draft.trim(), assignee || undefined);
    setDraft('');
    setAssignee(null);
    setAdding(false);
  };

  const active = tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled');
  const done = tasks.filter(t => t.status === 'done');

  return (
    <div className="space-y-1">
      {active.map(t => {
        const assigneeM = t.assigneeId ? members.get(t.assigneeId) : undefined;
        return (
          <div key={t.id} className="group flex items-start gap-2 p-1.5 rounded-md hover:bg-surface-sunken transition-colors">
            <button
              onClick={() => onToggle(t.id)}
              className="mt-0.5 w-4 h-4 rounded border-2 border-border hover:border-cyan-500 flex items-center justify-center transition-colors shrink-0"
              title="标记完成"
            >
              {t.status === 'doing' && <span className="material-symbols-outlined text-[12px] text-amber-500">hourglass_top</span>}
            </button>
            <div className="flex-1 min-w-0">
              <div className="text-[11.5px] text-text leading-snug break-words">{t.text}</div>
              <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-text-muted">
                {assigneeM && (
                  <span className="inline-flex items-center gap-0.5 font-semibold text-cyan-600 dark:text-cyan-400">
                    <span className="text-[11px]">{assigneeM.emoji || '·'}</span>
                    @{assigneeM.name}
                  </span>
                )}
                {t.dueAt && (
                  <span className="font-mono">截止 {formatDueTime(t.dueAt)}</span>
                )}
              </div>
            </div>
            {(t.creatorId === meId || t.assigneeId === meId) && (
              <button
                onClick={() => onDelete(t.id)}
                className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-red-500 shrink-0"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            )}
          </div>
        );
      })}

      {done.length > 0 && (
        <div className="pt-1 mt-1 border-t border-border">
          {done.map(t => (
            <div key={t.id} className="flex items-center gap-2 p-1 opacity-60">
              <span className="w-4 h-4 rounded bg-cyan-500/20 text-cyan-500 flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-[11px]">check</span>
              </span>
              <span className="flex-1 min-w-0 text-[11px] text-text-muted line-through truncate">{t.text}</span>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="p-2 rounded-lg bg-surface-raised border border-cyan-500/30">
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setAdding(false); }}
            placeholder="任务内容..."
            className="w-full mb-1.5 px-1.5 py-1 rounded bg-surface border border-border sci-input text-[11.5px]"
            autoFocus
          />
          <div className="flex items-center gap-1 mb-1.5">
            <label className="text-[10px] text-text-muted shrink-0">指派</label>
            <div className="flex-1 min-w-0">
              <CustomSelect
                value={assignee || ''}
                onChange={(v) => setAssignee(v || null)}
                options={[
                  { value: '', label: '（不指派）' },
                  ...Array.from(members.values()).filter(m => !m.isKicked).map(m => ({ value: m.id, label: m.name })),
                ]}
                className="h-6 px-1 rounded bg-surface border border-border text-[11px]"
              />
            </div>
          </div>
          <div className="flex gap-1">
            <button onClick={save} className="flex-1 h-6 rounded-md text-[10px] font-bold bg-primary text-white hover:bg-primary/90">添加</button>
            <button onClick={() => setAdding(false)} className="flex-1 h-6 rounded-md text-[10px] font-semibold bg-surface hover:bg-surface-sunken border border-border">取消</button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="w-full mt-1 h-7 px-3 rounded-md text-[11.5px] font-semibold border border-dashed border-border text-text-muted hover:border-cyan-500/40 hover:text-cyan-500 hover:bg-cyan-500/5 transition inline-flex items-center justify-center gap-1"
        >
          <span className="material-symbols-outlined text-[14px]">add</span>
          添加任务
        </button>
      )}
    </div>
  );
};

function formatDueTime(ts: number): string {
  const diff = ts - Date.now();
  if (diff < 0) return '已逾期';
  if (diff < 3_600_000) return `${Math.ceil(diff / 60_000)} 分钟后`;
  if (diff < 86_400_000) return `${Math.ceil(diff / 3_600_000)} 小时后`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default TasksPanel;
