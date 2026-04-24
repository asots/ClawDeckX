// ArtifactsPanel —— 房间级交付物面板
//
// 展示所有 Artifact（markdown/code/json/text），支持创建 / 编辑 / 删除 / 下载。
// v0.6 把"讨论"和"真正的交付物" 解耦：讨论流的 chat 消息可以杂乱无章，交付物则是可版本化、可下载、可比对的一等公民。
//
// 一期简化：没有 CRDT/多人协同；同时编辑后写方赢。后续 v0.7 接 Yjs。

import React, { useEffect, useState } from 'react';
import type { Artifact } from '../types';
import { listArtifacts, createArtifact, updateArtifact, deleteArtifact } from '../service';
import CustomSelect from '../../../components/CustomSelect';

interface Props {
  roomId: string;
}

const KIND_META: Record<Artifact['kind'], { label: string; icon: string }> = {
  markdown: { label: 'Markdown', icon: 'article' },
  code:     { label: 'Code',     icon: 'code' },
  json:     { label: 'JSON',     icon: 'data_object' },
  text:     { label: 'Text',     icon: 'description' },
};

function downloadText(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function fileExtFor(a: Artifact): string {
  if (a.kind === 'markdown') return 'md';
  if (a.kind === 'json') return 'json';
  if (a.kind === 'code') return a.language || 'txt';
  return 'txt';
}

const ArtifactsPanel: React.FC<Props> = ({ roomId }) => {
  const [items, setItems] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Partial<Artifact>>({});

  const refetch = React.useCallback(() => {
    setLoading(true);
    listArtifacts(roomId).then(setItems).finally(() => setLoading(false));
  }, [roomId]);

  useEffect(() => { refetch(); }, [refetch]);

  const startCreate = () => {
    setCreating(true);
    setEditingId(null);
    setDraft({ title: '', kind: 'markdown', content: '' });
  };
  const startEdit = (a: Artifact) => {
    setCreating(false);
    setEditingId(a.id);
    setDraft({ title: a.title, kind: a.kind, language: a.language, content: a.content });
  };
  const cancel = () => { setCreating(false); setEditingId(null); setDraft({}); };

  const save = async () => {
    if (!draft.title?.trim()) { alert('标题必填'); return; }
    if (creating) {
      await createArtifact(roomId, {
        title: draft.title.trim(),
        kind: (draft.kind as Artifact['kind']) || 'markdown',
        content: draft.content ?? '',
        language: draft.language,
      });
    } else if (editingId) {
      await updateArtifact(editingId, {
        title: draft.title,
        kind: draft.kind as Artifact['kind'],
        content: draft.content,
        language: draft.language,
      });
    }
    cancel();
    refetch();
  };

  const doDelete = async (a: Artifact) => {
    if (!confirm(`删除 Artifact "${a.title}"？该操作不可撤销。`)) return;
    await deleteArtifact(a.id);
    setItems(prev => prev.filter(x => x.id !== a.id));
  };

  if (loading) return <div className="text-[11px] text-text-muted">加载中…</div>;

  const isEditing = !!(creating || editingId);

  return (
    <div className="space-y-2">
      {!isEditing && (
        <button
          type="button"
          onClick={startCreate}
          className="w-full h-7 px-3 rounded-md text-[11.5px] font-semibold bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 transition inline-flex items-center justify-center gap-1"
        >
          <span className="material-symbols-outlined text-[14px]">add</span>
          新建 Artifact
        </button>
      )}

      {isEditing && (
        <div className="rounded-md border border-primary/40 bg-surface-raised p-2 space-y-1.5">
          <input
            type="text"
            value={draft.title ?? ''}
            onChange={e => setDraft({ ...draft, title: e.target.value })}
            placeholder="标题（如 PRD / spec / main.go）"
            className="w-full px-2 h-7 text-[12px] rounded bg-surface border border-border"
          />
          <div className="flex items-center gap-1.5">
            <div className="w-[120px] shrink-0">
              <CustomSelect
                value={draft.kind ?? 'markdown'}
                onChange={(v) => setDraft({ ...draft, kind: v as Artifact['kind'] })}
                options={(['markdown', 'code', 'json', 'text'] as Artifact['kind'][]).map(k => ({ value: k, label: KIND_META[k].label }))}
                className="px-2 h-7 text-[11px] rounded bg-surface border border-border"
              />
            </div>
            {draft.kind === 'code' && (
              <input
                type="text"
                value={draft.language ?? ''}
                onChange={e => setDraft({ ...draft, language: e.target.value })}
                placeholder="go/py/ts/..."
                className="flex-1 px-2 h-7 text-[11px] rounded bg-surface border border-border"
              />
            )}
          </div>
          <textarea
            value={draft.content ?? ''}
            onChange={e => setDraft({ ...draft, content: e.target.value })}
            placeholder="Artifact 内容……"
            rows={6}
            className="w-full px-2 py-1 text-[12px] font-mono rounded bg-surface border border-border resize-y"
          />
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={cancel}
              className="px-2 h-6 rounded text-[11px] hover:bg-surface-sunken text-text-secondary"
            >取消</button>
            <button
              type="button"
              onClick={save}
              className="px-2 h-6 rounded text-[11px] font-semibold bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30"
            >保存</button>
          </div>
        </div>
      )}

      {items.length === 0 && !isEditing && (
        <div className="px-2 py-3 text-[11px] text-text-muted text-center border border-dashed border-border rounded-md leading-relaxed">
          还没有 Artifact。点「新建」或让 agent 用 <code className="px-1 rounded bg-surface-sunken">/close</code> 生成纪要。
        </div>
      )}

      <ul className="space-y-1">
        {items.map(a => (
          <li
            key={a.id}
            className="group flex items-start gap-2 px-2 py-1.5 rounded-md border border-border bg-surface-raised hover:bg-surface-sunken transition"
          >
            <span className="material-symbols-outlined text-[16px] text-primary mt-0.5 shrink-0">{KIND_META[a.kind].icon}</span>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-text truncate">{a.title}</div>
              <div className="text-[10px] text-text-muted flex items-center gap-1">
                <span>{KIND_META[a.kind].label}{a.language ? ` · ${a.language}` : ''}</span>
                <span>·</span>
                <span>v{a.version}</span>
                <span>·</span>
                <span>{new Date(a.updatedAt).toLocaleDateString()}</span>
              </div>
            </div>
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition shrink-0">
              <button
                type="button"
                onClick={() => downloadText(`${a.title}.${fileExtFor(a)}`, a.content)}
                className="w-6 h-6 rounded hover:bg-surface-sunken flex items-center justify-center text-text-muted hover:text-text"
                title="下载"
              >
                <span className="material-symbols-outlined text-[14px]">download</span>
              </button>
              <button
                type="button"
                onClick={() => startEdit(a)}
                className="w-6 h-6 rounded hover:bg-surface-sunken flex items-center justify-center text-text-muted hover:text-text"
                title="编辑"
              >
                <span className="material-symbols-outlined text-[14px]">edit</span>
              </button>
              <button
                type="button"
                onClick={() => doDelete(a)}
                className="w-6 h-6 rounded hover:bg-danger/10 flex items-center justify-center text-text-muted hover:text-danger"
                title="删除"
              >
                <span className="material-symbols-outlined text-[14px]">delete</span>
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default ArtifactsPanel;
