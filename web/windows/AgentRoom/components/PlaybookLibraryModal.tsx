// PlaybookLibraryModal —— 跨房间的经验库
//
// 一场会议开完，如果结论足够清晰，可以 "抓成 Playbook"，下次类似问题直接喂给新房间做 few-shot。
// 条目含 problem / approach / conclusion 三段 + 可选 category/tags，最小可用版本不分支不合并。
//
// 入口：TopBar → "📚 Playbooks"。
// 新建来源：从当前房间生成（传 fromRoomId；后端挑最近决策/纪要填充），或手动填表。

import React, { useEffect, useMemo, useState } from 'react';
import type { Playbook } from '../types';
import { listPlaybooks, createPlaybook, deletePlaybook, applyPlaybookToRoom } from '../service';
import { useConfirm } from '../../../components/ConfirmDialog';

interface Props {
  open: boolean;
  currentRoomId?: string;
  onClose: () => void;
}

type Mode = 'list' | 'create';

const PlaybookLibraryModal: React.FC<Props> = ({ open, currentRoomId, onClose }) => {
  const { confirm } = useConfirm();
  const [items, setItems] = useState<Playbook[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>('list');
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Partial<Playbook> & { fromRoomId?: string }>({});

  const refetch = React.useCallback(() => {
    setLoading(true);
    listPlaybooks().then(setItems).catch(() => setItems([])).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (open) {
      refetch();
      setMode('list');
      setQ('');
    }
  }, [open, refetch]);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return items;
    return items.filter(p =>
      p.title.toLowerCase().includes(n) ||
      (p.category || '').toLowerCase().includes(n) ||
      (p.tags || []).some(t => t.toLowerCase().includes(n)) ||
      p.problem.toLowerCase().includes(n) ||
      p.conclusion.toLowerCase().includes(n),
    );
  }, [items, q]);

  const save = async () => {
    if (!draft.title?.trim()) { alert('标题必填'); return; }
    await createPlaybook({
      title: draft.title.trim(),
      problem: draft.problem || '',
      approach: draft.approach || '',
      conclusion: draft.conclusion || '',
      category: draft.category || undefined,
      tags: draft.tags,
      fromRoomId: draft.fromRoomId,
    });
    setMode('list');
    setDraft({});
    refetch();
  };

  const doDelete = async (p: Playbook) => {
    const ok = await confirm({
      title: '删除 Playbook',
      message: `将删除「${p.title}」。此操作不可撤销。\n\n继续？`,
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    await deletePlaybook(p.id);
    setItems(prev => prev.filter(x => x.id !== p.id));
  };

  const [applying, setApplying] = useState<string | null>(null);
  const doApply = async (p: Playbook) => {
    if (!currentRoomId || applying) return;
    // v0.9：应用 Playbook 会把内容作为 summary 消息注入当前房间对话流，
    // 影响后续 agent 上下文。虽不调 LLM 但不可撤销，与 v7 版的确认一致。
    const ok = await confirm({
      title: '应用 Playbook',
      message: `将把「${p.title}」的内容作为汇总消息注入当前房间。这条消息后续会被 agent 纳入上下文，影响后续讨论。\n\n确认应用？`,
      confirmText: '应用',
      cancelText: '取消',
    });
    if (!ok) return;
    setApplying(p.id);
    try {
      await applyPlaybookToRoom(currentRoomId, p.id);
      onClose();
    } finally {
      setApplying(null);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="relative w-full max-w-3xl max-h-[85vh] rounded-xl bg-surface border border-border mac-window-shadow overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="shrink-0 px-4 py-2.5 border-b border-border flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px] text-primary">menu_book</span>
          <h2 className="text-[13px] font-semibold">经验库 · Playbooks</h2>
          <span className="text-[11px] text-text-muted">({items.length})</span>
          <div className="flex-1" />
          {mode === 'list' ? (
            <>
              <div className="relative">
                <span className="material-symbols-outlined absolute start-2 top-1/2 -translate-y-1/2 text-[14px] text-text-muted">search</span>
                <input
                  type="search"
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  placeholder="搜索"
                  className="ps-7 pe-2 h-7 w-48 text-[11px] rounded bg-surface-sunken border border-border focus:outline-none focus:border-primary/40"
                />
              </div>
              <button
                type="button"
                onClick={() => { setMode('create'); setDraft({ fromRoomId: currentRoomId }); }}
                className="inline-flex items-center gap-1 px-2 h-7 rounded text-[11px] font-semibold bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30"
              >
                <span className="material-symbols-outlined text-[14px]">add</span>
                新建
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => { setMode('list'); setDraft({}); }}
              className="px-2 h-7 rounded text-[11px] hover:bg-surface-sunken text-text-muted"
            >
              返回列表
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded hover:bg-surface-sunken flex items-center justify-center text-text-muted hover:text-text"
            title="关闭 (Esc)"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {mode === 'list' && (
            loading ? (
              <div className="text-center text-[12px] text-text-muted py-8">加载中…</div>
            ) : filtered.length === 0 ? (
              <div className="text-center text-[12px] text-text-muted py-8 leading-relaxed">
                {q ? '没有匹配结果。' : '还没有 Playbook。在某个房间收尾时，点"从此房间生成"留下你的经验。'}
              </div>
            ) : (
              <ul className="space-y-2">
                {filtered.map(p => (
                  <li
                    key={p.id}
                    className="group rounded-lg border border-border bg-surface-raised hover:bg-surface-sunken p-2.5 transition"
                  >
                    <div className="flex items-start gap-2">
                      <span className="material-symbols-outlined text-[18px] text-primary mt-0.5 shrink-0">auto_stories</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <div className="text-[13px] font-semibold text-text">{p.title}</div>
                          {p.category && (
                            <span className="px-1.5 h-4 rounded-full text-[10px] bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/30">
                              {p.category}
                            </span>
                          )}
                          {(p.tags || []).slice(0, 4).map(t => (
                            <span key={t} className="px-1.5 h-4 rounded-full text-[10px] bg-surface-sunken text-text-muted border border-border">
                              #{t}
                            </span>
                          ))}
                          <span className="ms-auto text-[10px] text-text-muted font-mono">
                            {new Date(p.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        {p.problem && (
                          <div className="mt-1 text-[11px] text-text-secondary">
                            <span className="font-semibold text-text-muted">问题：</span>
                            <span className="line-clamp-2">{p.problem}</span>
                          </div>
                        )}
                        {p.conclusion && (
                          <div className="mt-0.5 text-[11px] text-text-secondary">
                            <span className="font-semibold text-text-muted">结论：</span>
                            <span className="line-clamp-2">{p.conclusion}</span>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {currentRoomId && (
                          <button
                            type="button"
                            onClick={() => doApply(p)}
                            disabled={applying === p.id}
                            className="inline-flex items-center gap-1 px-2 h-6 rounded text-[10px] font-semibold bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 opacity-0 group-hover:opacity-100 transition disabled:opacity-60"
                            title="把此 Playbook 作为参考贴到当前房间"
                          >
                            <span className="material-symbols-outlined text-[12px]">forward_to_inbox</span>
                            {applying === p.id ? '应用中…' : '应用'}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => doDelete(p)}
                          className="w-6 h-6 rounded hover:bg-danger/10 flex items-center justify-center text-text-muted hover:text-danger opacity-0 group-hover:opacity-100 transition"
                          title="删除"
                        >
                          <span className="material-symbols-outlined text-[14px]">delete</span>
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )
          )}

          {mode === 'create' && (
            <div className="space-y-2 text-[12px]">
              {currentRoomId && (
                <label className="flex items-start gap-2 px-2 py-1.5 rounded-md border border-primary/40 bg-primary/5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.fromRoomId === currentRoomId}
                    onChange={e => setDraft({ ...draft, fromRoomId: e.target.checked ? currentRoomId : undefined })}
                    className="mt-0.5 accent-primary"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-primary">从当前房间生成</div>
                    <div className="text-[10px] text-text-muted leading-snug">
                      服务端会取当前房间的目标、决策、纪要预填下面的 problem/approach/conclusion；之后仍可手动修改。
                    </div>
                  </div>
                </label>
              )}
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1">标题 *</label>
                <input
                  type="text"
                  value={draft.title ?? ''}
                  onChange={e => setDraft({ ...draft, title: e.target.value })}
                  placeholder="例：如何从 0 搭建多 agent 协同系统"
                  className="w-full px-2 h-7 rounded bg-surface border border-border text-[12px]"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1">分类</label>
                  <input
                    type="text"
                    value={draft.category ?? ''}
                    onChange={e => setDraft({ ...draft, category: e.target.value })}
                    placeholder="ops / dev / research…"
                    className="w-full px-2 h-7 rounded bg-surface border border-border text-[12px]"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1">Tags (逗号分隔)</label>
                  <input
                    type="text"
                    value={(draft.tags || []).join(', ')}
                    onChange={e => setDraft({ ...draft, tags: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                    placeholder="incident, rollback, postmortem"
                    className="w-full px-2 h-7 rounded bg-surface border border-border text-[12px]"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1">Problem</label>
                <textarea
                  value={draft.problem ?? ''}
                  onChange={e => setDraft({ ...draft, problem: e.target.value })}
                  rows={3}
                  className="w-full px-2 py-1 rounded bg-surface border border-border text-[12px] resize-y"
                  placeholder="遇到的问题是什么？边界条件、已知约束……"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1">Approach</label>
                <textarea
                  value={draft.approach ?? ''}
                  onChange={e => setDraft({ ...draft, approach: e.target.value })}
                  rows={3}
                  className="w-full px-2 py-1 rounded bg-surface border border-border text-[12px] resize-y"
                  placeholder="怎么切的问题？调用了哪些 agent、哪些工具、哪些决策？"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1">Conclusion</label>
                <textarea
                  value={draft.conclusion ?? ''}
                  onChange={e => setDraft({ ...draft, conclusion: e.target.value })}
                  rows={3}
                  className="w-full px-2 py-1 rounded bg-surface border border-border text-[12px] resize-y"
                  placeholder="最终结论 + 能沉淀下来的可复用模式"
                />
              </div>
              <div className="flex justify-end gap-1 pt-1">
                <button
                  type="button"
                  onClick={() => { setMode('list'); setDraft({}); }}
                  className="px-3 h-7 rounded text-[11px] hover:bg-surface-sunken text-text-secondary"
                >取消</button>
                <button
                  type="button"
                  onClick={save}
                  className="px-3 h-7 rounded text-[11px] font-semibold bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30"
                >保存</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PlaybookLibraryModal;
