// MeetingDepthBadge —— 顶栏会议深度指标徽章。
//
// 设计意图（v0.8）：
//   真实会议最重要的反馈是"这次对话到底有没有谈透"。以前用户完全看不到深度指标，
//   只能靠肉眼数消息。本组件从 messages 里算出几个直观的指标，按 policy 选最贴合的
//   展示方式。不同会议类型显示不同徽章，避免一个徽章套全场景（会议 / 辩论 / 头脑
//   风暴对深度的定义完全不同）。
//
// 指标口径：
//   - currentStreak：自上一条"人类/虚拟 nudge"消息以来连续 agent 发言数 = "本轮深度"
//   - totalAgentTurns：房间里总计 agent chat 消息数
//   - humanTurns：人类触发次数（不含 nudge）
//
// 为什么不做更花哨的"反驳次数"启发式：大部分模型不会稳定说出"我反驳"之类关键词；
// 用简单的 streak / total 已经能给出 80% 的直觉，而且绝对准确不会误判。
//
// 渲染规则：
//   - debate       → ⚔️ 已辩 N 轮 · 本轮 M   （配合 MaxConsec 显示百分比 bar）
//   - roundRobin   → 🔄 第 M 棒 · 总 N
//   - parallel/    → 🎨 M 方案并行 · 累计 N
//     brainstorm
//   - bidding      → 🎤 本轮 M · 累计 N
//   - planning     → 📋 {phase} 阶段 · 累计 N
//   - free/moderator/reactive → 💬 本轮 M / MaxConsec · 累计 N
//
// 仅在有至少 1 条 agent 消息时显示，避免新房间一片空白。

import React from 'react';
import type { Room, Member, Message } from '../types';

interface Props {
  room: Room;
  members: Member[];
  messages: Message[];
  /** MaxConsecutive 上限，用来在"本轮深度"后显示比例；undefined 时隐藏分母。 */
  maxConsecutive?: number;
}

interface DepthStats {
  currentStreak: number;
  totalAgentTurns: number;
  humanTurns: number;
  nudgeCount: number;
}

function computeDepth(members: Member[], messages: Message[]): DepthStats {
  // 构造 agent-id 集合（human/system/nudge 不算 agent 轮次）
  const isAgent = new Set<string>();
  for (const m of members) {
    if (m.kind === 'agent') isAgent.add(m.id);
  }
  let currentStreak = 0;
  let totalAgentTurns = 0;
  let humanTurns = 0;
  let nudgeCount = 0;
  let streakDone = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.deleted) continue;
    if (msg.kind !== 'chat') continue;
    if (isAgent.has(msg.authorId)) {
      totalAgentTurns++;
      if (!streakDone) currentStreak++;
    } else {
      // human 消息（含 human:nudge 虚拟作者）
      if (!streakDone) streakDone = true;
      if (msg.authorId === 'human:nudge') nudgeCount++;
      else humanTurns++;
    }
  }
  return { currentStreak, totalAgentTurns, humanTurns, nudgeCount };
}

const MeetingDepthBadge: React.FC<Props> = ({ room, members, messages, maxConsecutive }) => {
  const stats = computeDepth(members, messages);
  if (stats.totalAgentTurns === 0) return null;

  // 按 policy 选渲染模式。planning 特殊：同时显示 executionPhase。
  const policy = room.policy;
  const phase = room.executionPhase;

  let icon = '💬';
  let label = '本轮';
  let primary = `${stats.currentStreak}`;
  let secondary: string | null = `累计 ${stats.totalAgentTurns}`;
  let tone: 'default' | 'combat' | 'planning' | 'creative' = 'default';

  switch (policy) {
    case 'debate':
      icon = '⚔️';
      label = '辩论';
      primary = `${stats.currentStreak} 轮`;
      secondary = `累计 ${stats.totalAgentTurns}`;
      tone = 'combat';
      break;
    case 'roundRobin':
      icon = '🔄';
      label = '接龙';
      primary = `第 ${stats.currentStreak} 棒`;
      secondary = `累计 ${stats.totalAgentTurns}`;
      break;
    case 'parallel':
      icon = '🎨';
      label = '并行';
      primary = `${stats.currentStreak} 方案`;
      secondary = `累计 ${stats.totalAgentTurns}`;
      tone = 'creative';
      break;
    case 'bidding':
      icon = '🎤';
      label = '抢麦';
      primary = `本轮 ${stats.currentStreak}`;
      secondary = `累计 ${stats.totalAgentTurns}`;
      break;
    case 'moderator':
      icon = '🎙️';
      label = '主持';
      primary = `本轮 ${stats.currentStreak}`;
      secondary = `累计 ${stats.totalAgentTurns}`;
      break;
    case 'reactive':
      icon = '↩️';
      label = '响应';
      primary = `本轮 ${stats.currentStreak}`;
      secondary = `累计 ${stats.totalAgentTurns}`;
      break;
    case 'planned':
      icon = '📋';
      label = phase || 'discussion';
      primary = `本轮 ${stats.currentStreak}`;
      secondary = `累计 ${stats.totalAgentTurns}`;
      tone = 'planning';
      break;
    case 'free':
    default:
      icon = '💬';
      label = '交锋';
      primary = `本轮 ${stats.currentStreak}`;
      secondary = `累计 ${stats.totalAgentTurns}`;
  }

  // 比例（仅 currentStreak / MaxConsec 有意义时显示）
  const ratio = maxConsecutive && maxConsecutive > 0
    ? Math.min(1, stats.currentStreak / maxConsecutive)
    : 0;
  const nearLimit = ratio >= 0.8;

  // tone → 颜色主题
  const toneClass = {
    default: 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/30',
    combat: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30',
    planning: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
    creative: 'bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30',
  }[tone];

  // 快到上限时整块变警告色
  const limitClass = nearLimit ? 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40 animate-pulse' : '';

  const title = [
    `${label} · 本轮 ${stats.currentStreak}`,
    maxConsecutive ? `上限 ${maxConsecutive}` : null,
    `累计 agent 发言 ${stats.totalAgentTurns}`,
    stats.humanTurns ? `人类触发 ${stats.humanTurns}` : null,
    stats.nudgeCount ? `继续会议 ${stats.nudgeCount} 次` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div
      title={title}
      className={[
        'inline-flex items-center gap-1 px-2 h-7 rounded-md text-[11px] font-semibold border transition-all shrink-0 font-mono tabular-nums',
        limitClass || toneClass,
      ].join(' ')}
    >
      {/* v0.9：整个徽章已在外层 md+ 才出现，内部不再按断点隐藏字段，
          让"接龙 第 N 棒 · 累计 N / 上限" 完整呈现。 */}
      <span aria-hidden>{icon}</span>
      <span>{label}</span>
      <span>{primary}</span>
      {secondary && <span className="opacity-60">· {secondary}</span>}
      {maxConsecutive && maxConsecutive > 0 && (
        <span className="opacity-70">/ {maxConsecutive}</span>
      )}
    </div>
  );
};

export default MeetingDepthBadge;
