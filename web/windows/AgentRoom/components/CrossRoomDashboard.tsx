// CrossRoomDashboard —— 跨房间工作台（v0.3 主题 D）
//
// 把所有未归档房间汇聚成一张表，并把"待我做的事"集中显示：
//
//   ┌─────────────────────────────────────────────────────────────┐
//   │ 房间                  │ 任务  │ 未完成 │ 待验收 │ 风险 │ 续自 │
//   ├─────────────────────────────────────────────────────────────┤
//   │ 第三方接入·设计评审    │  12   │   4    │   2    │  3   │ —    │
//   │ 接入·实施续会          │   8   │   6    │   1    │  1   │ ←源会 │
//   ├─────────────────────────────────────────────────────────────┤
//   │ 我的待办（assignee=我）│ ...                                   │
//   │ 待我验收（reviewer=我）│ ...                                   │
//   └─────────────────────────────────────────────────────────────┘
//
// 数据来源：getMyDashboard() 一次拉齐。点击房间行 → 派发 'agentroom:open-room'
// 事件，AgentRoom 主面板监听并切换 activeId。

import React, { useEffect, useState } from 'react';
import type { MyDashboard, RoomDashboardSummary, RoomTask } from '../types';
import { getMyDashboard } from '../service';

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenRoom: (roomId: string) => void;
}

const stateLabel: Record<string, string> = {
  draft: '草稿',
  active: '进行中',
  paused: '暂停',
  closed: '已结束',
  archived: '已归档',
};

const stateTone: Record<string, string> = {
  draft: 'text-text-muted bg-surface-sunken',
  active: 'text-emerald-600 bg-emerald-500/10 dark:text-emerald-400',
  paused: 'text-amber-600 bg-amber-500/10 dark:text-amber-400',
  closed: 'text-text-muted bg-surface-sunken',
  archived: 'text-text-muted bg-surface-sunken',
};

