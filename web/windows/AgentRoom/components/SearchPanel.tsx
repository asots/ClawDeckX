// 房间内消息搜索面板（FTS5）。
// 输入即搜（250ms 防抖）；点击结果回调 onJump(messageId) 让外层滚动 + 高亮。
import React, { useEffect, useMemo, useState } from 'react';
import type { Member, Message } from '../types';
import { searchMessages } from '../service';
import { MemberAvatar, formatTime } from '../shared';

interface Props {
  roomId: string;
  members: Map<string, Member>;
  onJump: (messageId: string) => void;
  onClose: () => void;
}

const SearchPanel: React.FC<Props> = ({ roomId, members, onJump, onClose }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [debounced, setDebounced] = useState('');

  // 防抖
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!debounced) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    searchMessages(roomId, debounced, 50)
      .then(r => {
        if (!cancelled) setResults(r);
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [roomId, debounced]);

  const highlight = useMemo(() => {
    const q = debounced.toLowerCase();
    if (!q) return null;
    const tokens = q.split(/\s+/).filter(Boolean);
    return (text: string) => {
      if (!tokens.length) return text;
      // 最简单：按第一个 token 分割高亮
      const re = new RegExp(`(${tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
      const parts = text.split(re);
      return parts.map((p, i) => (
        re.test(p)
          ? <mark key={i} className="bg-amber-300/50 text-text rounded px-0.5">{p}</mark>
          : <React.Fragment key={i}>{p}</React.Fragment>
      ));
    };
  }, [debounced]);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center p-4 pt-16" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" />
      <div
        className="relative w-full max-w-xl bg-surface-overlay backdrop-blur-md rounded-xl border border-border shadow-2xl flex flex-col max-h-[70vh] animate-card-enter"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <span className="material-symbols-outlined text-[18px] text-cyan-500">search</span>
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
            placeholder="房间内搜索（支持关键词、短语、AND / OR）"
            className="flex-1 bg-transparent outline-none text-[13px] text-text placeholder-text-muted"
          />
          {loading && <span className="material-symbols-outlined text-[14px] text-text-muted animate-spin-slow">sync</span>}
          <button
            onClick={onClose}
            className="w-6 h-6 rounded-md hover:bg-surface-sunken flex items-center justify-center text-text-muted"
            aria-label="关闭"
          >
            <span className="material-symbols-outlined text-[14px]">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto neon-scrollbar">
          {debounced === '' ? (
            <div className="p-6 text-center text-[12px] text-text-muted">
              输入关键词开始搜索 · <kbd className="px-1.5 py-0.5 rounded bg-surface-sunken border border-border text-[11px]">Esc</kbd> 关闭
            </div>
          ) : results.length === 0 && !loading ? (
            <div className="p-6 text-center text-[12px] text-text-muted">
              没有找到匹配的消息
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {results.map(m => {
                const author = members.get(m.authorId);
                return (
                  <li key={m.id}>
                    <button
                      onClick={() => { onJump(m.id); onClose(); }}
                      className="w-full px-3 py-2 text-start hover:bg-surface-sunken flex items-start gap-2"
                    >
                      {author ? (
                        <MemberAvatar member={author} size="xs" showStatus={false} />
                      ) : (
                        <span className="w-6 h-6 rounded-lg bg-surface-sunken flex items-center justify-center text-[11px]">·</span>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
                          <span className="font-semibold text-text">{author?.name || m.authorId}</span>
                          <span className="opacity-70">·</span>
                          <span className="font-mono">{formatTime(m.timestamp)}</span>
                          {m.kind !== 'chat' && (
                            <>
                              <span className="opacity-70">·</span>
                              <span className="uppercase text-[9px] opacity-70">{m.kind}</span>
                            </>
                          )}
                        </div>
                        <div className="text-[12.5px] text-text leading-snug line-clamp-3 mt-0.5 break-words">
                          {highlight ? highlight(m.content) : m.content}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-border text-[10px] text-text-muted flex items-center justify-between">
          <span>{debounced ? `${results.length} 条结果` : ''}</span>
          <span>
            <kbd className="px-1 py-0.5 rounded bg-surface-sunken border border-border text-[10px]">Enter</kbd> 跳转 ·
            <kbd className="ms-1 px-1 py-0.5 rounded bg-surface-sunken border border-border text-[10px]">Esc</kbd> 关闭
          </span>
        </div>
      </div>
    </div>
  );
};

export default SearchPanel;
