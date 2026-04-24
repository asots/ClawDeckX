// PlaybookEditor —— v0.7 结构化经验卡编辑器
//
// 编辑 PlaybookV7 的全部字段：
//   - 标题 / 分类 / tags / appliesTo（模板 id 或关键词）
//   - Problem / Approach / Conclusion 三大段（支持 markdown 预览切换）
//   - Steps（可勾选的检查项，支持添加/删除/重排）
//   - 收藏开关
//   - 使用血缘（UsageCount / AppliedRooms）只读显示
//
// 保存：调 updatePlaybookV7，version 自动 +1。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PlaybookHighlightContext, PlaybookV7, PlaybookStep } from '../types';
import { getPlaybookV7, updatePlaybookV7, togglePlaybookFavorite } from '../service';
import MarkdownView from './MarkdownView';

interface Props {
  playbookId: string;
  highlightContext?: PlaybookHighlightContext | null;
  onClose: () => void;
  onSaved?: (p: PlaybookV7) => void;
}

const PlaybookEditor: React.FC<Props> = ({ playbookId, highlightContext, onClose, onSaved }) => {
  const [loading, setLoading] = useState(true);
  const [p, setP] = useState<PlaybookV7 | null>(null);
  const [draft, setDraft] = useState<PlaybookV7 | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewSection, setPreviewSection] = useState<null | 'problem' | 'approach' | 'conclusion'>(null);

  useEffect(() => {
    setLoading(true);
    getPlaybookV7(playbookId).then(r => {
      setP(r);
      setDraft(r ? JSON.parse(JSON.stringify(r)) : null);
    }).finally(() => setLoading(false));
  }, [playbookId]);

  const dirty = useMemo(() => {
    if (!p || !draft) return false;
    return JSON.stringify(p) !== JSON.stringify(draft);
  }, [p, draft]);

  const save = async () => {
    if (!draft || !dirty || saving) return;
    setSaving(true);
    try {
      const updated = await updatePlaybookV7(draft.id, {
        title: draft.title,
        problem: draft.problem,
        approach: draft.approach,
        conclusion: draft.conclusion,
        category: draft.category,
        tags: draft.tags,
        appliesTo: draft.appliesTo,
        steps: draft.steps,
        isFavorite: draft.isFavorite,
      });
      setP(updated);
      setDraft(JSON.parse(JSON.stringify(updated)));
      if (onSaved) onSaved(updated);
    } finally { setSaving(false); }
  };

  const toggleFav = async () => {
    if (!draft) return;
    const next = !draft.isFavorite;
    setDraft({ ...draft, isFavorite: next });
    try {
      const fresh = await togglePlaybookFavorite(draft.id);
      setP(fresh);
      setDraft(d => d ? ({ ...d, isFavorite: fresh.isFavorite }) : d);
    } catch { /* 保留本地乐观值 */ }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="text-[12px] text-white">加载 Playbook…</div>
      </div>
    );
  }

  if (!p || !draft) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        onClick={onClose}>
        <div className="sci-card p-6 rounded-xl bg-surface-overlay border border-border text-[12px] text-text-muted">
          Playbook 不存在或无权访问。
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
      role="dialog" aria-modal="true" aria-label="Playbook 编辑器"
    >
      <div
        className="sci-card w-[min(880px,96vw)] max-h-[92vh] overflow-hidden bg-surface-overlay border border-border rounded-xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex items-center gap-2 bg-gradient-to-r from-indigo-500/10 via-purple-500/5 to-transparent">
          <span className="material-symbols-outlined text-[20px] text-indigo-500">menu_book</span>
          <div className="flex-1 min-w-0">
            <input
              value={draft.title}
              onChange={e => setDraft({ ...draft, title: e.target.value })}
              placeholder="Playbook 标题"
              className="sci-input w-full h-8 px-2 rounded text-[13.5px] font-bold bg-transparent border-0 border-b border-transparent focus:border-indigo-500 transition"
            />
            <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-text-muted font-mono">
              <span>v{p.version}</span>
              <span>· 使用 {p.usageCount} 次</span>
              {p.sourceRoomId && <span>· 源房间 {p.sourceRoomId.slice(-8)}</span>}
              <span>· 更新 {new Date(p.updatedAt).toLocaleString()}</span>
            </div>
          </div>
          <button type="button" onClick={toggleFav}
            className={`w-8 h-8 rounded-md flex items-center justify-center transition ${
              draft.isFavorite ? 'text-amber-500 bg-amber-500/10 hover:bg-amber-500/20' : 'text-text-muted hover:bg-surface-sunken'
            }`}
            title={draft.isFavorite ? '取消收藏' : '收藏'}>
            <span className="material-symbols-outlined text-[18px]">{draft.isFavorite ? 'star' : 'star_outline'}</span>
          </button>
          <button onClick={onClose}
            className="w-8 h-8 rounded-md hover:bg-surface-sunken text-text-muted hover:text-text transition"
            aria-label="关闭">
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto neon-scrollbar p-4 space-y-4">
          {highlightContext && (
            <div className="rounded-lg border border-violet-500/25 bg-violet-500/8 px-3 py-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[16px] text-violet-500">flare</span>
                <div className="text-[12px] font-semibold text-text">本次复盘强化内容</div>
                <span className="text-[10px] text-text-muted font-mono">{highlightContext.source}</span>
              </div>
              {highlightContext.roomTitle ? (
                <div className="text-[11px] text-text-secondary">来源房间：{highlightContext.roomTitle}</div>
              ) : null}
              {highlightContext.summary ? (
                <div className="text-[11.5px] text-text-secondary leading-relaxed">
                  <span className="text-[10px] font-semibold text-text-muted">摘要 · </span>
                  {highlightContext.summary}
                </div>
              ) : null}
              {!!highlightContext.highlights?.length && (
                <div>
                  <div className="text-[10px] font-semibold text-text-muted mb-1">新保留项</div>
                  <ul className="space-y-1">
                    {highlightContext.highlights.map((item, idx) => (
                      <li key={`hi-${idx}`} className="text-[11px] text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-2 py-1">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!!highlightContext.lowlights?.length && (
                <div>
                  <div className="text-[10px] font-semibold text-text-muted mb-1">新规避项</div>
                  <ul className="space-y-1">
                    {highlightContext.lowlights.map((item, idx) => (
                      <li key={`lo-${idx}`} className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-md px-2 py-1">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!!highlightContext.nextAgendaItems?.length && (
                <div>
                  <div className="text-[10px] font-semibold text-text-muted mb-1">新增下次会议步骤</div>
                  <ul className="space-y-1">
                    {highlightContext.nextAgendaItems.map((item, idx) => (
                      <li key={`next-${idx}`} className="text-[11px] text-cyan-700 dark:text-cyan-300 bg-cyan-500/10 border border-cyan-500/20 rounded-md px-2 py-1">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* meta row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="分类">
              <input value={draft.category || ''}
                onChange={e => setDraft({ ...draft, category: e.target.value })}
                placeholder="例：产品评审 / 事故复盘"
                className="sci-input w-full h-8 px-2 rounded-md text-[12px] bg-surface border border-border"
              />
            </Field>
            <Field label="标签（回车添加）">
              <TokenInput value={draft.tags} onChange={tags => setDraft({ ...draft, tags })} placeholder="如：产品、架构、风险" />
            </Field>
          </div>
          <Field label="适用场景（模板 ID / 关键词，命中则在新建房间时自动推荐）">
            <TokenInput value={draft.appliesTo} onChange={appliesTo => setDraft({ ...draft, appliesTo })}
              placeholder="例：product-review、定价、上线"
            />
          </Field>

          {/* 三大段 */}
          <SectionEditor
            title="❓ Problem · 解决什么问题" field="problem"
            value={draft.problem}
            onChange={v => setDraft({ ...draft, problem: v })}
            previewing={previewSection === 'problem'}
            onTogglePreview={() => setPreviewSection(previewSection === 'problem' ? null : 'problem')}
          />
          <SectionEditor
            title="🛠️ Approach · 怎么做" field="approach"
            value={draft.approach}
            onChange={v => setDraft({ ...draft, approach: v })}
            previewing={previewSection === 'approach'}
            onTogglePreview={() => setPreviewSection(previewSection === 'approach' ? null : 'approach')}
          />
          <SectionEditor
            title="🎯 Conclusion · 得到什么结论" field="conclusion"
            value={draft.conclusion}
            onChange={v => setDraft({ ...draft, conclusion: v })}
            previewing={previewSection === 'conclusion'}
            onTogglePreview={() => setPreviewSection(previewSection === 'conclusion' ? null : 'conclusion')}
          />

          {/* Steps */}
          <StepsEditor
            steps={draft.steps}
            onChange={steps => setDraft({ ...draft, steps })}
          />

          {/* Applied rooms (只读血缘) */}
          {p.appliedRooms.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[11px] text-text-muted hover:text-text select-none">
                使用血缘：曾被 {p.appliedRooms.length} 个房间注入过
              </summary>
              <ul className="mt-1.5 flex flex-wrap gap-1">
                {p.appliedRooms.map(rid => (
                  <li key={rid} className="px-1.5 py-[2px] rounded-md bg-surface-sunken text-[10.5px] font-mono text-text-muted">
                    {rid}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-2 bg-surface">
          <div className="text-[10.5px] text-text-muted">
            {dirty ? '有未保存的改动' : '已是最新'}
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={onClose}
              className="h-8 px-3 rounded-md text-[12px] border border-border text-text-muted hover:bg-surface-sunken">
              关闭
            </button>
            <button type="button" onClick={save} disabled={!dirty || saving}
              className="h-8 px-4 rounded-md text-[12px] font-semibold bg-indigo-500 hover:bg-indigo-600 text-white disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1">
              <span className={`material-symbols-outlined text-[14px] ${saving ? 'animate-spin' : ''}`}>
                {saving ? 'progress_activity' : 'save'}
              </span>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Field wrapper ───
const Field: React.FC<React.PropsWithChildren<{ label: string }>> = ({ label, children }) => (
  <div>
    <div className="text-[10.5px] text-text-muted mb-1">{label}</div>
    {children}
  </div>
);

// ─── Tag 输入（回车添加，点 × 删除） ───
const TokenInput: React.FC<{
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}> = ({ value, onChange, placeholder }) => {
  const [buf, setBuf] = useState('');
  const add = () => {
    const t = buf.trim();
    if (!t) return;
    if (value.includes(t)) { setBuf(''); return; }
    onChange([...value, t]);
    setBuf('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1 px-1.5 py-1 rounded-md bg-surface border border-border min-h-[32px]">
      {value.map(t => (
        <span key={t} className="inline-flex items-center gap-0.5 h-6 px-1.5 rounded-full bg-indigo-500/15 text-[11px] text-indigo-700 dark:text-indigo-200">
          {t}
          <button type="button" onClick={() => onChange(value.filter(x => x !== t))}
            className="w-4 h-4 rounded-full hover:bg-indigo-500/30 flex items-center justify-center">
            <span className="material-symbols-outlined text-[11px]">close</span>
          </button>
        </span>
      ))}
      <input
        value={buf}
        onChange={e => setBuf(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); add(); }
          else if (e.key === 'Backspace' && !buf && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        placeholder={value.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[120px] h-6 px-1 bg-transparent text-[11.5px] outline-none"
      />
    </div>
  );
};

// ─── 三大段编辑器（markdown + 预览切换） ───
const SectionEditor: React.FC<{
  title: string;
  field: 'problem' | 'approach' | 'conclusion';
  value: string;
  onChange: (v: string) => void;
  previewing: boolean;
  onTogglePreview: () => void;
}> = ({ title, value, onChange, previewing, onTogglePreview }) => {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <div className="text-[12px] font-semibold text-text">{title}</div>
        <button type="button" onClick={onTogglePreview}
          className={`ms-auto h-6 px-2 rounded text-[10.5px] border border-border ${previewing ? 'bg-surface-sunken text-text' : 'text-text-muted hover:bg-surface-sunken'}`}>
          {previewing ? '编辑' : '预览'}
        </button>
      </div>
      {previewing ? (
        <div className="px-3 py-2 rounded-md bg-surface border border-border min-h-[72px]">
          {value.trim() ? <MarkdownView content={value} /> : <span className="text-[11px] text-text-muted">（空）</span>}
        </div>
      ) : (
        <textarea
          ref={taRef}
          value={value}
          onChange={e => onChange(e.target.value)}
          rows={5}
          placeholder="支持 markdown …"
          className="sci-input w-full p-2 rounded-md text-[12px] bg-surface border border-border resize-y leading-relaxed font-mono"
        />
      )}
    </div>
  );
};

// ─── Steps 编辑器 ───
const StepsEditor: React.FC<{
  steps: PlaybookStep[];
  onChange: (steps: PlaybookStep[]) => void;
}> = ({ steps, onChange }) => {
  const [buf, setBuf] = useState('');
  const add = () => {
    const t = buf.trim();
    if (!t) return;
    onChange([...steps, { id: `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, text: t }]);
    setBuf('');
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const patch = (i: number, p: Partial<PlaybookStep>) => {
    const next = steps.map((s, ix) => ix === i ? { ...s, ...p } : s);
    onChange(next);
  };
  const remove = (i: number) => onChange(steps.filter((_, ix) => ix !== i));

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[12px] font-semibold text-text">🪜 步骤清单（可勾选）</div>
        <span className="text-[10.5px] text-text-muted">{steps.length} 步</span>
      </div>

      {steps.length === 0 && (
        <div className="px-2 py-3 text-[11px] text-text-muted text-center border border-dashed border-border rounded-md">
          还没有步骤。可以把 Approach 里的动作拆成可勾选的 checklist，便于下次复用。
        </div>
      )}

      <ul className="space-y-1">
        {steps.map((s, i) => (
          <li key={s.id}
            className="group flex items-start gap-1.5 px-2 py-1.5 rounded-md bg-surface border border-border hover:bg-surface-sunken/40 transition">
            <button type="button" onClick={() => patch(i, { checked: !s.checked })}
              className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 mt-[1px] ${
                s.checked ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border hover:border-emerald-500'
              }`}>
              {s.checked && <span className="material-symbols-outlined text-[13px]">check</span>}
            </button>
            <div className="flex-1 min-w-0">
              <input value={s.text}
                onChange={e => patch(i, { text: e.target.value })}
                className={`sci-input w-full h-7 px-1.5 bg-transparent border-0 border-b border-transparent focus:border-indigo-500 text-[12px] ${s.checked ? 'line-through text-text-muted' : 'text-text'}`}
              />
              <input value={s.note || ''}
                onChange={e => patch(i, { note: e.target.value })}
                placeholder="备注（可选）"
                className="sci-input w-full h-6 px-1.5 bg-transparent border-0 text-[10.5px] text-text-muted"
              />
            </div>
            <div className="flex flex-col items-center gap-0.5 opacity-0 group-hover:opacity-100 transition shrink-0">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                className="w-6 h-6 rounded hover:bg-surface-sunken disabled:opacity-30"
                title="上移"><span className="material-symbols-outlined text-[12px]">arrow_upward</span></button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === steps.length - 1}
                className="w-6 h-6 rounded hover:bg-surface-sunken disabled:opacity-30"
                title="下移"><span className="material-symbols-outlined text-[12px]">arrow_downward</span></button>
            </div>
            <button type="button" onClick={() => remove(i)}
              className="w-6 h-6 rounded hover:bg-danger/10 text-text-muted hover:text-danger flex items-center justify-center opacity-0 group-hover:opacity-100 transition shrink-0"
              title="删除"><span className="material-symbols-outlined text-[13px]">close</span></button>
          </li>
        ))}
      </ul>

      <div className="mt-1.5 flex items-center gap-1.5">
        <input value={buf}
          onChange={e => setBuf(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="+ 添加步骤…"
          className="sci-input flex-1 h-7 px-2 rounded-md text-[12px] bg-surface border border-border"
        />
        <button type="button" onClick={add} disabled={!buf.trim()}
          className="h-7 px-2 rounded-md text-[11.5px] font-semibold bg-indigo-500 hover:bg-indigo-600 text-white disabled:opacity-50 inline-flex items-center gap-1">
          <span className="material-symbols-outlined text-[13px]">add</span>
        </button>
      </div>
    </div>
  );
};

export default PlaybookEditor;
