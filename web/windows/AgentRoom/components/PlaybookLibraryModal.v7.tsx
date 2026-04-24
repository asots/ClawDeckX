// PlaybookLibraryModal (v0.7) —— 经验库 Studio
//
// 相比 v0.6 初版：
//   - 使用结构化 PlaybookV7（tags / appliesTo / steps / usageCount / isFavorite / version）
//   - 顶部搜索走服务端 SearchPlaybooks（跨字段 LIKE + usage 降序）
//   - 每条卡片：tag chips + 使用次数 + 收藏星 + 点卡进入完整编辑器
//   - "应用到当前房间" + "从当前房间生成" 两条入口保留
//   - 通过 PlaybookEditor 做全量结构化编辑（双击或编辑图标）
//
// 这个组件是 PlaybookLibraryModal 的替代实现；原组件保留以兼容旧入口。

import React, { useEffect, useMemo, useState } from 'react';
import type { PlaybookHighlightContext, PlaybookV7 } from '../types';
import {
  listPlaybooksV7, searchPlaybooks, togglePlaybookFavorite,
  deletePlaybook, applyPlaybookToRoom, createPlaybook,
} from '../service';
import PlaybookEditor from './PlaybookEditor';
import { useConfirm } from '../../../components/ConfirmDialog';

interface Props {
  open: boolean;
  currentRoomId?: string;
  onClose: () => void;
  initialEditingId?: string | null;
  highlightContext?: PlaybookHighlightContext | null;
}

