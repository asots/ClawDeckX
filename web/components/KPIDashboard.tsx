import React from 'react';
import { MiniDonut, MiniGauge, MiniSparkline } from './MiniChart';

interface KPIDashboardProps {
  stats: {
    totalTok: number; totalIn: number; totalOut: number;
    active24h: number; abortedCount: number; avgTok: number; channels: number;
  };
  sessions: Record<string, any>[];
  labels: Record<string, string>;
  costTrend?: Array<{ date: string; totalCost: number }>;
  usageAggregates?: any;
}

const fmtTok = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

const MSG_COLORS = { user: '#3b82f6', assistant: '#10b981', tools: '#a855f7', errors: '#ef4444' };
const CHANNEL_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#6366f1'];
const kpiCard = 'rounded-2xl p-3 shadow-sm sci-card';
const kpiLabel = 'text-[11px] font-bold text-slate-400 dark:text-white/30 uppercase mb-1.5';

export const KPIDashboard: React.FC<KPIDashboardProps> = ({ stats, sessions, labels: a, costTrend, usageAggregates: agg }) => {
  // Channel distribution
  const channelCounts: Record<string, number> = {};
  sessions.forEach(s => {
    const ch = s.lastChannel || (a.unknown || 'unknown');
    channelCounts[ch] = (channelCounts[ch] || 0) + 1;
  });
  const channelEntries = Object.entries(channelCounts);

  // Activity sparkline (last 7 days)
  const now = Date.now();
  const activityValues = Array.from({ length: 7 }, (_, i) => {
    const dayStart = now - (6 - i) * 86_400_000;
    const dayEnd = dayStart + 86_400_000;
    return sessions.filter(s => s.updatedAt >= dayStart && s.updatedAt < dayEnd).length;
  });

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 mb-4">
      {/* Token Distribution */}
      <div className={kpiCard}>
        <div className={kpiLabel}>{a.totalTokens || 'Tokens'}</div>
        <div className="flex items-center gap-2">
          <MiniDonut size={44} slices={[
            { value: stats.totalIn, color: '#3b82f6' },
            { value: stats.totalOut, color: '#f59e0b' },
          ]} innerRadius={0.5} />
          <div>
            <div className="text-base font-extrabold text-slate-800 dark:text-white/85 tabular-nums leading-none text-glow-cyan">{fmtTok(stats.totalTok)}</div>
            <div className="text-[10px] text-slate-400 dark:text-white/25">
              <span className="text-blue-500">●</span> {a.input || 'In'} <span className="text-amber-500">●</span> {a.output || 'Out'}
            </div>
          </div>
        </div>
      </div>

      {/* 24h Active */}
      <div className={kpiCard}>
        <div className={kpiLabel}>{a.active24h || '24h Active'}</div>
        <div className="flex items-center gap-2">
          <span className="relative flex h-3 w-3">
            {stats.active24h > 0 && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />}
            <span className={`relative inline-flex rounded-full h-3 w-3 ${stats.active24h > 0 ? 'bg-green-500' : 'bg-slate-300 dark:bg-white/20'}`} />
          </span>
          <span className="text-base font-extrabold text-slate-800 dark:text-white/85 tabular-nums text-glow-green">{stats.active24h}</span>
        </div>
      </div>

      {/* Activity Sparkline */}
      <div className={kpiCard}>
        <div className={kpiLabel}>{a.activity7d || '7d Activity'}</div>
        <MiniSparkline values={activityValues} height={32} color="#3b82f6" />
      </div>

      {/* Messages Breakdown — Donut chart */}
      {agg?.messages && agg.messages.total > 0 && (
        <div className={kpiCard}>
          <div className={kpiLabel}>{a.messages || 'Messages'}</div>
          <div className="flex items-center gap-2">
            <MiniDonut size={44} slices={[
              { value: agg.messages.user, color: MSG_COLORS.user },
              { value: agg.messages.assistant, color: MSG_COLORS.assistant },
              { value: agg.messages.toolCalls, color: MSG_COLORS.tools },
              { value: agg.messages.errors, color: MSG_COLORS.errors },
            ].filter(s => s.value > 0)} innerRadius={0.55} />
            <div>
              <div className="text-base font-extrabold text-slate-800 dark:text-white/85 tabular-nums leading-none">{agg.messages.total}</div>
              <div className="flex flex-wrap gap-x-1.5 text-[9px] mt-0.5">
                <span className="text-blue-500">● {a.userMsg || 'User'} {agg.messages.user}</span>
                <span className="text-emerald-500">● {a.assistantMsg || 'Asst'} {agg.messages.assistant}</span>
              </div>
              <div className="flex flex-wrap gap-x-1.5 text-[9px]">
                {agg.messages.toolCalls > 0 && <span className="text-purple-500">● {a.toolCallsLabel || 'Tools'} {agg.messages.toolCalls}</span>}
                {agg.messages.errors > 0 && <span className="text-red-500">● {a.errors || 'Err'} {agg.messages.errors}</span>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tool Usage — Horizontal bar chart */}
      {agg?.tools && agg.tools.totalCalls > 0 && (() => {
        const topTools = (agg.tools.tools || []).slice(0, 4);
        const maxCalls = topTools[0]?.count || 1;
        return (
          <div className={kpiCard}>
            <div className="flex items-center justify-between mb-1.5">
              <span className={kpiLabel + ' mb-0'}>{a.toolUsage || 'Tools'}</span>
              <span className="text-[10px] text-slate-400 dark:text-white/25">{agg.tools.totalCalls} · {agg.tools.uniqueTools} {a.uniqueTools || 'unique'}</span>
            </div>
            <div className="space-y-1">
              {topTools.map((t: any) => (
                <div key={t.name} className="flex items-center gap-1.5">
                  <div className="flex-1 h-2 rounded-full bg-slate-100 dark:bg-white/5 overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-purple-500/80 to-violet-400/60 transition-all" style={{ width: `${(t.count / maxCalls) * 100}%` }} />
                  </div>
                  <span className="text-[9px] text-slate-400 dark:text-white/25 font-mono truncate max-w-[55px]" title={t.name}>{t.name}</span>
                  <span className="text-[9px] text-purple-500 dark:text-purple-400 font-bold tabular-nums shrink-0">{t.count}×</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Latency — Gauge + range bar */}
      {agg?.latency && agg.latency.count > 0 && (() => {
        const avg = agg.latency.avgMs;
        const p95 = agg.latency.p95Ms;
        const maxMs = agg.latency.maxMs;
        const minMs = agg.latency.minMs;
        // Gauge: percentage of p95 vs a 10s reference (clamped)
        const gaugePct = Math.min((avg / 10000) * 100, 100);
        return (
          <div className={kpiCard}>
            <div className={kpiLabel}>{a.latencyStats || 'Latency'}</div>
            <div className="flex items-center gap-2.5">
              <MiniGauge size={44} percent={gaugePct} strokeWidth={4} label={`${(avg / 1000).toFixed(1)}s`} />
              <div className="flex-1 min-w-0">
                {/* Range bar: min → avg → p95 → max */}
                <div className="h-2 rounded-full bg-slate-100 dark:bg-white/5 overflow-hidden relative mb-1">
                  {maxMs > 0 && (
                    <>
                      <div className="absolute h-full bg-emerald-400/50 rounded-s-full" style={{ left: `${(minMs / maxMs) * 100}%`, width: `${((avg - minMs) / maxMs) * 100}%` }} />
                      <div className="absolute h-full bg-amber-400/50" style={{ left: `${(avg / maxMs) * 100}%`, width: `${((p95 - avg) / maxMs) * 100}%` }} />
                      <div className="absolute h-full bg-red-400/30 rounded-e-full" style={{ left: `${(p95 / maxMs) * 100}%`, width: `${((maxMs - p95) / maxMs) * 100}%` }} />
                    </>
                  )}
                </div>
                <div className="flex justify-between text-[9px] text-slate-400 dark:text-white/25 tabular-nums">
                  <span>{(minMs / 1000).toFixed(1)}s</span>
                  <span className="text-amber-500 font-bold">p95 {(p95 / 1000).toFixed(1)}s</span>
                  <span>{(maxMs / 1000).toFixed(1)}s</span>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Channel Distribution */}
      {channelEntries.length > 1 && (
        <div className={kpiCard}>
          <div className={kpiLabel}>{a.channels || 'Channels'}</div>
          <div className="flex items-center gap-2">
            <MiniDonut size={40} slices={channelEntries.map(([, v], i) => ({
              value: v, color: CHANNEL_COLORS[i % CHANNEL_COLORS.length],
            }))} innerRadius={0.5} />
            <div className="text-[10px] text-slate-400 dark:text-white/25 leading-tight">
              {channelEntries.slice(0, 3).map(([name, count]) => <div key={name}>{name}: {count}</div>)}
            </div>
          </div>
        </div>
      )}

      {/* Cost Trend (7-day) */}
      {costTrend && costTrend.length > 0 && costTrend.some(d => d.totalCost > 0) && (
        <div className={kpiCard}>
          <div className={kpiLabel}>{a.costTrend || 'Cost 7d'}</div>
          <MiniSparkline values={costTrend.map(d => d.totalCost)} height={32} color="#10b981" />
          <div className="text-[10px] text-emerald-500 font-bold tabular-nums mt-0.5 text-glow-green">
            ${costTrend.reduce((sum, d) => sum + d.totalCost, 0).toFixed(2)}
          </div>
        </div>
      )}

      {/* Model Distribution */}
      {(() => {
        const modelCounts: Record<string, number> = {};
        sessions.forEach(s => { if (s.model) modelCounts[s.model] = (modelCounts[s.model] || 0) + 1; });
        const modelEntries = Object.entries(modelCounts).sort((a2, b2) => b2[1] - a2[1]).slice(0, 4);
        const maxCount = modelEntries[0]?.[1] || 1;
        if (modelEntries.length === 0) return null;
        return (
          <div className={kpiCard}>
            <div className={kpiLabel}>{a.modelDist || 'Models'}</div>
            <div className="space-y-1">
              {modelEntries.map(([name, count]) => (
                <div key={name} className="flex items-center gap-1.5">
                  <div className="flex-1 h-1.5 rounded-full bg-slate-100 dark:bg-white/5 overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-purple-500/80 to-purple-400/60 transition-all" style={{ width: `${(count / maxCount) * 100}%` }} />
                  </div>
                  <span className="text-[9px] text-slate-400 dark:text-white/25 font-mono truncate max-w-[60px]" title={name}>{name.split('/').pop()}</span>
                  <span className="text-[9px] text-slate-500 dark:text-white/35 font-bold tabular-nums">{count}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Top Token Consumers */}
      {(() => {
        const topSessions = [...sessions]
          .map(s => ({ key: s.key, name: s.derivedTitle || s.displayName || s.label || s.key, tokens: (s.inputTokens || 0) + (s.outputTokens || 0) }))
          .filter(s => s.tokens > 0)
          .sort((a2, b2) => b2.tokens - a2.tokens)
          .slice(0, 5);
        const maxTok = topSessions[0]?.tokens || 1;
        if (topSessions.length < 2) return null;
        return (
          <div className={kpiCard}>
            <div className={kpiLabel}>{a.topConsumers || 'Top Consumers'}</div>
            <div className="space-y-1">
              {topSessions.map(s => (
                <div key={s.key} className="flex items-center gap-1.5">
                  <div className="flex-1 h-1.5 rounded-full bg-slate-100 dark:bg-white/5 overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-blue-500/80 to-cyan-400/60 transition-all" style={{ width: `${(s.tokens / maxTok) * 100}%` }} />
                  </div>
                  <span className="text-[9px] text-slate-400 dark:text-white/25 font-mono truncate max-w-[60px]" title={s.name}>{s.name.length > 10 ? s.name.slice(0, 8) + '..' : s.name}</span>
                  <span className="text-[9px] text-slate-500 dark:text-white/35 font-bold tabular-nums">{fmtTok(s.tokens)}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Aborted */}
      {stats.abortedCount > 0 && (
        <div className="rounded-2xl bg-gradient-to-br from-red-50/50 to-red-100/20 dark:from-red-500/[0.06] dark:to-red-500/[0.02] backdrop-blur-xl border border-red-200/40 dark:border-red-500/10 p-3 shadow-sm">
          <div className="text-[11px] font-bold text-red-400 dark:text-red-400/60 uppercase mb-1">{a.aborted || 'Aborted'}</div>
          <div className="text-base font-extrabold text-red-500 tabular-nums">{stats.abortedCount}</div>
        </div>
      )}
    </div>
  );
};
