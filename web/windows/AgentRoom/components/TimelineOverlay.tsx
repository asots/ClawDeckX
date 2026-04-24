// 时间轴回放 / 干预审计叠加层
import React, { useMemo } from 'react';
import type { Member, Message, InterventionEvent } from '../types';
import { formatTime } from '../shared';

interface Props {
  messages: Message[];
  interventions: InterventionEvent[];
  members: Map<string, Member>;
  onJump: (messageId: string) => void;
  onFork: (messageId: string) => void;
  onClose: () => void;
}

const TimelineOverlay: React.FC<Props> = ({ messages, interventions, members, onJump, onFork, onClose }) => {
  const events = useMemo(() => {
    const all: { id: string; ts: number; kind: 'msg' | 'iv'; msg?: Message; iv?: InterventionEvent }[] = [];
    messages.forEach(m => all.push({ id: m.id, ts: m.timestamp, kind: 'msg', msg: m }));
    interventions.forEach(iv => all.push({ id: iv.id, ts: iv.at, kind: 'iv', iv }));
    all.sort((a, b) => a.ts - b.ts);
    return all;
  }, [messages, interventions]);

  if (events.length === 0) return null;

  const first = events[0].ts;
  const last = events[events.length - 1].ts;
  const span = Math.max(last - first, 1);

  const toolCount = messages.filter(m => m.kind === 'tool').length;
  const whisperCount = messages.filter(m => m.kind === 'whisper').length;
  const errorCount = messages.filter(m => m.kind === 'error').length;

  return (
    <div className="fixed inset-0 z-[9999] flex items-end justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-6xl max-h-[75vh] bg-surface rounded-2xl shadow-2xl border border-border flex flex-col overflow-hidden animate-slide-in-right">
        <div className="shrink-0 px-5 py-3 flex items-center gap-3 border-b border-border bg-gradient-to-r from-cyan-500/5 to-purple-500/5">
          <span className="material-symbols-outlined text-cyan-500">timeline</span>
          <div className="flex-1">
            <h3 className="text-[13px] font-bold">时间轴 · 回放与审计</h3>
            <div className="text-[11px] text-text-secondary flex items-center gap-3 flex-wrap">
              <span>{events.length} 个事件</span>
              <span className="inline-flex items-center gap-0.5"><span className="material-symbols-outlined text-[12px]">build</span>{toolCount} 工具</span>
              <span className="inline-flex items-center gap-0.5"><span className="material-symbols-outlined text-[12px]">lock</span>{whisperCount} 私聊</span>
              <span className="inline-flex items-center gap-0.5"><span className="material-symbols-outlined text-[12px]">back_hand</span>{interventions.length} 干预</span>
              {errorCount > 0 && <span className="inline-flex items-center gap-0.5 text-red-500"><span className="material-symbols-outlined text-[12px]">error</span>{errorCount} 错误</span>}
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-md hover:bg-surface-sunken flex items-center justify-center">
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {/* Overview bar */}
        <div className="shrink-0 px-5 py-3 border-b border-border">
          <div className="relative h-10 rounded-lg bg-surface-sunken overflow-hidden">
            {events.map(e => {
              const left = ((e.ts - first) / span) * 100;
              const cfg = e.kind === 'iv'
                ? { color: 'bg-amber-500', icon: 'back_hand' }
                : e.msg?.kind === 'tool' ? { color: 'bg-blue-500', icon: 'build' }
                : e.msg?.kind === 'whisper' ? { color: 'bg-purple-500', icon: 'lock' }
                : e.msg?.kind === 'error' ? { color: 'bg-red-500', icon: 'error' }
                : e.msg?.kind === 'bidding' ? { color: 'bg-amber-400', icon: 'gavel' }
                : { color: 'bg-cyan-400', icon: 'chat' };
              return (
                <div
                  key={e.id}
                  style={{ left: `${left}%` }}
                  className={`absolute top-1 bottom-1 w-1 -ms-0.5 rounded-full ${cfg.color} opacity-70 hover:opacity-100 cursor-pointer`}
                  title={`${formatTime(e.ts)} · ${cfg.icon}`}
                  onClick={() => e.msg && onJump(e.msg.id)}
                />
              );
            })}
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-text-muted font-mono">
            <span>{formatTime(first)}</span>
            <span>{formatTime(last)}</span>
          </div>
        </div>

        {/* Event list */}
        <div className="flex-1 min-h-0 overflow-y-auto neon-scrollbar p-3">
          <div className="space-y-1">
            {events.map(e => {
              if (e.kind === 'iv' && e.iv) {
                return (
                  <div key={e.id} className="flex items-center gap-3 p-2 rounded-lg bg-amber-500/5 border border-amber-500/20">
                    <span className="w-7 h-7 rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                      <span className="material-symbols-outlined text-[14px]">back_hand</span>
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-semibold text-text">{e.iv.label}</div>
                      <div className="text-[10.5px] text-text-muted">L{e.iv.level} · {formatTime(e.iv.at)}</div>
                    </div>
                  </div>
                );
              }
              const m = e.msg!;
              const author = members.get(m.actingAsId || m.authorId);
              const kindMeta = {
                chat: { icon: 'chat', color: 'text-cyan-500', bg: 'bg-cyan-500/10' },
                thinking: { icon: 'bubble_chart', color: 'text-cyan-500', bg: 'bg-cyan-500/10' },
                tool: { icon: 'build', color: 'text-blue-500', bg: 'bg-blue-500/10' },
                tool_approval: { icon: 'verified_user', color: 'text-amber-500', bg: 'bg-amber-500/10' },
                whisper: { icon: 'lock', color: 'text-purple-500', bg: 'bg-purple-500/10' },
                system: { icon: 'info', color: 'text-slate-500', bg: 'bg-slate-500/10' },
                error: { icon: 'error', color: 'text-red-500', bg: 'bg-red-500/10' },
                bidding: { icon: 'gavel', color: 'text-amber-500', bg: 'bg-amber-500/10' },
                projection_in: { icon: 'satellite_alt', color: 'text-blue-500', bg: 'bg-blue-500/10' },
                projection_out: { icon: 'satellite_alt', color: 'text-blue-500', bg: 'bg-blue-500/10' },
                impersonating: { icon: 'theater_comedy', color: 'text-amber-500', bg: 'bg-amber-500/10' },
                intervention: { icon: 'back_hand', color: 'text-amber-500', bg: 'bg-amber-500/10' },
                checkpoint: { icon: 'flag', color: 'text-slate-500', bg: 'bg-slate-500/10' },
              }[m.kind] || { icon: 'chat', color: 'text-cyan-500', bg: 'bg-cyan-500/10' };
              return (
                <div key={e.id} className="group flex items-start gap-2 p-2 rounded-lg hover:bg-surface-sunken transition-colors">
                  <span className={`w-7 h-7 rounded-md ${kindMeta.bg} ${kindMeta.color} flex items-center justify-center shrink-0`}>
                    <span className="material-symbols-outlined text-[14px]">{kindMeta.icon}</span>
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="font-semibold text-text">{author?.emoji} {author?.name || 'Unknown'}</span>
                      <span className="opacity-60 font-mono">{formatTime(m.timestamp)}</span>
                      {m.contentEdited && <span className="text-[10px] italic text-amber-500">(已编辑)</span>}
                    </div>
                    <div className="text-[11.5px] text-text-secondary truncate">
                      {m.kind === 'tool' ? <span className="font-mono">{m.toolName}</span> : m.content || '—'}
                    </div>
                  </div>
                  <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
                    <button
                      onClick={() => onJump(m.id)}
                      title="跳转到此消息"
                      className="w-7 h-7 rounded-md hover:bg-surface flex items-center justify-center"
                    >
                      <span className="material-symbols-outlined text-[14px]">north_east</span>
                    </button>
                    <button
                      onClick={() => onFork(m.id)}
                      title="从此处分叉"
                      className="w-7 h-7 rounded-md hover:bg-surface flex items-center justify-center"
                    >
                      <span className="material-symbols-outlined text-[14px]">fork_right</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TimelineOverlay;
