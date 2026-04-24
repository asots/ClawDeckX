// MarkdownView —— AgentRoom 消息的 Markdown 渲染器。
// 使用已存在的 react-markdown + remark-gfm；通过 Tailwind prose 风格 + 自定义
// 元素映射。代码块用 <pre><code> + class="hljs" 占位，后续可以接入真正的高亮。
// 安全：react-markdown 默认不渲染原始 HTML；我们也没有启用 rehype-raw。
//
// v0.9.1：代码块右上角叠一个"复制"按钮。AI 产出的代码片段几乎都需要被用户
// 取走到 IDE / 终端，没有复制按钮的话用户要手动选择一大段，体验很糟。
// 样式参考 Sessions.tsx 里 Markdown 代码块的复制按钮（右上角、hover 显形、
// 点击后变 check 2s）。
import React, { useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DOMPurify from 'dompurify';

interface Props {
  content: string;
  className?: string;
}

// 清洗：把可能的 <script>/<iframe> 提前滤掉，即便上游不启用 raw HTML 也做一层防御。
function sanitize(s: string): string {
  return DOMPurify.sanitize(s, { USE_PROFILES: { html: false } });
}

// 代码块复制：从渲染后的 <pre> 里读 textContent。比在渲染阶段尝试序列化 React
// children 更鲁棒——无论上游是字符串还是嵌套的 span 都能拿到原始文本。
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// CodeBlock —— 带复制按钮的代码块容器；是 Markdown `pre` 元素的替换组件。
// hover 显形 + 点击后 2s 内图标变 check 表示已复制；不依赖外部 toast（Markdown
// 可能在纯展示场景出现，保持组件内置反馈最稳妥）。
const CodeBlock: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    const text = preRef.current?.innerText ?? '';
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="relative group/code my-2">
      <pre
        ref={preRef}
        className="p-3 rounded-lg bg-slate-900 text-slate-100 text-[12px] overflow-x-auto neon-scrollbar font-mono border border-cyan-400/20"
      >
        {children}
      </pre>
      <button
        onClick={handleCopy}
        title={copied ? '已复制' : '复制代码'}
        aria-label="复制代码块"
        className="absolute top-1.5 end-1.5 inline-flex items-center gap-1 px-1.5 h-6 rounded-md text-[10px] font-semibold bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-600/50 opacity-0 group-hover/code:opacity-100 transition-opacity backdrop-blur-sm"
      >
        <span className={`material-symbols-outlined text-[13px] ${copied ? 'text-emerald-400' : ''}`}>
          {copied ? 'check' : 'content_copy'}
        </span>
        <span className="hidden sm:inline">{copied ? '已复制' : '复制'}</span>
      </button>
    </div>
  );
};

const MarkdownView: React.FC<Props> = ({ content, className = '' }) => {
  const safe = useMemo(() => sanitize(content || ''), [content]);
  return (
    <div className={`agentroom-md text-[13px] leading-relaxed text-text break-words ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 段落：让节奏更紧凑
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          // 链接：外链新开；加下划线
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-500 dark:text-cyan-400 underline underline-offset-2 hover:text-cyan-600"
            >
              {children}
            </a>
          ),
          // 内联代码
          code: ({ className, children, ...props }) => {
            // react-markdown 的 code 组件既处理块级也处理内联；区分 inline 看是否有 className="language-xxx"
            const isBlock = /language-/.test(className || '');
            if (!isBlock) {
              return (
                <code
                  className="px-1 py-0.5 rounded bg-surface-sunken border border-border text-[12px] font-mono text-cyan-600 dark:text-cyan-300"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            const lang = (className || '').replace('language-', '') || 'text';
            return (
              <code
                className={`${className} text-[12px] font-mono block whitespace-pre overflow-x-auto`}
                data-lang={lang}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-2 p-3 rounded-lg bg-slate-900 text-slate-100 text-[12px] overflow-x-auto neon-scrollbar font-mono border border-cyan-400/20">
              {children}
            </pre>
          ),
          ul: ({ children }) => <ul className="my-1.5 ps-5 list-disc space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="my-1.5 ps-5 list-decimal space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          h1: ({ children }) => <h1 className="text-[16px] font-bold mt-2 mb-1.5">{children}</h1>,
          h2: ({ children }) => <h2 className="text-[15px] font-bold mt-2 mb-1.5">{children}</h2>,
          h3: ({ children }) => <h3 className="text-[14px] font-bold mt-1.5 mb-1">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="my-1.5 ps-3 border-s-2 border-cyan-400/40 text-text-secondary italic">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-2 border-border" />,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="text-[12px] border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="px-2 py-1 border border-border bg-surface-sunken font-semibold text-start">{children}</th>,
          td: ({ children }) => <td className="px-2 py-1 border border-border">{children}</td>,
        }}
      >
        {safe}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownView;
