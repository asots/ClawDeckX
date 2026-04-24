// 右栏·白板（共享 Markdown）
import React, { useState, useEffect } from 'react';

interface Props {
  content: string;
  editorName?: string;       // 当前正在编辑的成员
  onChange: (c: string) => void;
}

const WhiteboardPanel: React.FC<Props> = ({ content, editorName, onChange }) => {
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [draft, setDraft] = useState(content);

  useEffect(() => {
    if (mode === 'preview') setDraft(content);
  }, [content, mode]);

  return (
    <div>
      <div className="flex items-center gap-1 mb-2 p-0.5 rounded-lg bg-surface-sunken">
        <button
          onClick={() => setMode('preview')}
          className={`flex-1 h-6 rounded-md text-[11px] font-semibold transition-all ${mode === 'preview' ? 'bg-surface shadow-sm text-text' : 'text-text-secondary hover:text-text'}`}
        >
          预览
        </button>
        <button
          onClick={() => setMode('edit')}
          className={`flex-1 h-6 rounded-md text-[11px] font-semibold transition-all ${mode === 'edit' ? 'bg-surface shadow-sm text-text' : 'text-text-secondary hover:text-text'}`}
        >
          编辑
        </button>
      </div>

      {editorName && mode !== 'edit' && (
        <div className="mb-2 inline-flex items-center gap-1 px-1.5 h-5 rounded-md bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 text-[10px] font-semibold">
          <span className="material-symbols-outlined text-[11px] animate-pulse">edit</span>
          {editorName} 正在编辑
        </div>
      )}

      {mode === 'edit' ? (
        <div>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={12}
            className="w-full px-2 py-1.5 rounded-lg bg-surface border border-border sci-input font-mono text-[11px] leading-relaxed text-text resize-none"
            placeholder="# 在此输入 Markdown..."
          />
          <div className="flex gap-1 mt-1.5">
            <button
              onClick={() => { onChange(draft); setMode('preview'); }}
              className="flex-1 h-7 rounded-md text-[11px] font-bold bg-primary text-white hover:bg-primary/90"
            >
              保存
            </button>
            <button
              onClick={() => { setDraft(content); setMode('preview'); }}
              className="flex-1 h-7 rounded-md text-[11px] font-semibold bg-surface hover:bg-surface-sunken border border-border"
            >
              取消
            </button>
          </div>
        </div>
      ) : content ? (
        <div className="markdown-body text-[11px] text-text leading-relaxed p-2 rounded-lg bg-surface-sunken border border-border max-h-80 overflow-y-auto neon-scrollbar whitespace-pre-wrap font-sans">
          {renderLightMarkdown(content)}
        </div>
      ) : (
        <div className="px-2 py-4 text-center">
          <span className="material-symbols-outlined text-[24px] text-text-muted opacity-40">draw</span>
          <p className="text-[11px] text-text-muted mt-1.5">白板为空</p>
          <button
            onClick={() => setMode('edit')}
            className="mt-2 px-2.5 h-6 rounded-md text-[10px] font-semibold bg-surface hover:bg-surface-raised border border-border text-text"
          >
            开始书写
          </button>
        </div>
      )}
    </div>
  );
};

// 极简 Markdown 渲染（仅 MVP，避免引入 react-markdown 依赖）
function renderLightMarkdown(md: string): React.ReactNode {
  const lines = md.split('\n');
  return lines.map((line, i) => {
    if (line.startsWith('# ')) return <div key={i} className="text-[13px] font-bold mt-1.5 mb-0.5">{line.slice(2)}</div>;
    if (line.startsWith('## ')) return <div key={i} className="text-[12px] font-bold mt-1 mb-0.5">{line.slice(3)}</div>;
    if (line.startsWith('### ')) return <div key={i} className="text-[11.5px] font-semibold mt-1">{line.slice(4)}</div>;
    if (line.startsWith('- [ ] ')) return <div key={i} className="flex gap-1 ms-2"><span>☐</span><span>{line.slice(6)}</span></div>;
    if (line.startsWith('- [x] ')) return <div key={i} className="flex gap-1 ms-2 opacity-60 line-through"><span>☑</span><span>{line.slice(6)}</span></div>;
    if (line.startsWith('- ')) return <div key={i} className="flex gap-1 ms-2"><span className="text-cyan-500">•</span><span>{line.slice(2)}</span></div>;
    if (line.trim() === '') return <div key={i} className="h-2" />;
    return <div key={i}>{line}</div>;
  });
}

export default WhiteboardPanel;
