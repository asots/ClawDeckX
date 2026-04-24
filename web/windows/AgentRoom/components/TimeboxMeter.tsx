// TimeboxMeter —— 顶栏预期轮次进度条
//
// 只在 room.roundBudget > 0 时显示；rounds_used / round_budget + 百分比；达到/超过 100% 时高亮红色。
// 让用户一眼知道"这场会开了多久、离预算还有多远"；配合房间目标推动收敛。

import React from 'react';
import type { Room } from '../types';

interface Props {
  room: Room;
  compact?: boolean;
}

const TimeboxMeter: React.FC<Props> = ({ room, compact = false }) => {
  const budget = room.roundBudget ?? 0;
  const used = room.roundsUsed ?? 0;
  if (budget <= 0) return null;
  const pct = Math.min(100, Math.round((used / budget) * 100));
  const over = used >= budget;
  const tone =
    over ? 'bg-red-500' :
    pct >= 80 ? 'bg-amber-500' :
                  'bg-emerald-500';
  const toneText =
    over ? 'text-red-500' :
    pct >= 80 ? 'text-amber-500' :
                  'text-emerald-500';
  return (
    <div
      className="inline-flex items-center gap-1.5 shrink-0"
      title={`轮次预算：${used} / ${budget} (${pct}%)${over ? '，已超出' : ''}`}
    >
      {!compact && (
        <span className={`material-symbols-outlined text-[14px] ${toneText}`}>schedule</span>
      )}
      <div className="w-20 h-1.5 rounded-full bg-surface-sunken overflow-hidden">
        <div className={`h-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      {!compact && (
        <span className={`text-[10px] font-mono tabular-nums ${toneText}`}>
          {used}/{budget}
        </span>
      )}
    </div>
  );
};

export default TimeboxMeter;
