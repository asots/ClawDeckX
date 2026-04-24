// QualityMetricsPanel —— v0.6 协作质量指标面板（纯前端）
//
// 把散落在 `Message` 上的 soft-tag 字段聚合成一个可一眼看懂的"这场会到底怎么样"仪表板：
//   - 总发言 / 最近 50 条 agent 发言置信度均值
//   - confidence 分布（高 ≥80 / 中 50-79 / 低 <50 / 未声明）
//   - stance 分布（同意 / 反对 / 弃权 / 不确定 / 未声明）
//   - 决策 / 需人介入 / untrusted / PII 脱敏 命中计数
//   - 最近自我批判 rewrite 比率（kind=critique 计数 / chat 计数，目前是估算）
//
// 设计取舍：
//   - 纯前端计算，无后端调用，刷新瞬时
//   - 只统计 authorId 非空 的 agent/human chat-kind 消息，忽略 system/thinking/tool

import React, { useMemo } from 'react';
import type { Message } from '../types';

interface Props {
  messages: Message[];
}

const Bar: React.FC<{ label: string; count: number; total: number; tone: string }> = ({ label, count, total, tone }) => {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] mb-0.5">
        <span className="text-text-muted">{label}</span>
        <span className="font-mono tabular-nums">{count} · {pct}%</span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-surface-sunken overflow-hidden">
        <div className={`h-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

const QualityMetricsPanel: React.FC<Props> = ({ messages }) => {
  const s = useMemo(() => {
    const chat = messages.filter(m =>
      !m.deleted &&
      (m.kind === 'chat' || m.kind === 'decision'),
    );
    const total = chat.length;

    // Confidence
    const confValues = chat.map(m => m.confidence ?? 0).filter(v => v > 0);
    const confAvg = confValues.length > 0
      ? Math.round(confValues.reduce((a, b) => a + b, 0) / confValues.length)
      : 0;
    const confHigh = chat.filter(m => (m.confidence ?? 0) >= 80).length;
    const confMid = chat.filter(m => (m.confidence ?? 0) >= 50 && (m.confidence ?? 0) < 80).length;
    const confLow = chat.filter(m => (m.confidence ?? 0) > 0 && (m.confidence ?? 0) < 50).length;
    const confNone = total - confHigh - confMid - confLow;

    // Stance
    const sAgree = chat.filter(m => m.stance === 'agree').length;
    const sDis   = chat.filter(m => m.stance === 'disagree').length;
    const sAbs   = chat.filter(m => m.stance === 'abstain').length;
    const sUnc   = chat.filter(m => m.stance === 'uncertain').length;
    const sNone  = total - sAgree - sDis - sAbs - sUnc;

    // Special
    const decisions = chat.filter(m => m.isDecision).length;
    const humanNeeded = chat.filter(m => !!m.humanNeeded).length;
    const untrusted = messages.filter(m => m.untrusted).length;
    const piiHits = messages.reduce((n, m) => n + (m.piiRedactedCount || 0), 0);

    const critiques = messages.filter(m => m.kind === 'critique').length;
    const critiqueRate = total > 0 ? Math.round((critiques / total) * 100) : 0;

    return { total, confAvg, confHigh, confMid, confLow, confNone, sAgree, sDis, sAbs, sUnc, sNone, decisions, humanNeeded, untrusted, piiHits, critiqueRate };
  }, [messages]);

  if (s.total === 0) {
    return (
      <div className="px-2 py-3 text-[11px] text-text-muted text-center border border-dashed border-border rounded-md leading-relaxed">
        还没有聊天记录。发一条消息后，此处会展示置信度/立场/决策等协作质量指标。
      </div>
    );
  }

  const toneAvg =
    s.confAvg >= 80 ? 'text-emerald-500' :
    s.confAvg >= 50 ? 'text-amber-500' :
                       'text-red-500';

  return (
    <div className="space-y-3 text-[12px]">
      {/* 总览 */}
      <div className="grid grid-cols-3 gap-2">
        <div className="px-2 py-1.5 rounded-md bg-surface-raised border border-border">
          <div className="text-[10px] text-text-muted uppercase tracking-wider">总发言</div>
          <div className="text-[16px] font-bold tabular-nums">{s.total}</div>
        </div>
        <div className="px-2 py-1.5 rounded-md bg-surface-raised border border-border">
          <div className="text-[10px] text-text-muted uppercase tracking-wider">置信度均值</div>
          <div className={`text-[16px] font-bold tabular-nums ${toneAvg}`}>
            {s.confAvg > 0 ? `${s.confAvg}%` : '—'}
          </div>
        </div>
        <div className="px-2 py-1.5 rounded-md bg-surface-raised border border-border">
          <div className="text-[10px] text-text-muted uppercase tracking-wider">决策数</div>
          <div className="text-[16px] font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{s.decisions}</div>
        </div>
      </div>

      {/* 置信度分布 */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1.5">置信度分布</div>
        <div className="space-y-1.5">
          <Bar label="高 (≥80)" count={s.confHigh} total={s.total} tone="bg-emerald-500" />
          <Bar label="中 (50-79)" count={s.confMid} total={s.total} tone="bg-amber-500" />
          <Bar label="低 (<50)" count={s.confLow} total={s.total} tone="bg-red-500" />
          <Bar label="未声明" count={s.confNone} total={s.total} tone="bg-slate-400" />
        </div>
      </div>

      {/* 立场分布 */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1.5">立场分布</div>
        <div className="space-y-1.5">
          <Bar label="同意" count={s.sAgree} total={s.total} tone="bg-emerald-500" />
          <Bar label="反对" count={s.sDis} total={s.total} tone="bg-red-500" />
          <Bar label="弃权" count={s.sAbs} total={s.total} tone="bg-slate-400" />
          <Bar label="不确定" count={s.sUnc} total={s.total} tone="bg-amber-400" />
          <Bar label="未声明" count={s.sNone} total={s.total} tone="bg-slate-300" />
        </div>
      </div>

      {/* 告警项 */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1.5">告警项</div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="px-2 py-1.5 rounded-md border border-amber-500/30 bg-amber-500/5">
            <div className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
              <span className="material-symbols-outlined text-[12px]">pan_tool</span>需人介入
            </div>
            <div className="text-[14px] font-bold tabular-nums mt-0.5">{s.humanNeeded}</div>
          </div>
          <div className="px-2 py-1.5 rounded-md border border-orange-500/30 bg-orange-500/5">
            <div className="flex items-center gap-1 text-[10px] text-orange-600 dark:text-orange-400">
              <span className="material-symbols-outlined text-[12px]">shield</span>untrusted
            </div>
            <div className="text-[14px] font-bold tabular-nums mt-0.5">{s.untrusted}</div>
          </div>
          <div className="px-2 py-1.5 rounded-md border border-blue-500/30 bg-blue-500/5">
            <div className="flex items-center gap-1 text-[10px] text-blue-600 dark:text-blue-400">
              <span className="material-symbols-outlined text-[12px]">visibility_off</span>PII 脱敏
            </div>
            <div className="text-[14px] font-bold tabular-nums mt-0.5">{s.piiHits}</div>
          </div>
          <div className="px-2 py-1.5 rounded-md border border-purple-500/30 bg-purple-500/5">
            <div className="flex items-center gap-1 text-[10px] text-purple-600 dark:text-purple-400">
              <span className="material-symbols-outlined text-[12px]">fact_check</span>自我批判率
            </div>
            <div className="text-[14px] font-bold tabular-nums mt-0.5">{s.critiqueRate}%</div>
          </div>
        </div>
      </div>

      <div className="pt-1 text-[10px] text-text-muted leading-relaxed border-t border-border">
        仅基于"本房间已读消息"聚合。低置信度占比过高可考虑开房间 <code className="px-1 rounded bg-surface-sunken">selfCritique</code>；
        反对率偏高说明讨论有真分歧，适合 <code className="px-1 rounded bg-surface-sunken">/ask-all</code> 让各自独立作答后再比对。
      </div>
    </div>
  );
};

export default QualityMetricsPanel;