const PlaybookLibraryModalV7: React.FC<Props> = ({ open, currentRoomId, onClose, initialEditingId, highlightContext }) => {
  const { confirm } = useConfirm();
  const [items, setItems] = useState<PlaybookV7[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [onlyFav, setOnlyFav] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);

  // 初始 / 关键词切换 fetch
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const p = q.trim()
      ? searchPlaybooks(q.trim())
      : listPlaybooksV7();
    p.then(setItems).catch(() => setItems([])).finally(() => setLoading(false));
  }, [open, q]);

  useEffect(() => {
    if (open && initialEditingId) {
      setEditingId(initialEditingId);
    }
  }, [open, initialEditingId]);

  const refetch = React.useCallback(() => {
    setLoading(true);
    const p = q.trim() ? searchPlaybooks(q.trim()) : listPlaybooksV7();
    p.then(setItems).catch(() => setItems([])).finally(() => setLoading(false));
  }, [q]);

  const visible = useMemo(
    () => onlyFav ? items.filter(p => p.isFavorite) : items,
    [items, onlyFav],
  );

  const fav = async (p: PlaybookV7) => {
    const optimistic = { ...p, isFavorite: !p.isFavorite };
    setItems(prev => prev.map(x => x.id === p.id ? optimistic : x));
    try {
      const fresh = await togglePlaybookFavorite(p.id);
      setItems(prev => prev.map(x => x.id === fresh.id ? fresh : x));
    } catch { /* 服务层已 toast */ }
  };

  const doApply = async (p: PlaybookV7) => {
    if (!currentRoomId || applying) return;
    // v0.9：应用 Playbook 会把 4 段内容作为 summary 消息注入当前房间对话流 ——
    // 虽然不调 LLM，但会影响讨论上下文且不能撤销，需要显式确认。
    const ok = await confirm({
      title: '应用 Playbook',
      message: `将把「${p.title}」的 4 段内容（总结 / 亮点 / 改进 / 下次建议）作为一条汇总消息注入当前房间。这条消息后续会被 agent 纳入上下文，影响后续讨论。\n\n确认应用？`,
      confirmText: '应用',
      cancelText: '取消',
    });
    if (!ok) return;
    setApplying(p.id);
    try {
      await applyPlaybookToRoom(currentRoomId, p.id);
      onClose();
    } finally { setApplying(null); }
  };

  const doDelete = async (p: PlaybookV7) => {
    const ok = await confirm({
      title: '删除 Playbook',
      message: `将删除「${p.title}」。该操作不可撤销。\n\n继续？`,
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    setItems(prev => prev.filter(x => x.id !== p.id));
    try { await deletePlaybook(p.id); } catch { refetch(); }
  };

  const doCreateFromRoom = async () => {
    if (!currentRoomId || createBusy) return;
    setCreateBusy(true);
    try {
      await createPlaybook({ title: '（待命名）', fromRoomId: currentRoomId });
      await refetch();
      setCreating(false);
    } finally { setCreateBusy(false); }
  };

  const doCreateBlank = async () => {
    if (createBusy) return;
    setCreateBusy(true);
    try {
      const p = await createPlaybook({ title: '（新 Playbook）' } as any);
      await refetch();
      setCreating(false);
      if (p && (p as any).id) setEditingId((p as any).id);
    } finally { setCreateBusy(false); }
  };

  if (!open && !editingId) return null;

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
          onClick={onClose}
          role="dialog" aria-modal="true"
        >
          <div
            onClick={e => e.stopPropagation()}
            className="relative w-[min(1000px,96vw)] max-h-[88vh] rounded-xl bg-surface-overlay border border-border mac-window-shadow overflow-hidden flex flex-col"
          >
            {/* Header */}
            <div className="shrink-0 px-4 py-3 border-b border-border flex items-center gap-2 bg-gradient-to-r from-indigo-500/10 via-purple-500/5 to-transparent">
              <span className="material-symbols-outlined text-[20px] text-indigo-500">menu_book</span>
              <h2 className="text-[13.5px] font-bold">经验库 · Playbooks</h2>
              <span className="text-[11px] text-text-muted font-mono">({items.length})</span>
              <div className="flex-1" />

              <div className="relative">
                <span className="material-symbols-outlined absolute start-2 top-1/2 -translate-y-1/2 text-[14px] text-text-muted">search</span>
                <input type="search" value={q} onChange={e => setQ(e.target.value)}
                  placeholder="搜索标题 / 标签 / 适用场景…"
                  className="ps-7 pe-2 h-8 w-60 text-[11.5px] rounded-md bg-surface border border-border focus:outline-none focus:border-indigo-500/50"
                />
              </div>

              <button type="button" onClick={() => setOnlyFav(v => !v)}
                className={`h-8 px-2 rounded-md text-[11.5px] inline-flex items-center gap-1 border ${
                  onlyFav ? 'bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-300' : 'border-border text-text-muted hover:bg-surface-sunken'
                }`}
                title="仅显示收藏"
              >
                <span className="material-symbols-outlined text-[14px]">{onlyFav ? 'star' : 'star_outline'}</span>
                收藏
              </button>

              <button type="button" onClick={() => setCreating(true)}
                className="h-8 px-3 rounded-md text-[11.5px] font-semibold bg-indigo-500 hover:bg-indigo-600 text-white inline-flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">add</span>
                新建
              </button>

              <button type="button" onClick={onClose}
                className="w-8 h-8 rounded-md hover:bg-surface-sunken text-text-muted hover:text-text transition"
                title="关闭">
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>

            {/* Create menu (小 popover) */}
            {creating && (
              <div className="border-b border-border p-3 bg-surface-sunken/40 flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-text">创建方式：</span>
                {currentRoomId && (
                  <button type="button" onClick={doCreateFromRoom} disabled={createBusy}
                    className="h-8 px-3 rounded-md text-[11.5px] font-semibold border border-cyan-500/40 text-cyan-700 dark:text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-50 inline-flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">download</span>
                    从当前房间 AI 提炼
                  </button>
                )}
                <button type="button" onClick={doCreateBlank} disabled={createBusy}
                  className="h-8 px-3 rounded-md text-[11.5px] font-semibold border border-border text-text hover:bg-surface-sunken disabled:opacity-50 inline-flex items-center gap-1">
                  <span className="material-symbols-outlined text-[14px]">edit_note</span>
                  空白手写
                </button>
                <button type="button" onClick={() => setCreating(false)}
                  className="ms-auto h-8 px-3 rounded-md text-[11.5px] text-text-muted hover:bg-surface-sunken">
                  取消
                </button>
              </div>
            )}

            {/* Body */}
            <div className="flex-1 min-h-0 overflow-y-auto neon-scrollbar p-3">
              {loading ? (
                <div className="text-center text-[12px] text-text-muted py-12">加载中…</div>
              ) : visible.length === 0 ? (
                <div className="text-center text-[12px] text-text-muted py-12 leading-relaxed">
                  {q ? '没有匹配结果。' : onlyFav ? '还没有收藏的 Playbook。点列表里的 ☆ 标记。' :
                    '还没有 Playbook。在某个房间关闭时会自动生成；也可点「新建」手写一条。'}
                </div>
              ) : (
                <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {visible.map(p => (
                    <li key={p.id}
                      className="group sci-card relative rounded-lg border border-border bg-surface hover:bg-surface-sunken p-3 transition cursor-pointer"
                      onClick={() => setEditingId(p.id)}
                    >
                      {/* 顶部 meta */}
                      <div className="flex items-start gap-2">
                        <span className="material-symbols-outlined text-[18px] text-indigo-500 mt-0.5 shrink-0">auto_stories</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <div className="text-[13px] font-bold text-text truncate">{p.title}</div>
                            <span className="text-[10px] text-text-muted font-mono">v{p.version}</span>
                            {p.usageCount > 0 && (
                              <span className="px-1.5 py-[1px] rounded-full text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-mono">
                                × {p.usageCount}
                              </span>
                            )}
                          </div>
                          {p.category && (
                            <div className="mt-0.5 text-[10.5px] text-text-muted">{p.category}</div>
                          )}
                        </div>
                        <button type="button"
                          onClick={e => { e.stopPropagation(); fav(p); }}
                          className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition ${
                            p.isFavorite ? 'text-amber-500 hover:bg-amber-500/15' : 'text-text-muted hover:bg-surface-sunken'
                          }`}
                          title={p.isFavorite ? '取消收藏' : '收藏'}>
                          <span className="material-symbols-outlined text-[16px]">{p.isFavorite ? 'star' : 'star_outline'}</span>
                        </button>
                      </div>

                      {/* 内容 preview */}
                      {p.problem && (
                        <div className="mt-2 text-[11.5px] text-text-secondary leading-relaxed">
                          <span className="text-[10px] font-semibold text-text-muted">问题 · </span>
                          <span className="line-clamp-2">{p.problem}</span>
                        </div>
                      )}
                      {p.conclusion && (
                        <div className="mt-1 text-[11.5px] text-text-secondary leading-relaxed">
                          <span className="text-[10px] font-semibold text-text-muted">结论 · </span>
                          <span className="line-clamp-2">{p.conclusion}</span>
                        </div>
                      )}

                      {/* Steps 概要 */}
                      {p.steps.length > 0 && (
                        <div className="mt-1 text-[10.5px] text-text-muted">
                          🪜 {p.steps.filter(s => s.checked).length}/{p.steps.length} 步
                        </div>
                      )}

                      {/* tags */}
                      {(p.tags.length > 0 || p.appliesTo.length > 0) && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {p.tags.slice(0, 4).map(t => (
                            <span key={t} className="px-1.5 py-[1px] rounded-full text-[10px] bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-500/25">
                              #{t}
                            </span>
                          ))}
                          {p.appliesTo.slice(0, 2).map(a => (
                            <span key={a} className="px-1.5 py-[1px] rounded-full text-[10px] bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border border-cyan-500/25">
                              {a}
                            </span>
                          ))}
                          {p.tags.length + p.appliesTo.length > 6 && (
                            <span className="px-1.5 py-[1px] rounded-full text-[10px] text-text-muted">+{p.tags.length + p.appliesTo.length - 6}</span>
                          )}
                        </div>
                      )}

                      {/* 底部 actions */}
                      <div className="mt-2 flex items-center justify-between text-[10.5px] text-text-muted">
                        <span className="font-mono">{new Date(p.updatedAt).toLocaleDateString()}</span>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                          {currentRoomId && (
                            <button type="button"
                              onClick={e => { e.stopPropagation(); doApply(p); }}
                              disabled={applying === p.id}
                              className="h-6 px-2 rounded text-[10.5px] font-semibold bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-700 dark:text-cyan-200 border border-cyan-500/30 disabled:opacity-60 inline-flex items-center gap-1"
                              title="应用到当前房间">
                              <span className="material-symbols-outlined text-[12px]">forward_to_inbox</span>
                              {applying === p.id ? '应用中…' : '应用'}
                            </button>
                          )}
                          <button type="button"
                            onClick={e => { e.stopPropagation(); setEditingId(p.id); }}
                            className="h-6 w-6 rounded hover:bg-surface-sunken flex items-center justify-center text-text-muted hover:text-text"
                            title="编辑">
                            <span className="material-symbols-outlined text-[13px]">edit</span>
                          </button>
                          <button type="button"
                            onClick={e => { e.stopPropagation(); doDelete(p); }}
                            className="h-6 w-6 rounded hover:bg-danger/10 flex items-center justify-center text-text-muted hover:text-danger"
                            title="删除">
                            <span className="material-symbols-outlined text-[13px]">delete</span>
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {editingId && (
        <PlaybookEditor
          playbookId={editingId}
          highlightContext={highlightContext && highlightContext.playbookId === editingId ? highlightContext : null}
          onClose={() => { setEditingId(null); refetch(); }}
          onSaved={updated => {
            setItems(prev => prev.map(x => x.id === updated.id ? updated : x));
          }}
        />
      )}
    </>
  );
};

export default PlaybookLibraryModalV7;
