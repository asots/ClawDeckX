// 顶栏：房间标题 + 投影状态 + 时间轴 + 经验库
//
// v0.8+ 改版说明：
//   1. 删除“新手 / 标准 / 高手模式”下拉——之前只隐藏/显示右侧几个面板，价值有限，
//      平添认知负担。直接全展示所有面板（用户通过 CollapsibleSection 自己折叠）。
//   2. 新增 onExpandLeft / onExpandRight —— 当左/右侧栏被用户折叠后，这两个
//      按钮以内嵌方式出现在顶栏头/尾，避免之前 absolute 布局遮挡顶栏内容。
import React from 'react';
import type { Room } from '../types';

type RuntimeState = 'draft' | 'active' | 'paused' | 'awaiting_user' | 'closeout' | 'closed' | 'archived';

interface Props {
  room: Room;
  runtimeState?: RuntimeState;
  runtimeHint?: string;
  // v0.9.1：投影按钮已下架（UI 只渲染经验库 / 设置），prop 保留可选位仅为向后兼容。
  onToggleProjection?: () => void;
  onShowTimeline: () => void;
  onOpenPlaybooks?: () => void;
  onOpenSettings?: () => void;
  onCloseMeeting?: () => void;  // v0.7 关闭仪式入口
  // v0.8 新增：继续会议——后端插 human:nudge 消息 → 重置 MaxConsecutive → 跑下一轮。
  // 会议 active/paused 都可用（paused 会自动 resume 到 active）；closed/archived 隐藏。
  onNudge?: () => void;
  // v1.0：统一状态感知 —— 暂停/继续 合并到 TopBar
  onTogglePause?: () => void | Promise<void>;
  agentsActive?: boolean;
  // v1.0：“继续会议”已点击，等待 agent 响应中（空档期 loading）
  nudgePending?: boolean;
  // v0.9.1 新增：重启会议——将 closed 房间拉回 paused，所有产出物保留。
  // 仅在 closed/archived 态下可用；非关闭态下不会在下拉里出现。
  onReopenRoom?: () => void | Promise<void>;
  // v0.8 新增：清理本房间的 OpenClaw gateway session——仅释放上游资源，不删 DB 任何数据。
  // 通常出现在关闭后的下拉里（确定不再续轮）；父级已包裹确认对话。
  onPurgeSessions?: () => void;
  // v0.9.2 新增：导出会议 HTML
  onExportHtml?: () => void;
  // v0.8 新增：会议深度徽章插槽。让 AgentRoom 计算指标并传入，TopBar 只负责摆位。
  // 插槽方式避免 TopBar 直接依赖 messages/members，维持顶栏组件的纯展示属性。
  depthBadge?: React.ReactNode;
  onRename?: (title: string) => void;
  /**
   * 当左侧房间列被折叠时会传入此回调；顶栏在头部渲染展开按钮。未传入时不渲染。
   */
  onExpandLeft?: () => void;
  /**
   * 当右侧面板被折叠时会传入此回调；顶栏在尾部渲染展开按钮。未传入时不渲染。
   */
  onExpandRight?: () => void;
}

