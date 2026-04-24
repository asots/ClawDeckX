// AgendaRail —— v0.7 议程面板
//
// 真实会议的骨架。一个房间可以有多个议项，按序推进。每项独立有：
//   - 目标 / 预期产出 / 分配成员 / 轮次预算 / 小结
// 状态机：pending → active → done/parked/skipped
//
// 交互：
//   - 编辑器：+ 添加议项 / 逐项编辑
//   - 推进按钮：关闭当前 active（自动生成小结），激活下一个 pending
//   - 挂起按钮：把议项标为 parked
//
// 视觉：当前 active 项有 cyan glow；done 项用勾 + 灰字；parked 用暂停图标。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgendaItem, Member } from '../types';
import {
  listAgenda, createAgendaItem, updateAgendaItem, deleteAgendaItem,
  parkAgendaItem, advanceAgenda, reorderAgenda, roomEvents,
} from '../service';
import NumberStepper from '../../../components/NumberStepper';

interface Props {
  roomId: string;
  members: Map<string, Member>;
  onChange?: (items: AgendaItem[]) => void;
  readonly?: boolean;
}

const STATUS_META: Record<AgendaItem['status'], { icon: string; label: string; tone: string }> = {
  pending: { icon: 'radio_button_unchecked', label: '待开始', tone: 'text-text-muted border-border' },
  active:  { icon: 'play_circle',             label: '进行中', tone: 'text-cyan-600 dark:text-cyan-300 border-cyan-500/50 bg-cyan-500/5' },
  done:    { icon: 'check_circle',            label: '已完成', tone: 'text-emerald-600 dark:text-emerald-300 border-emerald-500/30' },
  parked:  { icon: 'pause_circle',            label: '已挂起', tone: 'text-amber-600 dark:text-amber-300 border-amber-500/30' },
  skipped: { icon: 'skip_next',               label: '已跳过', tone: 'text-text-muted border-border opacity-60' },
};

