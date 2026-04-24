// 左栏·房间列表
import React from 'react';
import type { Room } from '../types';
import { POLICY_META } from '../shared';

interface Props {
  rooms: Room[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete?: (id: string, title: string) => void;
  // lastSeen: room id → 上次查看时最后一条消息的 timestamp（ms）。
  // 若 room.updatedAt / room.lastMessageAt > lastSeen[id] → 显示未读小红点。
  lastSeen?: Record<string, number>;
  // 宽屏下的主动折叠回调；不传则不渲染折叠按钮（例如移动端 drawer 里）。
  onCollapse?: () => void;
}

// isUnread 判断房间是否有未读消息：仅对非当前激活房间计算。
// Room 结构里没有显式的 lastMessageAt 字段，这里退化为 updatedAt 近似；
// 服务端返回 Room 时 updatedAt 随最新消息刷新。
function isUnread(r: Room, activeId: string | null, lastSeen?: Record<string, number>): boolean {
  if (!lastSeen) return false;
  if (r.id === activeId) return false;
  const raw: unknown = (r as unknown as { updatedAt?: string | number }).updatedAt;
  let updated = 0;
  if (typeof raw === 'number') updated = raw;
  else if (typeof raw === 'string') updated = Date.parse(raw) || 0;
  const seen = lastSeen[r.id] ?? 0;
  return updated > seen;
}

const RoomsRail: React.FC<Props> = ({ rooms, activeId, onSelect, onCreate, onDelete, lastSeen, onCollapse }) => {
  const active = rooms.filter(r => r.state === 'active' || r.state === 'paused' || r.state === 'draft');
  const archived = rooms.filter(r => r.state === 'closed' || r.state === 'archived');

  return (
    <div className="h-full flex flex-col bg-surface-raised/50 border-e border-border">
      <div className="px-3 h-11 shrink-0 border-b border-border flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="material-symbols-outlined text-[18px] text-cyan-500">forum</span>
          <span className="text-[12px] font-bold tracking-wide truncate">AgentRoom</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onCreate}
            title="新建房间"
            className="w-7 h-7 rounded-md bg-gradient-to-br from-cyan-500 to-blue-500 text-white shadow-[0_2px_8px_rgba(0,200,255,0.3)] hover:shadow-[0_4px_16px_rgba(0,200,255,0.5)] flex items-center justify-center transition-all"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
          </button>
          {onCollapse && (
            <button
              onClick={onCollapse}
              title="折叠房间列表"
              className="w-7 h-7 rounded-md hover:bg-surface-sunken text-text-muted hover:text-text flex items-center justify-center"
            >
              <span className="material-symbols-outlined text-[16px]">left_panel_close</span>
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto neon-scrollbar p-2 space-y-0.5">
        {active.length === 0 && archived.length === 0 && (
          <div className="p-4 text-center">
            <span className="material-symbols-outlined text-[28px] text-text-muted opacity-30">meeting_room</span>
            <p className="text-[11px] text-text-muted mt-2 mb-3">还没有房间</p>
            <button
              onClick={onCreate}
              className="w-full h-8 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 text-white text-[11.5px] font-bold shadow-[0_2px_8px_rgba(0,200,255,0.3)] hover:shadow-[0_4px_16px_rgba(0,200,255,0.5)] transition-all"
            >
              召集你的 AI 团队 →
            </button>
          </div>
        )}
        {active.map(r => <RoomItem key={r.id} room={r} active={r.id === activeId} onClick={() => onSelect(r.id)} onDelete={onDelete ? () => onDelete(r.id, r.title) : undefined} unread={isUnread(r, activeId, lastSeen)} />)}
        {archived.length > 0 && (
          <>
            <div className="px-2 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-text-muted">归档</div>
            {archived.map(r => <RoomItem key={r.id} room={r} active={r.id === activeId} onClick={() => onSelect(r.id)} onDelete={onDelete ? () => onDelete(r.id, r.title) : undefined} unread={false} />)}
          </>
        )}
      </div>
    </div>
  );
};

const RoomItem: React.FC<{ room: Room; active?: boolean; onClick: () => void; onDelete?: () => void; unread?: boolean }> = ({ room, active, onClick, onDelete, unread }) => {
  const meta = POLICY_META[room.policy];
  const stateDot = {
    draft: 'bg-slate-400',
    active: 'bg-green-400 animate-pulse',
    paused: 'bg-amber-400',
    closed: 'bg-slate-500',
    archived: 'bg-slate-600',
  }[room.state];
  const pct = room.budget.limitCNY > 0 ? room.budget.usedCNY / room.budget.limitCNY : 0;
  const warn = pct >= 0.7;

  return (
    <button
      onClick={onClick}
      className={`w-full group p-2 rounded-lg transition-all text-start ${active
        ? 'bg-gradient-to-r from-cyan-500/10 via-blue-500/5 to-transparent ring-1 ring-cyan-400/30 shadow-sm'
        : 'hover:bg-surface-sunken'}`}
    >
      <div className="flex items-center gap-2 mb-1 relative">
        <span className={`w-2 h-2 rounded-full shrink-0 ${stateDot}`} />
        {unread && (
          <span className="absolute -start-1 -top-1 w-2 h-2 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]" aria-label="未读" />
        )}
        <div className="flex-1 min-w-0">
          <div className={`text-[12px] font-semibold truncate ${active ? 'text-text' : 'text-text'}`}>{room.title}</div>
          <div className="flex items-center gap-1.5 text-[10px] text-text-muted mt-0.5">
            <span className="inline-flex items-center gap-0.5">
              <span className="material-symbols-outlined text-[10px]">group</span>
              {room.memberIds.length}
            </span>
            <span className="opacity-40">·</span>
            <span className="inline-flex items-center gap-0.5">
              <span className={`material-symbols-outlined text-[10px] ${meta.color}`}>{meta.icon}</span>
              {meta.label}
            </span>
          </div>
        </div>
        {onDelete && (
          <span
            role="button"
            tabIndex={0}
            onClick={e => { e.stopPropagation(); onDelete(); }}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onDelete(); } }}
            title="删除房间"
            className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded-md hover:bg-red-500/10 hover:text-red-500 flex items-center justify-center text-text-muted transition-opacity"
          >
            <span className="material-symbols-outlined text-[14px]">delete</span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1 rounded-full bg-surface-sunken overflow-hidden">
          <div
            className={`h-full transition-all ${warn ? 'bg-gradient-to-r from-amber-400 to-red-500' : 'bg-gradient-to-r from-cyan-400 to-blue-500'}`}
            style={{ width: `${Math.min(pct * 100, 100)}%` }}
          />
        </div>
        <span className={`text-[10px] font-mono tabular-nums ${warn ? 'text-amber-500' : 'text-text-muted'}`}>
          ¥{room.budget.usedCNY.toFixed(2)}
        </span>
      </div>
      {/* v0.9.1：投影功能已临时下架（UI 无开关），房卡徽章一并隐藏。
          历史数据若有 projection.enabled=true 也不再渲染，避免视觉噪声。 */}
    </button>
  );
};

export default RoomsRail;