const TopBar: React.FC<Props> = ({
  runtimeState,
  runtimeHint,
  room, onToggleProjection,
  onShowTimeline, onOpenPlaybooks, onOpenSettings, onCloseMeeting, onNudge, onTogglePause, agentsActive, nudgePending, onReopenRoom, onPurgeSessions, onExportHtml, depthBadge, onRename,
  onExpandLeft, onExpandRight,
}) => {
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState(room.title);

  React.useEffect(() => setTitleDraft(room.title), [room.id, room.title]);

  const effectiveState = runtimeState || room.state;
  const paused = effectiveState === 'paused';
  const meetingClosed = effectiveState === 'closed' || effectiveState === 'archived';
  const closeoutRunning = effectiveState === 'closeout';
  // v1.0：active 子态 dot 区分"有 agent 忙"和"空闲等待"
  const activeDot = agentsActive
    ? 'bg-emerald-400 animate-pulse'    // 运行中：绿色脉冲
    : 'bg-slate-400 animate-[pulse_3s_ease-in-out_infinite]'; // 空闲：灰色慢呼吸
  const stateMeta: Record<RuntimeState, { dot: string; badge: string; label: string; icon: string }> = {
    draft: { dot: 'bg-slate-400', badge: 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/30', label: '待开始', icon: 'edit_calendar' },
    active: { dot: activeDot, badge: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30', label: agentsActive ? '运行中' : '等待中', icon: agentsActive ? 'play_circle' : 'schedule' },
    paused: { dot: 'bg-amber-400', badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30', label: '已暂停', icon: 'pause_circle' },
    awaiting_user: { dot: 'bg-amber-400 animate-pulse', badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30', label: '等待你拍板', icon: 'pan_tool' },
    closeout: { dot: 'bg-cyan-400 animate-pulse', badge: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border-cyan-500/30', label: '总结收尾中', icon: 'inventory_2' },
    closed: { dot: 'bg-slate-400', badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30', label: '已关闭', icon: 'block' },
    archived: { dot: 'bg-slate-500', badge: 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/30', label: '已归档', icon: 'archive' },
  };
  const currentStateMeta = stateMeta[effectiveState];

  return (
    <div className="relative z-30 shrink-0 h-11 flex items-center gap-2 px-3 bg-surface-overlay backdrop-blur-md border-b border-border neon-divider min-w-0">
      {/* 左侧房间列展开按钮（在左侧栏折叠时显示） */}
      {onExpandLeft && (
        <button
          onClick={onExpandLeft}
          title="展开房间列表"
          className="w-7 h-7 rounded-md bg-surface-raised hover:bg-surface-sunken border border-border flex items-center justify-center text-text-secondary hover:text-text transition-all shrink-0"
        >
          <span className="material-symbols-outlined text-[15px]">left_panel_open</span>
        </button>
      )}
      {/* 标题 —— v0.9：不再 flex-1 抢空间，改 shrink + 软上限，
          把多余宽度让给中间的 depthBadge / runtimeHint（常见被截断的是接龙/并行的深度徽章）。 */}
      <div className="flex items-center gap-2 min-w-0 shrink max-w-[14rem] lg:max-w-[18rem]">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${currentStateMeta.dot}`}
          title={currentStateMeta.label}
        />
        {editingTitle ? (
          <input
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onBlur={() => { onRename?.(titleDraft || room.title); setEditingTitle(false); }}
            onKeyDown={e => {
              if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
              if (e.key === 'Escape') { setTitleDraft(room.title); setEditingTitle(false); }
            }}
            className="flex-1 min-w-0 bg-transparent text-[13px] font-bold text-text outline-none border-b border-cyan-500"
            autoFocus
          />
        ) : (
          <button
            onClick={() => setEditingTitle(true)}
            className="min-w-0 text-[13px] font-bold text-text truncate hover:text-cyan-500 transition-colors text-start"
            title="点击重命名"
          >
            {room.title}
          </button>
        )}
      </div>

      {/* v0.9：中间信息条。
          · 标题左侧已有彩色圆点 → 常态 (active/draft) pill 冗余，移除
          · MessageStream 上方有专门的 runtime banner（paused/draft/awaiting_user/closeout 四态），
            再在 topbar 重复一遍同样文案会造成"暂停 × 已暂停 × 房间已暂停"三重噪点，
            因此这四态下 TopBar 不再画 state pill / runtimeHint pill，把空间让给 depthBadge。
          · 只有下方 banner 不覆盖的 closed / archived 态才保留顶栏 state pill。 */}
      <div className="hidden md:flex items-center gap-1.5 min-w-0 flex-1">
        {/* v0.9.1：房间关闭后，下方 Composer 已有醒目的"会议已关闭"横幅，
            顶栏的深度徽端 + 状态/产出 pill 会重复曝露三个相同含义的状态块
            （用户反馈图）。关闭态下仅保留右侧 MeetingActions，顶栏中间区域留空。 */}
        {!meetingClosed && depthBadge}

        {!meetingClosed && runtimeHint &&
          effectiveState !== 'paused' &&
          effectiveState !== 'draft' &&
          effectiveState !== 'awaiting_user' &&
          effectiveState !== 'closeout' && null /* kept-below */}

        {/* runtimeHint 只在"下方没有 banner 覆盖"的状态里出现。
            banner 覆盖的状态：paused / draft / awaiting_user / closeout / closed / archived
            —— 这些下方已有大块横幅。
            留给 runtimeHint 的场景：active 态下的临时提示（如"当前较安静"之类）。 */}
        {runtimeHint &&
          !meetingClosed &&
          effectiveState !== 'paused' &&
          effectiveState !== 'draft' &&
          effectiveState !== 'awaiting_user' &&
          effectiveState !== 'closeout' && (
            <div
              className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30 min-w-0"
              title={runtimeHint}
            >
              <span className="material-symbols-outlined text-[13px] shrink-0">info</span>
              <span className="text-[11px] font-semibold truncate">{runtimeHint}</span>
            </div>
          )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
      {/* v0.9：投影 / 经验库 / 设置 三个按钮已下沉到 LiveControlsPanel（会议控制台），
          顶栏仅保留会议控制下拉 + 左右栏展开按钮，给"讨论中/当前较安静"等运行态留空间。
          props 保留以维持父组件接口向后兼容；顶栏只负责把它们传给父级的其它消费者。 */}

      {/* v0.8 会议控制下拉：合并继续 / 关闭 / 清理会话等会议级操作。组件内部根据
          room.state 选不同主按钮 + 下拉内容；closed/archived 时主按钮变为“已关闭”徒标，
          下拉里只保留“清理 AI 会话”。 */}
      {(onNudge || onCloseMeeting || onPurgeSessions || onReopenRoom || onExportHtml) && effectiveState !== 'archived' && (
        <MeetingActions
          roomState={effectiveState}
          onNudge={onNudge}
          onTogglePause={onTogglePause}
          onCloseMeeting={onCloseMeeting}
          onReopenRoom={onReopenRoom}
          onPurgeSessions={onPurgeSessions}
          onExportHtml={onExportHtml}
          paused={paused}
          closeoutRunning={closeoutRunning}
          meetingClosed={meetingClosed}
          agentsActive={!!agentsActive}
          nudgePending={!!nudgePending}
        />
      )}

      {/* 右侧面板展开按钮（在右侧栏折叠时显示） */}
      {onExpandRight && (
        <button
          onClick={onExpandRight}
          title="展开右侧面板"
          className="w-7 h-7 rounded-md bg-surface-raised hover:bg-surface-sunken border border-border flex items-center justify-center text-text-secondary hover:text-text transition-all shrink-0"
        >
          <span className="material-symbols-outlined text-[15px]">right_panel_open</span>
        </button>
      )}
      </div>

    </div>
  );
};

// MeetingActions —— 顶栏会议控制组合按钮。
//
// v1.0 全面重构：统一状态感知。
//   主按钮随状态切换：
//     - active + agents 活动中 → 「⏸ 暂停会议」（用户明确知道系统在跑）
//     - active + 空闲 / paused → 「▶ 继续会议」（让 agent 再跑一轮 / 解除暂停）
//     - closeout → spinner「收尾中」
//     - closed  → badge「已关闭」
//   下拉菜单：关闭会议 / 导出 / 清理 / 重启
const MeetingActions: React.FC<{
  roomState: string;
  onNudge?: () => void;
  onTogglePause?: () => void | Promise<void>;
  onCloseMeeting?: () => void;
  onReopenRoom?: () => void | Promise<void>;
  onPurgeSessions?: () => void;
  onExportHtml?: () => void;
  paused: boolean;
  closeoutRunning: boolean;
  meetingClosed: boolean;
  agentsActive: boolean;
  nudgePending: boolean;
}> = ({ roomState, onNudge, onTogglePause, onCloseMeeting, onReopenRoom, onPurgeSessions, onExportHtml, paused, closeoutRunning, meetingClosed, agentsActive, nudgePending }) => {
  const [open, setOpen] = React.useState(false);
  const [pauseBusy, setPauseBusy] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handlePauseClick = async () => {
    if (pauseBusy || !onTogglePause) return;
    setPauseBusy(true);
    try { await onTogglePause(); } finally { setPauseBusy(false); }
  };

  const isClosed = meetingClosed;
  // 主按钮状态机：
  //   active + agentsActive → 暂停会议（系统正在跑，用户能看到活动，最常见操作是暂停）
  //   active + !agentsActive → 继续会议（空闲，最常见操作是推动下一轮）
  //   paused → 继续会议（解除暂停）
  const showPause = !isClosed && !closeoutRunning && !paused && agentsActive;
  const showContinue = !isClosed && !closeoutRunning && (paused || !agentsActive);
  const menuNeeded = isClosed
    ? !!onPurgeSessions || !!onReopenRoom || !!onExportHtml
    : !!onCloseMeeting || !!onExportHtml || (showPause && !!onNudge);

  return (
    <div ref={rootRef} className="relative z-40 inline-flex items-stretch shrink-0">
      {closeoutRunning ? (
        <span
          className="inline-flex items-center gap-1 px-2 h-7 rounded-s-md text-[11px] font-semibold bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30 border-e-0"
          aria-label="会议正在收尾总结"
        >
          <span className="material-symbols-outlined text-[13px] animate-spin">progress_activity</span>
          <span className="hidden lg:inline">收尾中</span>
        </span>
      ) : isClosed ? (
        <span
          className="inline-flex items-center gap-1 px-2 h-7 rounded-s-md text-[11px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 border-e-0"
          aria-label="会议已关闭"
        >
          <span className="material-symbols-outlined text-[13px]">check_circle</span>
          <span className="hidden lg:inline">已关闭</span>
        </span>
      ) : showPause ? (
        <button
          onClick={handlePauseClick}
          disabled={pauseBusy}
          title="暂停会议（Space）"
          className={`inline-flex items-center gap-1 ps-2 pe-2 h-7 rounded-s-md text-[11.5px] font-semibold border transition-all ${pauseBusy
            ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/40 cursor-wait'
            : 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500/30'}`}
        >
          <span className={`material-symbols-outlined text-[14px] ${pauseBusy ? 'animate-spin' : ''}`}>
            {pauseBusy ? 'progress_activity' : 'pause'}
          </span>
          <span className="hidden lg:inline">{pauseBusy ? '暂停中…' : '暂停会议'}</span>
        </button>
      ) : showContinue && onNudge ? (
        <button
          onClick={nudgePending ? undefined : onNudge}
          disabled={nudgePending}
          title={nudgePending ? '正在启动下一轮…' : paused ? '继续会议（解除暂停并跑下一轮）' : '继续会议（让 agent 再交锋一轮）'}
          className={`inline-flex items-center gap-1 ps-2 pe-2 h-7 rounded-s-md text-[11.5px] font-semibold border transition-all ${nudgePending
            ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/40 cursor-wait'
            : 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 border-e-0'}`}
        >
          <span className={`material-symbols-outlined text-[14px] ${nudgePending ? 'animate-spin' : ''}`}>
            {nudgePending ? 'progress_activity' : 'play_arrow'}
          </span>
          <span className="hidden lg:inline">{nudgePending ? '启动中…' : '继续会议'}</span>
        </button>
      ) : onCloseMeeting ? (
        <button
          onClick={onCloseMeeting}
          title="关闭会议 · 一键生成纪要/Todo/Playbook/复盘"
          className="inline-flex items-center gap-1 px-2.5 h-7 rounded-md text-[11.5px] font-semibold bg-gradient-to-r from-cyan-500 to-purple-500 hover:from-cyan-600 hover:to-purple-600 text-white transition-all shadow-sm"
        >
          <span className="material-symbols-outlined text-[14px]">flag</span>
          <span className="hidden lg:inline">终止会议</span>
        </button>
      ) : null}
      {/* ▾ 下拉触发 */}
      {menuNeeded && !closeoutRunning && (
        <button
          onClick={() => setOpen(o => !o)}
          title="更多会议操作"
          aria-haspopup="menu"
          aria-expanded={open}
          className={`inline-flex items-center justify-center w-6 h-7 rounded-e-md text-[11.5px] font-semibold border transition-all ${open
            ? (showPause ? 'bg-amber-500/30 text-amber-700 dark:text-amber-200 border-amber-500/30' : 'bg-emerald-500/30 text-emerald-700 dark:text-emerald-200 border-emerald-500/30')
            : (showPause ? 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-700 dark:text-amber-300 border-amber-500/30' : 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-700 dark:text-emerald-300 border-emerald-500/30')}`}
        >
          <span className="material-symbols-outlined text-[14px]">arrow_drop_down</span>
        </button>
      )}

      {/* 下拉菜单 */}
      {open && (
        <div
          role="menu"
          className="absolute end-0 top-8 z-[200] w-52 rounded-md bg-surface-overlay backdrop-blur-md border border-border shadow-lg py-1 animate-fade-in"
        >
          {/* 运行中时，下拉里放"继续会议"（nudge 追加一轮） */}
          {!isClosed && !paused && agentsActive && onNudge && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onNudge(); }}
              className="w-full px-3 h-9 inline-flex items-center gap-2 text-[12px] text-text hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors text-start"
            >
              <span className="material-symbols-outlined text-[15px] text-emerald-500">skip_next</span>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">追加一轮</div>
                <div className="text-[10.5px] text-text-muted truncate">让 agent 再交锋一轮</div>
              </div>
            </button>
          )}
          {!isClosed && onCloseMeeting && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onCloseMeeting(); }}
              className="w-full px-3 h-9 inline-flex items-center gap-2 text-[12px] text-text hover:bg-surface-raised transition-colors text-start"
            >
              <span className="material-symbols-outlined text-[15px] text-purple-500">flag</span>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">终止会议</div>
                <div className="text-[10.5px] text-text-muted truncate">生成纪要 / Todo / Playbook</div>
              </div>
            </button>
          )}
          {isClosed && onReopenRoom && (
            <button
              role="menuitem"
              onClick={async () => { setOpen(false); await onReopenRoom(); }}
              className="w-full px-3 h-9 inline-flex items-center gap-2 text-[12px] text-text hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors text-start"
            >
              <span className="material-symbols-outlined text-[15px] text-emerald-500">play_circle</span>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">重启会议</div>
                <div className="text-[10.5px] text-text-muted truncate">重新打开房间，继续讨论（产出保留）</div>
              </div>
            </button>
          )}
          {onExportHtml && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onExportHtml(); }}
              className="w-full px-3 h-9 inline-flex items-center gap-2 text-[12px] text-text hover:bg-surface-raised transition-colors text-start"
            >
              <span className="material-symbols-outlined text-[15px] text-cyan-500">download</span>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">导出会议</div>
                <div className="text-[10.5px] text-text-muted truncate">导出为可分享的 HTML 文件</div>
              </div>
            </button>
          )}
          {isClosed && onPurgeSessions && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onPurgeSessions(); }}
              className="w-full px-3 h-9 inline-flex items-center gap-2 text-[12px] text-text hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-300 transition-colors text-start"
            >
              <span className="material-symbols-outlined text-[15px] text-amber-500">cleaning_services</span>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">清理 AI 会话</div>
                <div className="text-[10.5px] text-text-muted truncate">仅释放网关 session，房间数据保留</div>
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default TopBar;
