// WorkflowTimeline —— 三层 phase 统一工作流时间轴（v0.2 GAP G5）
//
// 把分散在系统里的三种 "phase" 合并成一条用户可一眼看懂的时间轴：
//   1. MeetingPhase（节奏）：opening → deepDive → fatigue → convergence
//      —— 由 roundsUsed / roundBudget 自动推算（与后端 meeting_dynamics.go.CalcMeetingPhase 同算法）
//   2. AgendaItem.Status（议程容器）：当前激活议项 + 整体进度（已完成/总数）
//   3. ExecutionPhase（planned policy）：discussion → executing → review
//
// 设计：
//   - 顶部一条横向 strip，三个段并排：节奏 / 议程 / 执行阶段
//   - 浅深色双主题；macOS chrome 加 sci-tech glow 同 AgendaRail/MemberRail 风格统一
//   - 点击节奏段 → 打开 MeetingDepthBadge tooltip / 点议程段 → 跳到议程面板
//   - 紧凑高度（h-9），只占用顶部一行，不抢消息流空间
//
// 仅消费现有数据，无额外网络请求；Agenda 列表通过 service.listAgendaItems 拉取（缓存）。

import React, { useEffect, useMemo, useState } from 'react';
import type { AgendaItem, Room, RoomLineage } from '../types';
import { listAgenda, roomEvents, getRoomLineage } from '../service';

interface Props {
  room: Room;
  activeAgendaItem?: AgendaItem | null;
  /** 用户点议程段时回调（一般跳到议程面板/打开 AgendaRail） */
  onJumpAgenda?: () => void;
}

// 与后端 internal/agentroom/meeting_dynamics.go 的 CalcMeetingPhase 完全一致。
function calcMeetingPhase(roundsUsed: number, roundBudget: number): RhythmPhase {
  if (roundBudget > 0) {
    const ratio = roundsUsed / roundBudget;
    if (ratio < 0.2) return 'opening';
    if (ratio < 0.6) return 'deepdive';
    if (ratio < 0.8) return 'fatigue';
    return 'convergence';
  }
  if (roundsUsed < 4) return 'opening';
  if (roundsUsed < 12) return 'deepdive';
  if (roundsUsed < 18) return 'fatigue';
  return 'convergence';
}

type RhythmPhase = 'opening' | 'deepdive' | 'fatigue' | 'convergence';

const RHYTHM_META: Record<RhythmPhase, { label: string; icon: string; tone: string }> = {
  opening:     { label: '开场',   icon: 'cottage',         tone: 'text-cyan-500' },
  deepdive:    { label: '深挖',   icon: 'travel_explore',  tone: 'text-amber-500' },
  fatigue:     { label: '疲劳',   icon: 'battery_2_bar',   tone: 'text-orange-500' },
  convergence: { label: '收束',   icon: 'flag',            tone: 'text-emerald-500' },
};

const RHYTHM_ORDER: RhythmPhase[] = ['opening', 'deepdive', 'fatigue', 'convergence'];

const EXEC_PHASE_META: Record<string, { label: string; icon: string; tone: string }> = {
  discussion: { label: '讨论',   icon: 'forum',           tone: 'text-blue-500' },
  executing:  { label: '执行',   icon: 'rocket_launch',   tone: 'text-amber-500' },
  review:     { label: '复盘',   icon: 'rule',            tone: 'text-violet-500' },
};

const WorkflowTimeline: React.FC<Props> = ({ room, activeAgendaItem, onJumpAgenda }) => {
  const [agendas, setAgendas] = useState<AgendaItem[]>([]);

  const refetch = React.useCallback(() => {
    listAgenda(room.id).then(setAgendas).catch(() => setAgendas([]));
  }, [room.id]);

  useEffect(() => { refetch(); }, [refetch]);

  // 议程项变更广播 → 重新拉取
  useEffect(() => {
    const off = roomEvents.on('room.update', ev => {
      if (ev.roomId !== room.id) return;
      const p = ev.patch as { agendaChanged?: boolean } | undefined;
      if (p && p.agendaChanged) refetch();
    });
    return () => { if (off) off(); };
  }, [room.id, refetch]);

  const rhythm = useMemo(
    () => calcMeetingPhase(room.roundsUsed || 0, room.roundBudget || 0),
    [room.roundsUsed, room.roundBudget],
  );

  const totalAgendas = agendas.length;
  const doneAgendas = useMemo(() => agendas.filter(a => a.status === 'done' || a.status === 'skipped').length, [agendas]);

  const showExecutionPhase = room.policy === 'planned' && !!room.executionPhase;

  // 当所有数据都不显眼时（无 budget / 无 agenda / 非 planned）— 仍渲染节奏段，避免空跳。
  return (
    <div
      className="flex items-stretch gap-1.5 px-2 py-1 border-b border-border/60 bg-surface/70 backdrop-blur-sm text-[11px] overflow-hidden"
      role="status"
      aria-label="会议工作流时间轴"
    >
      {/* 续自源房间（仅当 parentRoomId 存在） */}
      {room.parentRoomId && (
        <>
          <ParentRoomChip roomId={room.id} />
          <Separator />
        </>
      )}

      {/* 节奏 */}
      <RhythmSegment phase={rhythm} roundsUsed={room.roundsUsed || 0} roundBudget={room.roundBudget || 0} />

      <Separator />

      {/* 议程 */}
      <AgendaSegment
        active={activeAgendaItem || null}
        done={doneAgendas}
        total={totalAgendas}
        onClick={onJumpAgenda}
      />

      {showExecutionPhase && (
        <>
          <Separator />
          <ExecutionPhaseSegment phase={room.executionPhase || ''} />
        </>
      )}

      {/* 工作单结余 */}
      <Separator />
      <TaskSummary tasks={room.tasks || []} />
    </div>
  );
};