const AgendaRail: React.FC<Props> = ({ roomId, members, onChange, readonly }) => {
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null); // item id
  const [creating, setCreating] = useState(false);
  const [advancing, setAdvancing] = useState(false);

  // initial fetch
  useEffect(() => {
    setLoading(true);
    listAgenda(roomId).then(setItems).finally(() => setLoading(false));
  }, [roomId]);

  // 把 items 同步到 parent（供 VotePanel 等其它面板取 active item）
  useEffect(() => { if (onChange) onChange(items); }, [items, onChange]);

  // WS 事件
  useEffect(() => {
    const off1 = roomEvents.on('room.agenda.append' as any, (ev: any) => {
      if (ev?.roomId === roomId && ev.item) {
        setItems(prev => prev.some(x => x.id === ev.item.id) ? prev : [...prev, ev.item]
          .sort((a, b) => a.seq - b.seq));
      }
    });
    const off2 = roomEvents.on('room.agenda.update' as any, (ev: any) => {
      if (ev?.roomId === roomId && ev.patch) {
        setItems(prev => prev.map(x => x.id === ev.itemId ? { ...x, ...ev.patch } : x));
      }
    });
    const off3 = roomEvents.on('room.agenda.delete' as any, (ev: any) => {
      if (ev?.roomId === roomId) setItems(prev => prev.filter(x => x.id !== ev.itemId));
    });
    const off4 = roomEvents.on('room.agenda.reorder' as any, (ev: any) => {
      if (ev?.roomId === roomId && Array.isArray(ev.orderedIds)) {
        setItems(prev => {
          const byId = new Map(prev.map(x => [x.id, x]));
          return (ev.orderedIds as string[])
            .map((id, i) => { const it = byId.get(id); return it ? { ...it, seq: i + 1 } : null; })
            .filter(Boolean) as AgendaItem[];
        });
      }
    });
    return () => { off1?.(); off2?.(); off3?.(); off4?.(); };
  }, [roomId]);

  const sorted = useMemo(() => [...items].sort((a, b) => a.seq - b.seq), [items]);
  const activeIdx = sorted.findIndex(x => x.status === 'active');
  const doneCount = sorted.filter(x => x.status === 'done').length;

  const advance = async () => {
    if (advancing) return;
    setAdvancing(true);
    try {
      await advanceAgenda(roomId);
      const fresh = await listAgenda(roomId);
      setItems(fresh);
    } finally { setAdvancing(false); }
  };

  const park = async (id: string) => {
    try {
      await parkAgendaItem(id);
      setItems(prev => prev.map(x => x.id === id ? { ...x, status: 'parked' } : x));
    } catch { /* WS 兜底 */ }
  };

  const remove = async (id: string) => {
    if (!confirm('删除该议项？')) return;
    setItems(prev => prev.filter(x => x.id !== id));
    try { await deleteAgendaItem(id); } catch { /* WS 兜底 */ }
  };

  const moveSeq = useCallback(async (id: string, dir: -1 | 1) => {
    setItems(prev => {
      const ix = prev.findIndex(x => x.id === id);
      if (ix < 0) return prev;
      const jx = ix + dir;
      if (jx < 0 || jx >= prev.length) return prev;
      const next = [...prev];
      const tmp = next[ix];
      next[ix] = next[jx];
      next[jx] = tmp;
      const ordered = next.map((x, i) => ({ ...x, seq: i + 1 }));
      reorderAgenda(roomId, ordered.map(x => x.id)).catch(() => {});
      return ordered;
    });
  }, [roomId]);

  return (
    <div className="flex flex-col gap-2">
      {/* header */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10.5px] text-text-muted font-mono">
          {sorted.length === 0 ? '暂无议程' : `${doneCount}/${sorted.length} 已完成${activeIdx >= 0 ? ` · 当前 ${activeIdx + 1}` : ''}`}
        </div>
        {!readonly && (
          <div className="flex items-center gap-1">
            {sorted.length > 0 && (
              <button type="button" onClick={advance} disabled={advancing}
                className="h-7 px-2.5 rounded-md text-[11.5px] font-semibold border border-cyan-500/40 text-cyan-700 dark:text-cyan-200 hover:bg-cyan-500/10 transition disabled:opacity-50 inline-flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">skip_next</span>
                {advancing ? '推进中…' : activeIdx < 0 ? '开始议程' : '下一项'}
              </button>
            )}
            <button type="button" onClick={() => setCreating(true)}
              className="h-7 px-2.5 rounded-md text-[11.5px] font-semibold bg-cyan-500 hover:bg-cyan-600 text-white transition inline-flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">add</span>
              议项
            </button>
          </div>
        )}
      </div>

      {/* 新建表单 */}
      {creating && (
        <AgendaItemForm
          mode="create"
          members={members}
          onCancel={() => setCreating(false)}
          onSave={async input => {
            try {
              const it = await createAgendaItem(roomId, input);
              setItems(prev => prev.some(x => x.id === it.id) ? prev : [...prev, it].sort((a, b) => a.seq - b.seq));
              setCreating(false);
            } catch { /* withToast 已 toast */ }
          }}
        />
      )}

      {/* 列表 */}
      {loading ? (
        <div className="text-[11px] text-text-muted">加载中…</div>
      ) : sorted.length === 0 && !creating ? (
        <div className="px-2 py-3 text-[11px] text-text-muted text-center border border-dashed border-border rounded-md leading-relaxed">
          没有议程。按 + 添加第 1 个议项，会议讨论就有骨架。
        </div>
      ) : (
        <ol className="space-y-1.5">
          {sorted.map((it, i) => {
            const meta = STATUS_META[it.status];
            const isEditing = editing === it.id;
            if (isEditing) {
              return (
                <li key={it.id}>
                  <AgendaItemForm
                    mode="edit"
                    members={members}
                    initial={it}
                    onCancel={() => setEditing(null)}
                    onSave={async input => {
                      try {
                        await updateAgendaItem(it.id, input);
                        setItems(prev => prev.map(x => x.id === it.id ? { ...x, ...input } : x));
                        setEditing(null);
                      } catch { /* toast */ }
                    }}
                  />
                </li>
              );
            }
            return (
              <li
                key={it.id}
                className={`group relative px-2 py-1.5 rounded-md border ${meta.tone} ${it.status === 'active' ? 'shadow-[0_0_0_1px_rgba(6,182,212,0.2),0_0_12px_rgba(6,182,212,0.25)]' : ''} transition`}
              >
                <div className="flex items-start gap-2">
                  <span className="w-5 h-5 rounded-full border border-current/40 flex items-center justify-center text-[10px] font-mono shrink-0">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={`material-symbols-outlined text-[14px] ${meta.tone.split(' ')[0]}`}>{meta.icon}</span>
                      <span className={`text-[12px] font-semibold ${it.status === 'done' ? 'line-through decoration-1' : ''}`}>
                        {it.title}
                      </span>
                      <span className="text-[10px] text-text-muted">{meta.label}</span>
                    </div>
                    {it.description && <div className="mt-1 text-[11px] text-text-secondary line-clamp-2">{it.description}</div>}
                    {it.targetOutcome && <div className="mt-1 text-[11px] text-cyan-600 dark:text-cyan-300">🎯 {it.targetOutcome}</div>}
                    {it.assigneeIds.length > 0 && (
                      <div className="mt-1 flex items-center flex-wrap gap-1 text-[10px] text-text-muted">
                        {it.assigneeIds.map(aid => {
                          const m = members.get(aid);
                          return <span key={aid} className="px-1.5 py-[1px] rounded bg-surface-sunken">@{m?.name || aid}</span>;
                        })}
                      </div>
                    )}
                    {it.status === 'done' && it.outcome && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[10.5px] text-text-muted hover:text-text select-none">小结</summary>
                        <div className="mt-1 px-2 py-1.5 text-[11px] text-text-secondary bg-surface-sunken/50 rounded leading-relaxed whitespace-pre-wrap">
                          {it.outcome}
                        </div>
                      </details>
                    )}
                    {it.roundBudget ? (
                      <div className="mt-1 text-[10px] text-text-muted font-mono">
                        轮次 {it.roundsUsed}/{it.roundBudget}
                      </div>
                    ) : null}
                  </div>
                  {!readonly && (
                    <div className="flex flex-col items-center gap-0.5 opacity-0 group-hover:opacity-100 transition shrink-0">
                      <button type="button" onClick={() => moveSeq(it.id, -1)} disabled={i === 0}
                        className="w-6 h-6 rounded hover:bg-surface-sunken text-text-muted disabled:opacity-30 flex items-center justify-center"
                        title="上移"><span className="material-symbols-outlined text-[14px]">arrow_upward</span></button>
                      <button type="button" onClick={() => moveSeq(it.id, 1)} disabled={i === sorted.length - 1}
                        className="w-6 h-6 rounded hover:bg-surface-sunken text-text-muted disabled:opacity-30 flex items-center justify-center"
                        title="下移"><span className="material-symbols-outlined text-[14px]">arrow_downward</span></button>
                    </div>
                  )}
                  {!readonly && (
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition shrink-0">
                      <button type="button" onClick={() => setEditing(it.id)}
                        className="w-6 h-6 rounded hover:bg-surface-sunken text-text-muted hover:text-text flex items-center justify-center"
                        title="编辑"><span className="material-symbols-outlined text-[14px]">edit</span></button>
                      {it.status === 'active' && (
                        <button type="button" onClick={() => park(it.id)}
                          className="w-6 h-6 rounded hover:bg-amber-500/15 text-text-muted hover:text-amber-500 flex items-center justify-center"
                          title="挂起"><span className="material-symbols-outlined text-[14px]">pause</span></button>
                      )}
                      <button type="button" onClick={() => remove(it.id)}
                        className="w-6 h-6 rounded hover:bg-danger/10 text-text-muted hover:text-danger flex items-center justify-center"
                        title="删除"><span className="material-symbols-outlined text-[14px]">close</span></button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};

// ─── 单项编辑表单（create / edit 共用） ───
const AgendaItemForm: React.FC<{
  mode: 'create' | 'edit';
  initial?: AgendaItem;
  members: Map<string, Member>;
  onCancel: () => void;
  onSave: (input: {
    title: string;
    description?: string;
    targetOutcome?: string;
    roundBudget?: number;
    assigneeIds?: string[];
  }) => void;
}> = ({ mode, initial, members, onCancel, onSave }) => {
  const [title, setTitle] = useState(initial?.title || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [targetOutcome, setTargetOutcome] = useState(initial?.targetOutcome || '');
  const [roundBudget, setRoundBudget] = useState<number>(initial?.roundBudget || 0);
  const [assigneeIds, setAssigneeIds] = useState<string[]>(initial?.assigneeIds || []);

  const canSubmit = title.trim().length > 0;

  const toggle = (id: string) =>
    setAssigneeIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const eligibleMembers = Array.from(members.values()).filter(m => !m.isKicked);

  return (
    <div className="sci-card p-2.5 rounded-lg border border-cyan-500/30 bg-cyan-500/5 space-y-2 animate-card-enter">
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="议项标题（例如：定价策略评估）"
        autoFocus
        className="sci-input w-full h-8 px-2 rounded-md text-[12.5px] font-semibold bg-surface border border-border"
      />
      <textarea
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="背景说明（可选）"
        rows={2}
        className="sci-input w-full px-2 py-1.5 rounded-md text-[12px] bg-surface border border-border resize-none"
      />
      <input
        value={targetOutcome}
        onChange={e => setTargetOutcome(e.target.value)}
        placeholder="🎯 预期产出（例如：确定 3 档价格方案并投票）"
        className="sci-input w-full h-7 px-2 rounded-md text-[11.5px] bg-surface border border-border"
      />
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-text-muted">轮次预算</span>
        <NumberStepper
          min={0} max={30} step={1}
          value={roundBudget ? String(roundBudget) : ''}
          onChange={s => setRoundBudget(Math.max(0, Math.min(30, parseInt(s) || 0)))}
          placeholder="0 = 不限"
          className="sci-input w-16 h-7 px-2 rounded-md text-[11.5px] bg-surface border border-border font-mono"
        />
        <span className="text-[10.5px] text-text-muted">0 = 不限</span>
      </div>
      {eligibleMembers.length > 0 && (
        <div>
          <div className="text-[10.5px] text-text-muted mb-1">分配主讲（可多选）</div>
          <div className="flex flex-wrap gap-1">
            {eligibleMembers.map(m => {
              const on = assigneeIds.includes(m.id);
              return (
                <button type="button" key={m.id} onClick={() => toggle(m.id)}
                  className={`h-6 px-2 rounded-full border text-[11px] transition ${
                    on ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-700 dark:text-cyan-200'
                       : 'border-border text-text-muted hover:bg-surface-sunken'
                  }`}>
                  {on ? '✓ ' : ''}{m.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="flex justify-end gap-1.5 pt-1">
        <button type="button" onClick={onCancel}
          className="h-7 px-3 rounded-md text-[11.5px] border border-border text-text-muted hover:bg-surface-sunken">
          取消
        </button>
        <button type="button" disabled={!canSubmit}
          onClick={() => onSave({
            title: title.trim(),
            description: description.trim() || undefined,
            targetOutcome: targetOutcome.trim() || undefined,
            roundBudget: roundBudget || undefined,
            assigneeIds: assigneeIds.length > 0 ? assigneeIds : undefined,
          })}
          className="h-7 px-3 rounded-md text-[11.5px] font-semibold bg-cyan-500 hover:bg-cyan-600 text-white disabled:opacity-50 disabled:cursor-not-allowed">
          {mode === 'create' ? '添加' : '保存'}
        </button>
      </div>
    </div>
  );
};

export default AgendaRail;
