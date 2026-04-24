// PersonaMemoryModal —— per-agent 长期画像记忆
//
// 跨房间的 agent 角色记忆（user:<uid>:<agentRole> 为 key），由后端 orchestrator 在组 prompt 时注入
// 到该 agent 的 system message 里。
// 典型用途："Alex 是一个偏保守的架构师，上次我们约定过输出里不要出现 emoji"。
//
// 入口：MemberRail 展开态里，kind=agent 行会有一个 🧠 按钮；点开本 Modal，
// 可加载 / 编辑 / 保存 / 清空 / 向现有内容追加。
//
// 安全提示：长期记忆会喂给未来所有房间里的"同角色"agent。面板上明确展示 key，防止用户
// 误以为只影响当前房间。

import React, { useEffect, useState } from 'react';
import { getPersonaMemory, upsertPersonaMemory, deletePersonaMemory } from '../service';

interface Props {
  open: boolean;
  memoryKey: string;     // 例如 "user:42:architect"
  agentName: string;     // 显示用
  onClose: () => void;
}

const MAX = 8 * 1024;    // 与后端服务端上限对齐；超出服务端会截断

const PersonaMemoryModal: React.FC<Props> = ({ open, memoryKey, agentName, onClose }) => {
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    getPersonaMemory(memoryKey)
      .then(r => {
        setContent(r.content ?? '');
        setOriginal(r.content ?? '');
        setUpdatedAt(r.updatedAt ?? null);
      })
      .catch(() => {
        setContent('');
        setOriginal('');
        setUpdatedAt(null);
      })
      .finally(() => setLoading(false));
  }, [open, memoryKey]);

  const dirty = content !== original;
  const bytes = new TextEncoder().encode(content).length;
  const overBudget = bytes > MAX;

  const save = async (append = false) => {
    setSaving(true);
    try {
      const r = await upsertPersonaMemory(memoryKey, content, append);
      setContent(r.content ?? '');
      setOriginal(r.content ?? '');
      setUpdatedAt(r.updatedAt ?? null);
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!confirm(`清空 ${agentName} 的长期记忆？\n本操作会删除跨房间共享的画像，无法撤销。`)) return;
    await deletePersonaMemory(memoryKey);
    setContent('');
    setOriginal('');
    setUpdatedAt(null);
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
        className="relative w-full max-w-2xl max-h-[85vh] rounded-xl bg-surface border border-border mac-window-shadow overflow-hidden flex flex-col"
      >
        <div className="shrink-0 px-4 py-2.5 border-b border-border flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px] text-primary">psychology</span>
          <h2 className="text-[13px] font-semibold">{agentName} · 长期画像记忆</h2>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded hover:bg-surface-sunken flex items-center justify-center text-text-muted hover:text-text"
            title="关闭 (Esc)"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2 text-[12px]">
          <div className="px-2 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">
            <span className="material-symbols-outlined text-[13px] align-middle me-1">info</span>
            该记忆会喂给**所有房间**里的同角色 agent（memory key: <code className="px-1 rounded bg-black/10">{memoryKey}</code>）。
            不要写房间特定事实，那种应该用房间记忆；这里适合放长期约束、风格、偏好。
          </div>

          {loading ? (
            <div className="text-center text-[11px] text-text-muted py-4">加载中…</div>
          ) : (
            <>
              <textarea
                value={content}
                onChange={e => setContent(e.target.value)}
                rows={12}
                placeholder={`例：\n- 技术栈偏好：Go + PostgreSQL + SvelteKit\n- 输出风格：不要用 emoji，不要过度自信\n- 曾经吃过的亏：不要硬拆 HTTP monolith 之前先跑 profiler\n`}
                className={`w-full px-2 py-1.5 rounded font-mono text-[12px] border resize-y bg-surface ${
                  overBudget ? 'border-red-500/50' : 'border-border'
                }`}
              />
              <div className="flex items-center justify-between text-[10px] text-text-muted">
                <div>
                  {updatedAt ? `上次更新：${new Date(updatedAt).toLocaleString()}` : '尚未保存'}
                </div>
                <div className={overBudget ? 'text-red-500 font-semibold' : ''}>
                  {bytes.toLocaleString()} / {MAX.toLocaleString()} bytes
                  {overBudget && ' · 超出会被服务端截断'}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="shrink-0 px-3 py-2 border-t border-border flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={clear}
            disabled={!original || loading || saving}
            className="px-2.5 h-7 rounded text-[11px] text-text-muted hover:text-danger hover:bg-danger/10 disabled:opacity-40 disabled:pointer-events-none"
            title="清空所有长期记忆"
          >
            <span className="material-symbols-outlined text-[13px] align-middle me-1">delete_sweep</span>
            清空
          </button>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => save(true)}
              disabled={!content.trim() || loading || saving || overBudget}
              className="px-2.5 h-7 rounded text-[11px] font-semibold hover:bg-surface-sunken text-text-secondary disabled:opacity-40 disabled:pointer-events-none"
              title="把当前内容追加到现有记忆末尾而非覆盖"
            >
              追加保存
            </button>
            <button
              type="button"
              onClick={() => save(false)}
              disabled={!dirty || loading || saving || overBudget}
              className={`px-3 h-7 rounded text-[11px] font-semibold transition ${
                dirty && !saving && !overBudget
                  ? 'bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30'
                  : 'bg-surface-sunken text-text-muted cursor-not-allowed'
              }`}
            >
              {saving ? '保存中…' : dirty ? '覆盖保存' : '已保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PersonaMemoryModal;