// ── 节奏段（含小型阶段进度条） ──
const RhythmSegment: React.FC<{ phase: RhythmPhase; roundsUsed: number; roundBudget: number }> = ({
  phase, roundsUsed, roundBudget,
}) => {
  const meta = RHYTHM_META[phase];
  const idx = RHYTHM_ORDER.indexOf(phase);
  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2 rounded-md ${meta.tone}`}
      title={roundBudget > 0
        ? `节奏 · ${meta.label}（${roundsUsed}/${roundBudget} 轮）`
        : `节奏 · ${meta.label}（已 ${roundsUsed} 轮）`}
    >
      <span className="material-symbols-outlined text-[14px]">{meta.icon}</span>
      <span className="font-semibold">{meta.label}</span>
      {/* 4 段微型进度 */}
      <div className="flex gap-0.5 ms-1">
        {RHYTHM_ORDER.map((_, i) => (
          <span
            key={i}
            className={`h-1.5 w-3 rounded-sm transition-colors ${
              i < idx ? 'bg-current opacity-50' : i === idx ? 'bg-current' : 'bg-current opacity-15'
            }`}
          />
        ))}
      </div>
      {roundBudget > 0 && (
        <span className="font-mono opacity-70 text-[10px]">{roundsUsed}/{roundBudget}</span>
      )}
    </div>
  );
};

// ── 议程段 ──
const AgendaSegment: React.FC<{
  active: AgendaItem | null;
  done: number;
  total: number;
  onClick?: () => void;
}> = ({ active, done, total, onClick }) => {
  if (total === 0) {
    return (
      <div className="inline-flex items-center gap-1.5 px-2 text-text-muted">
        <span className="material-symbols-outlined text-[14px]">view_agenda</span>
        <span>无议程</span>
      </div>
    );
  }
  const labelPart = active
    ? `当前 · ${active.title || '未命名议项'}`
    : `${total} 个议项`;
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2 rounded-md text-text hover:bg-surface-sunken transition-colors min-w-0"
      title={`议程进度 ${done}/${total}${active ? `\n当前：${active.title}` : ''}`}
    >
      <span className="material-symbols-outlined text-[14px] text-cyan-500">view_agenda</span>
      <span className="truncate max-w-[200px] font-semibold">{labelPart}</span>
      <span className="font-mono text-text-muted text-[10px]">{done}/{total}</span>
    </button>
  );
};

// ── 执行阶段段（仅 planned 策略）──
const ExecutionPhaseSegment: React.FC<{ phase: string }> = ({ phase }) => {
  const meta = EXEC_PHASE_META[phase];
  if (!meta) return null;
  return (
    <div className={`inline-flex items-center gap-1.5 px-2 rounded-md ${meta.tone}`} title={`执行阶段 · ${meta.label}`}>
      <span className="material-symbols-outlined text-[14px]">{meta.icon}</span>
      <span className="font-semibold">{meta.label}</span>
    </div>
  );
};

// ── 工作单结余（任务速览） ──
const TaskSummary: React.FC<{ tasks: { status: string }[] }> = ({ tasks }) => {
  const open = tasks.filter(t => !['done', 'cancelled'].includes(t.status)).length;
  const review = tasks.filter(t => t.status === 'review').length;
  const total = tasks.length;
  if (total === 0) return null;
  return (
    <div
      className="inline-flex items-center gap-1.5 px-2 ms-auto text-text-muted shrink-0"
      title={`任务 · 未完成 ${open} / 待验收 ${review} / 总计 ${total}`}
    >
      <span className="material-symbols-outlined text-[14px] text-emerald-500">task_alt</span>
      <span className="font-mono">{open}</span>
      {review > 0 && (
        <>
          <span className="opacity-60">/</span>
          <span className="font-mono text-violet-500" title="待验收">{review}</span>
        </>
      )}
      <span className="opacity-60 text-[10px]">/{total}</span>
    </div>
  );
};

const Separator: React.FC = () => (
  <div className="w-px self-stretch bg-border/60 my-1" aria-hidden="true" />
);

// ── 续自源房间 chip（v0.3 主题 C） ──
//
// 显示"续自 [源房间标题]"，点击切换到源房间。
// 数据来源：getRoomLineage（懒加载，仅在 room.parentRoomId 存在时挂载）。
const ParentRoomChip: React.FC<{ roomId: string }> = ({ roomId }) => {
  const [lineage, setLineage] = useState<RoomLineage | null>(null);
  useEffect(() => {
    let cancelled = false;
    getRoomLineage(roomId).then(l => {
      if (!cancelled) setLineage(l);
    });
    return () => { cancelled = true; };
  }, [roomId]);
  if (!lineage || !lineage.parent) return null;
  const parent = lineage.parent;
  return (
    <button
      type="button"
      onClick={() => {
        // 通过自定义事件请求父级切换房间（AgentRoom 已监听类似事件）；
        // 若没监听到则退化为不动作（避免硬跳转破坏当前会话状态）。
        window.dispatchEvent(new CustomEvent('agentroom:open-room', {
          detail: { roomId: parent.id },
        }));
      }}
      className="inline-flex items-center gap-1 px-2 rounded-md text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 transition shrink-0"
      title={`续自 [${parent.title}]${lineage.root && lineage.root.id !== parent.id ? `\n根源：[${lineage.root.title}]` : ''}`}
    >
      <span className="material-symbols-outlined text-[14px]">link</span>
      <span className="font-semibold truncate max-w-[180px]">续自 {parent.title}</span>
    </button>
  );
};

export default WorkflowTimeline;
