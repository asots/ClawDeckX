// 右栏·房间记忆（Room Memory · 共享 k-v 事实表）
import React, { useState } from 'react';
import type { Member, RoomFact } from '../types';

interface Props {
  facts: RoomFact[];
  members: Map<string, Member>;
  onUpsert: (key: string, value: string) => void;
  onDelete: (key: string) => void;
}

const MemoryPanel: React.FC<Props> = ({ facts, members, onUpsert, onDelete }) => {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftK, setDraftK] = useState('');
  const [draftV, setDraftV] = useState('');
  const [adding, setAdding] = useState(false);

  const startEdit = (f: RoomFact) => {
    setEditingKey(f.key);
    setDraftK(f.key);
    setDraftV(f.value);
  };

  const save = () => {
    if (!draftK.trim()) return;
    onUpsert(draftK.trim(), draftV.trim());
    setEditingKey(null);
    setAdding(false);
    setDraftK('');
    setDraftV('');
  };

  return (
    <div>
      {facts.length === 0 && !adding && (
        <div className="px-2 py-4 text-center">
          <span className="material-symbols-outlined text-[24px] text-text-muted opacity-40">database</span>
          <p className="text-[11px] text-text-muted mt-1.5">暂无共享事实</p>
          <p className="text-[10px] text-text-disabled mt-1 leading-relaxed">这里记录房间的关键事实，<br/>所有 Agent 都会看到</p>
        </div>
      )}

      <div className="space-y-1">
        {facts.map(f => {
          const editing = editingKey === f.key;
          const author = members.get(f.authorId);
          return editing ? (
            <div key={f.key} className="p-2 rounded-lg bg-surface-raised border border-cyan-500/30">
              <input
                value={draftK}
                onChange={e => setDraftK(e.target.value)}
                className="w-full mb-1 px-1.5 py-0.5 rounded bg-surface border border-border text-[11px] font-semibold sci-input"
                placeholder="key"
              />
              <textarea
                value={draftV}
                onChange={e => setDraftV(e.target.value)}
                rows={2}
                className="w-full mb-1.5 px-1.5 py-1 rounded bg-surface border border-border text-[11px] sci-input resize-none"
                placeholder="value"
                autoFocus
              />
              <div className="flex gap-1">
                <button onClick={save} className="flex-1 h-6 rounded-md text-[10px] font-bold bg-primary text-white hover:bg-primary/90">保存</button>
                <button onClick={() => { setEditingKey(null); setDraftK(''); setDraftV(''); }} className="flex-1 h-6 rounded-md text-[10px] font-semibold bg-surface hover:bg-surface-sunken border border-border">取消</button>
              </div>
            </div>
          ) : (
            <button
              key={f.key}
              onDoubleClick={() => startEdit(f)}
              className="w-full group p-1.5 rounded-md hover:bg-surface-sunken transition-colors text-start"
              title={`${author?.name || f.authorId} · 双击编辑`}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-cyan-600 dark:text-cyan-400 truncate">{f.key}</span>
                <span className="flex-1 h-px bg-border" />
                <button
                  onClick={e => { e.stopPropagation(); onDelete(f.key); }}
                  className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-red-500"
                  title="删除"
                >
                  <span className="material-symbols-outlined text-[12px]">close</span>
                </button>
              </div>
              <div className="text-[11px] text-text leading-relaxed break-words whitespace-pre-wrap">{f.value}</div>
              {author && (
                <div className="text-[9px] text-text-muted mt-0.5 font-mono truncate">{author.emoji || '·'} {author.name}</div>
              )}
            </button>
          );
        })}
      </div>

      {adding ? (
        <div className="mt-2 p-2 rounded-lg bg-surface-raised border border-cyan-500/30">
          <input
            value={draftK}
            onChange={e => setDraftK(e.target.value)}
            className="w-full mb-1 px-1.5 py-0.5 rounded bg-surface border border-border text-[11px] font-semibold sci-input"
            placeholder="key（如 规模、预算）"
            autoFocus
          />
          <textarea
            value={draftV}
            onChange={e => setDraftV(e.target.value)}
            rows={2}
            className="w-full mb-1.5 px-1.5 py-1 rounded bg-surface border border-border text-[11px] sci-input resize-none"
            placeholder="value"
          />
          <div className="flex gap-1">
            <button onClick={save} className="flex-1 h-6 rounded-md text-[10px] font-bold bg-primary text-white hover:bg-primary/90">添加</button>
            <button onClick={() => { setAdding(false); setDraftK(''); setDraftV(''); }} className="flex-1 h-6 rounded-md text-[10px] font-semibold bg-surface hover:bg-surface-sunken border border-border">取消</button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="mt-1.5 w-full h-7 rounded-md border border-dashed border-border text-text-muted hover:border-cyan-500/40 hover:text-cyan-500 hover:bg-cyan-500/5 transition-all text-[11px] font-semibold flex items-center justify-center gap-1"
        >
          <span className="material-symbols-outlined text-[14px]">add</span>
          新建条目
        </button>
      )}
    </div>
  );
};

export default MemoryPanel;
