// 右栏·行为指标（Advanced 模式显示）
import React from 'react';
import type { Member, RoomMetrics } from '../types';

interface Props {
  metrics: RoomMetrics;
  members: Map<string, Member>;
}

const MetricsPanel: React.FC<Props> = ({ metrics, members }) => {
  return (
    <div className="space-y-2">
      <MetricRow label="同意度" value={metrics.agreementScore} format="pct" hint="成员观点相近度" />
      <MetricRow
        label="信息增益"
        value={metrics.infoGainTrend === 'up' ? 1 : metrics.infoGainTrend === 'down' ? -1 : 0}
        format="trend"
        hint="每轮引入新概念的多少"
      />
      <MetricRow label="发言集中度" value={metrics.dominanceGini} format="gini" hint="越低越平均" />
      <MetricRow label="工具使用率" value={metrics.toolUsageRate} format="pct" hint="带工具的消息占比" />
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-text-muted">总消息</span>
        <span className="font-mono tabular-nums font-semibold text-text">{metrics.totalMessages}</span>
      </div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-text-muted">总 tokens</span>
        <span className="font-mono tabular-nums font-semibold text-text">{metrics.totalTokens.toLocaleString()}</span>
      </div>

      <div className="pt-2 mt-2 border-t border-border">
        <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1.5">发言分布</div>
        <div className="space-y-1">
          {metrics.perMember.sort((a, b) => b.messages - a.messages).map(pm => {
            const m = members.get(pm.memberId);
            if (!m) return null;
            const total = metrics.totalMessages || 1;
            const pct = (pm.messages / total) * 100;
            return (
              <div key={pm.memberId} className="flex items-center gap-2 text-[10.5px]">
                <span className="shrink-0 w-14 truncate">{m.emoji} {m.name}</span>
                <div className="flex-1 h-1 rounded-full bg-surface-sunken overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-cyan-400 to-blue-500 transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="font-mono tabular-nums w-8 text-end text-text-muted">{pm.messages}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const MetricRow: React.FC<{ label: string; value: number; format: 'pct' | 'gini' | 'trend'; hint?: string }> = ({ label, value, format, hint }) => {
  let display = '';
  let bars = 0;
  if (format === 'pct') {
    display = `${Math.round(value * 100)}%`;
    bars = Math.round(value * 5);
  } else if (format === 'gini') {
    display = value < 0.33 ? '低' : value < 0.66 ? '中' : '高';
    bars = Math.round(value * 5);
  } else if (format === 'trend') {
    display = value > 0 ? '↑↑' : value < 0 ? '↓↓' : '→';
    bars = value > 0 ? 4 : value < 0 ? 1 : 2;
  }
  return (
    <div className="flex items-center justify-between text-[11px]" title={hint}>
      <span className="text-text-muted truncate">{label}</span>
      <div className="flex items-center gap-1.5">
        <div className="flex gap-0.5">
          {[0, 1, 2, 3, 4].map(i => (
            <span key={i} className={`w-1 h-3 rounded-sm ${i < bars ? 'bg-cyan-400' : 'bg-surface-sunken'}`} />
          ))}
        </div>
        <span className="font-mono tabular-nums text-text font-semibold w-8 text-end">{display}</span>
      </div>
    </div>
  );
};

export default MetricsPanel;
