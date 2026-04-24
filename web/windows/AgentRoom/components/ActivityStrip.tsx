// AgentRoom · 活跃成员读秒条
// 参考 AI 会话窗口的 "等待中 — still working... 42.8s" 提示样式：让用户清楚知道
// 当前哪些 agent 正在思考 / 发言 / 跑工具，耗时多久，不至于怀疑系统卡死。
//
// 设计要点：
//   - 只显示 status ∈ {thinking, speaking, tool_call, tool_running} 的成员
//   - 每个成员的"开始时间"在状态转换瞬间记录在 ref，切回 idle 清除
//   - ticker 仅在有活跃成员时启动，无人活跃即卸载定时器，避免无谓 re-render
//   - 横向滚动（no-scrollbar），在窄屏 / 多 agent 并发时仍可展开查看
import React, { useEffect, useRef, useState } from 'react';
import type { Member } from '../types';

const ACTIVE_STATUSES = new Set<Member['status']>(['thinking', 'speaking', 'tool_call', 'tool_running']);

// 每种状态的中文描述、点颜色、is-pulse 动画。
const STATUS_META: Record<string, { label: string; dot: string }> = {
  thinking: { label: '思考中', dot: 'bg-amber-400' },
  speaking: { label: '正在发言', dot: 'bg-emerald-400' },
  tool_call: { label: '工具调用', dot: 'bg-cyan-400' },
  tool_running: { label: '工具执行中', dot: 'bg-cyan-400' },
};

interface Props {
  members: Member[];
}

const ActivityStrip: React.FC<Props> = ({ members }) => {
  // memberId → { status, startedAt(ms) }
  const sinceRef = useRef<Map<string, { status: Member['status']; at: number }>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  // 每当 members 刷新（status 变化会触发上游 re-render），重新计算 since 映射。
  // 注意：同一 member 状态没变 → 保留旧 at；状态变更或由非活跃转活跃 → 重置为 now。
  useEffect(() => {
    const m = sinceRef.current;
    for (const mem of members) {
      const active = ACTIVE_STATUSES.has(mem.status);
      const prev = m.get(mem.id);
      if (active) {
        if (!prev || prev.status !== mem.status) {
          m.set(mem.id, { status: mem.status, at: Date.now() });
        }
      } else if (prev) {
        m.delete(mem.id);
      }
    }
    // 清理已被移除的成员
    for (const id of Array.from(m.keys())) {
      if (!members.some(x => x.id === id)) m.delete(id);
    }
  }, [members]);

  const active = members.filter(m => ACTIVE_STATUSES.has(m.status));

  // ticker：仅在有活跃成员时打开，避免空转。100ms 足够体现 .1s 精度又不卡。
  useEffect(() => {
    if (active.length === 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(t);
  }, [active.length]);

  if (active.length === 0) return null;

  return (
    <div
      className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-t border-border bg-surface-sunken/40 overflow-x-auto no-scrollbar"
      role="status"
      aria-live="polite"
    >
      <span className="material-symbols-outlined text-[15px] text-cyan-500 animate-pulse shrink-0">
        auto_awesome
      </span>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted shrink-0">
        进行中
      </span>
      {active.map(mem => {
        const rec = sinceRef.current.get(mem.id);
        const elapsedSec = rec ? (now - rec.at) / 1000 : 0;
        const meta = STATUS_META[mem.status] ?? { label: mem.status, dot: 'bg-slate-400' };
        return (
          <div
            key={mem.id}
            className="flex items-center gap-1.5 shrink-0 px-2 py-1 rounded-md bg-surface-raised border border-border text-[11.5px]"
          >
            <span className="text-[13px]" aria-hidden>{mem.emoji || '🤖'}</span>
            <span className="font-semibold text-text max-w-[9rem] truncate">{mem.name}</span>
            <span className={`w-1.5 h-1.5 rounded-full ${meta.dot} animate-pulse`} aria-hidden />
            <span className="text-text-secondary">
              {meta.label} — still working…
            </span>
            <span className="text-cyan-600 dark:text-cyan-400 font-mono tabular-nums">
              {elapsedSec.toFixed(1)}s
            </span>
          </div>
        );
      })}
    </div>
  );
};

export default ActivityStrip;
