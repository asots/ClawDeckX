import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const MAX_RENDER_CHARS = 50_000;

interface MarkdownRendererProps {
  content: string;
  streaming?: boolean;
  className?: string;
  labels?: { copyCode?: string };
}

const CodeBlock: React.FC<{ lang?: string; code: string; copyLabel?: string }> = ({ lang, code, copyLabel }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="relative group/code my-2 sci-card rounded-xl overflow-hidden">
      {lang && (
        <div className="absolute top-1.5 start-2 z-10">
          <span className="text-[8px] font-bold uppercase tracking-wider text-white/25 dark:text-[var(--color-neon-cyan)]/50 select-none">{lang}</span>
        </div>
      )}
      <div className="absolute top-1.5 end-1.5 opacity-0 group-hover/code:opacity-100 transition z-10">
        <button
          onClick={handleCopy}
          className="text-[9px] px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white/60 transition sci-badge cursor-pointer select-none"
        >
          {copied ? '✓' : (copyLabel || 'Copy')}
        </button>
      </div>
      <pre className="bg-slate-900 dark:bg-black/30 rounded-xl p-3 text-[10px] font-mono text-slate-100 overflow-auto max-h-[60vh]">
        <code>{code}</code>
      </pre>
    </div>
  );
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, streaming, className, labels }) => {
  const [renderError, setRenderError] = useState(false);

  const sanitized = useMemo(() => {
    let text = content;
    if (text.length > MAX_RENDER_CHARS) {
      text = text.slice(0, MAX_RENDER_CHARS) + '\n\n… (truncated)';
    }
    // Strip dangerous HTML tags but preserve newlines and whitespace.
    // DOMPurify.sanitize() treats input as HTML which collapses \n characters.
    // Use RETURN_DOM=false and ADD_TAGS to keep <br>, or just strip raw HTML
    // tags while preserving markdown structure for ReactMarkdown to handle safely.
    return text.replace(/<script[\s>][\s\S]*?<\/script>/gi, '')
               .replace(/<style[\s>][\s\S]*?<\/style>/gi, '')
               .replace(/<iframe[\s>][\s\S]*?<\/iframe>/gi, '')
               .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
               .replace(/javascript\s*:/gi, '');
  }, [content]);

  if (renderError) {
    return <pre className="text-[11px] whitespace-pre-wrap break-words text-text">{content}</pre>;
  }

  try {
    return (
      <div className={`markdown-body text-[11px] leading-relaxed ${className ?? ''}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ className: cn, children }) {
              const lang = /language-(\w+)/.exec(cn || '')?.[1];
              const codeStr = String(children).replace(/\n$/, '');
              const isInline = !cn && !codeStr.includes('\n');
              if (!isInline) {
                return <CodeBlock lang={lang} code={codeStr} copyLabel={labels?.copyCode} />;
              }
              return (
                <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-white/10 dark:text-[var(--color-neon-cyan)]/80 text-[10px] font-mono">
                  {children}
                </code>
              );
            },
            a({ href, children }) {
              return (
                <a href={href} target="_blank" rel="noreferrer noopener"
                  className="text-primary hover:underline">
                  {children}
                </a>
              );
            },
            table({ children }) {
              return (
                <div className="overflow-x-auto my-2 sci-card rounded-lg">
                  <table className="min-w-full text-[10px] border-collapse border border-slate-200 dark:border-white/10 rounded-lg overflow-hidden">
                    {children}
                  </table>
                </div>
              );
            },
            th({ children }) {
              return <th className="px-2 py-1 bg-slate-50 dark:bg-white/5 font-bold text-start border-b border-slate-200 dark:border-[var(--color-neon-cyan)]/15">{children}</th>;
            },
            td({ children }) {
              return <td className="px-2 py-1 border-b border-slate-100 dark:border-white/5">{children}</td>;
            },
            img({ src, alt }) {
              if (src && !src.startsWith('data:image/')) return null;
              return <img src={src} alt={alt || ''} className="max-w-xs rounded-lg my-1" loading="lazy" />;
            },
          }}
        >
          {sanitized}
        </ReactMarkdown>
        {streaming && <span className="inline-block text-primary/70 animate-cursor-blink ms-0.5 align-text-bottom font-mono select-none" aria-hidden>▊</span>}
      </div>
    );
  } catch {
    setRenderError(true);
    return <pre className="text-[11px] whitespace-pre-wrap break-words text-text">{content}</pre>;
  }
};