const CrossRoomDashboard: React.FC<Props> = ({ open, onClose, onOpenRoom }) => {
  const [data, setData] = useState<MyDashboard | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    let cancelled = false;
    getMyDashboard().then(d => {
      if (!cancelled) {
        setData(d);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[90vw] max-w-[1100px] max-h-[88vh] bg-surface rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="跨房间工作台"
      >
        {/* Header */}
        <div className="px-4 h-12 shrink-0 flex items-center justify-between border-b border-border bg-surface-raised">
          <div className="flex items-center gap-2 min-w-0">
            <span className="material-symbols-outlined text-cyan-500">dashboard</span>
            <span className="font-bold text-[14px]">跨房间工作台</span>
            {data && (
              <span className="ms-2 text-[11px] text-text-muted">
                {data.rooms.length} 房间 · 待我做 {data.myActiveTasks.length} · 待我验收 {data.awaitingMyReview.length}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md hover:bg-surface-sunken text-text-muted hover:text-text flex items-center justify-center"
            title="关闭"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-auto p-4 space-y-5">
          {loading && <div className="text-center py-8 text-text-muted text-[12px]">加载中…</div>}

          {!loading && data && (
            <>
              {/* 我的待办 + 待我验收 */}
              <div className="grid md:grid-cols-2 gap-4">
                <SectionPanel
                  icon="task_alt"
                  tone="text-cyan-500"
                  title="我的待办"
                  count={data.myActiveTasks.length}
                  emptyHint="所有指派给你的任务都已完成"
                  tasks={data.myActiveTasks}
                  onOpenRoom={onOpenRoom}
                  rooms={data.rooms}
                />
                <SectionPanel
                  icon="verified_user"
                  tone="text-violet-500"
                  title="待我验收"
                  count={data.awaitingMyReview.length}
                  emptyHint="目前没有需要你验收的任务"
                  tasks={data.awaitingMyReview}
                  onOpenRoom={onOpenRoom}
                  rooms={data.rooms}
                  emphasize
                />
              </div>

              {/* 房间总表 */}
              <div className="rounded-lg border border-border overflow-hidden">
                <div className="px-3 h-10 flex items-center justify-between bg-surface-raised">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-text-muted text-[16px]">forum</span>
                    <span className="text-[12px] font-semibold">房间总览</span>
                    <span className="text-[10px] text-text-muted">({data.rooms.length})</span>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead className="bg-surface-sunken/50 text-[11px] text-text-muted">
                      <tr>
                        <th className="text-start font-semibold px-3 py-2">房间</th>
                        <th className="text-end font-semibold px-2">任务</th>
                        <th className="text-end font-semibold px-2">未完成</th>
                        <th className="text-end font-semibold px-2">待验收</th>
                        <th className="text-end font-semibold px-2">风险</th>
                        <th className="text-start font-semibold px-3">续自</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rooms.length === 0 && (
                        <tr><td colSpan={6} className="text-center py-6 text-text-muted">还没有房间</td></tr>
                      )}
                      {data.rooms.map(r => (
                        <RoomRow key={r.id} room={r} onOpen={() => onOpenRoom(r.id)} rooms={data.rooms} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ─────────── 子组件 ───────────

const SectionPanel: React.FC<{
  icon: string;
  tone: string;
  title: string;
  count: number;
  emptyHint: string;
  tasks: RoomTask[];
  rooms: RoomDashboardSummary[];
  onOpenRoom: (roomId: string) => void;
  emphasize?: boolean;
}> = ({ icon, tone, title, count, emptyHint, tasks, rooms, onOpenRoom, emphasize }) => {
  const roomTitle = (id: string) => rooms.find(r => r.id === id)?.title || id;
  return (
    <div className={`rounded-lg border ${emphasize && count > 0 ? 'border-violet-500/40 bg-violet-500/5' : 'border-border'}`}>
      <div className="px-3 h-9 flex items-center gap-2 border-b border-border bg-surface-raised">
        <span className={`material-symbols-outlined text-[16px] ${tone}`}>{icon}</span>
        <span className="text-[12px] font-semibold">{title}</span>
        <span className="text-[10px] text-text-muted">({count})</span>
      </div>
      <div className="p-2 space-y-1 max-h-[280px] overflow-auto">
        {tasks.length === 0 && (
          <div className="text-[11px] text-text-muted text-center py-4">{emptyHint}</div>
        )}
        {tasks.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => onOpenRoom(t.roomId)}
            className="w-full text-start p-2 rounded-md hover:bg-surface-sunken transition group"
          >
            <div className="text-[12px] line-clamp-2 group-hover:text-cyan-600 dark:group-hover:text-cyan-400">
              {t.text}
            </div>
            <div className="text-[10px] text-text-muted mt-0.5 flex items-center gap-1">
              <span className="material-symbols-outlined text-[11px]">forum</span>
              <span className="truncate">{roomTitle(t.roomId)}</span>
              {t.dependsOn && t.dependsOn.length > 0 && (
                <span className="ms-auto inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
                  <span className="material-symbols-outlined text-[11px]">link</span>
                  依赖 {t.dependsOn.length}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};

const RoomRow: React.FC<{
  room: RoomDashboardSummary;
  rooms: RoomDashboardSummary[];
  onOpen: () => void;
}> = ({ room, rooms, onOpen }) => {
  const parent = room.parentRoomId
    ? rooms.find(r => r.id === room.parentRoomId)
    : null;
  return (
    <tr className="border-t border-border hover:bg-surface-sunken/40 cursor-pointer transition" onClick={onOpen}>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${stateTone[room.state] || stateTone.draft}`}>
            {stateLabel[room.state] || room.state}
          </span>
          <span className="font-medium truncate">{room.title}</span>
        </div>
      </td>
      <td className="px-2 text-end tabular-nums text-text-muted">{room.taskCount}</td>
      <td className={`px-2 text-end tabular-nums ${room.openCount > 0 ? 'text-cyan-600 dark:text-cyan-400 font-semibold' : 'text-text-muted'}`}>{room.openCount}</td>
      <td className={`px-2 text-end tabular-nums ${room.reviewCount > 0 ? 'text-violet-600 dark:text-violet-400 font-semibold' : 'text-text-muted'}`}>{room.reviewCount}</td>
      <td className={`px-2 text-end tabular-nums ${room.riskCount > 0 ? 'text-amber-600 dark:text-amber-400 font-semibold' : 'text-text-muted'}`}>{room.riskCount}</td>
      <td className="px-3 text-[11px] text-text-muted truncate max-w-[180px]">
        {parent ? (
          <span className="inline-flex items-center gap-0.5 text-indigo-600 dark:text-indigo-400">
            <span className="material-symbols-outlined text-[12px]">link</span>
            {parent.title}
          </span>
        ) : '—'}
      </td>
    </tr>
  );
};

export default CrossRoomDashboard;
