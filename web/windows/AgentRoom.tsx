// AgentRoom —— 原生 AI 会议室（DESIGN.md v0.2）
// 三栏布局：房间列表 / 消息流 / 成员面板；响应式：中宽变双栏，窄宽全屏 + 抽屉
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { Language } from '../types';
import { getTranslation } from '../locales';
import type { NextMeetingDraft, PlaybookHighlightContext, Room, RoomPolicy } from './AgentRoom/types';
import { useRoom, useHotkeys } from './AgentRoom/useRoom';
import { useUnseenCounts } from './AgentRoom/useUnseenCounts';
import { useBusy } from './AgentRoom/useBusy';
import {
  listRooms, createRoomFromTemplate, createCustomRoom, setRoomState, setRoomPolicy,
  postUserMessage, editMessage, deleteMessage, reactMessage,
  forkRoom, upsertFact, deleteFact, setWhiteboard,
  addTask, updateTask, kickMember, toggleMute, forceNextSpeaker,
  emergencyStop, nudgeRoom, updateRoom, deleteRoom, roomEvents, exportRoom,
  // v0.6
  synthesizeMinutes, extractTodo, askAll, promoteDecision, demoteDecision, rerunMessage,
  getDecisionImpact,
  fetchSystemModels, updateMemberModel, updateMemberAgent, updateMemberThinking, updateMemberSystemPrompt,
  purgeRoomSessions, reopenRoom, inviteBackMember,
  listGatewayAgents, getGatewayStatus,
  addMember, removeMember,
  createSchedule,
} from './AgentRoom/service';
import type { SystemModel } from './AgentRoom/service';
import type { Message as RoomMessage, GatewayAgentInfo } from './AgentRoom/types';
import type { CreateRequest, SchedulePayload } from './AgentRoom/components/CreateRoomWizard';

import TopBar from './AgentRoom/components/TopBar';
import WorkflowTimeline from './AgentRoom/components/WorkflowTimeline';
import MeetingDepthBadge from './AgentRoom/components/MeetingDepthBadge';
import RoomsRail from './AgentRoom/components/RoomsRail';
import MessageStream from './AgentRoom/components/MessageStream';
import Composer from './AgentRoom/components/Composer';
import ActivityStrip from './AgentRoom/components/ActivityStrip';
import MemberRail from './AgentRoom/components/MemberRail';
import MemoryPanel from './AgentRoom/components/MemoryPanel';
import DocsPanel from './AgentRoom/components/DocsPanel';
import PlanningPanel from './AgentRoom/components/PlanningPanel';
// v0.9：SafetyPanel 已被 LiveControlsPanel 的两个开关替代；保留文件尚未删除，
// 防止其它地方引用。需要实时两个开关时直接用会议控制台。
// import SafetyPanel from './AgentRoom/components/SafetyPanel';
import LiveControlsPanel from './AgentRoom/components/LiveControlsPanel';
import DecisionsPanel from './AgentRoom/components/DecisionsPanel';
import ArtifactsPanel from './AgentRoom/components/ArtifactsPanel';
// v0.9.1：QualityPanel 已废弃 —— "房间目标 / 预期 agent 轮次 / 房间宪法 / 自我批判回合"
// 全部合并进 LiveControlsPanel（配置面板），此文件保留以供向后兼容未来若需重开。
// import QualityPanel from './AgentRoom/components/QualityPanel';
import QualityMetricsPanel from './AgentRoom/components/QualityMetricsPanel';
import HumanNeededBanner from './AgentRoom/components/HumanNeededBanner';
import AwaySummaryBanner from './AgentRoom/components/AwaySummaryBanner';
import TimeboxMeter from './AgentRoom/components/TimeboxMeter';
import PlaybookLibraryModal from './AgentRoom/components/PlaybookLibraryModal.v7';
import RoomSettingsModal from './AgentRoom/components/RoomSettingsModal';
// v0.7 真实会议环节
import AgendaRail from './AgentRoom/components/AgendaRail';
import QuestionsPanel from './AgentRoom/components/QuestionsPanel';
import ParkingLotPanel from './AgentRoom/components/ParkingLotPanel';
import RisksPanel from './AgentRoom/components/RisksPanel';
import VotePanel from './AgentRoom/components/VotePanel';
import MeetingCloseoutModal from './AgentRoom/components/MeetingCloseoutModal';
import OutcomeBundleView from './AgentRoom/components/OutcomeBundleView';
import type { AgendaItem } from './AgentRoom/types';
import PersonaMemoryModal from './AgentRoom/components/PersonaMemoryModal';
import AddMemberModal from './AgentRoom/components/AddMemberModal';
import WhiteboardPanel from './AgentRoom/components/WhiteboardPanel';
import TasksPanel from './AgentRoom/components/TasksPanel';
import CrossRoomDashboard from './AgentRoom/components/CrossRoomDashboard';
import SchedulePanel from './AgentRoom/components/SchedulePanel';
import MetricsPanel from './AgentRoom/components/MetricsPanel';
import CreateRoomWizard from './AgentRoom/components/CreateRoomWizard';
import TimelineOverlay from './AgentRoom/components/TimelineOverlay';
import SearchPanel from './AgentRoom/components/SearchPanel';
import { CollapsibleSection, CostMeter } from './AgentRoom/shared';
import { useConfirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { exportMeetingHtml } from './AgentRoom/exportMeetingHtml';

interface AgentRoomProps {
  language: Language;
}

const ACTIVE_ROOM_KEY = 'agentroom_active_id';

const AgentRoom: React.FC<AgentRoomProps> = ({ language }) => {
  const { confirm } = useConfirm();
  const { toast } = useToast();
  const t = useMemo(() => getTranslation(language) as any, [language]);
  const arm = (t?.multiAgentRoom || {}) as Record<string, string>;
  const tx = useCallback((k: string, fb: string) => arm[k] || fb, [arm]);
  // ── 全局状态 ──
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // v0.8+ 移除交互模式切换——默认全展示所有面板（用户自己折叠）。
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [creatorInitialMode, setCreatorInitialMode] = useState<'template' | 'custom' | 'ai' | undefined>(undefined);
  const [creatorInitialDraft, setCreatorInitialDraft] = useState<NextMeetingDraft | undefined>(undefined);
  // Retro 「设为定时续会」入口会设为 true —— 向导会预勾选 ScheduleToggle。
  const [creatorScheduleEnabled, setCreatorScheduleEnabled] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [playbooksOpen, setPlaybooksOpen] = useState(false);
  const [playbookEditorTargetId, setPlaybookEditorTargetId] = useState<string | null>(null);
  const [playbookHighlightContext, setPlaybookHighlightContext] = useState<PlaybookHighlightContext | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // v0.7 关闭仪式 + 当前激活的议项（供 VotePanel 使用）
  const [closeoutOpen, setCloseoutOpen] = useState(false);
  const [closeoutRunning, setCloseoutRunning] = useState(false);
  const [activeAgendaItem, setActiveAgendaItem] = useState<AgendaItem | null>(null);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  // 宽屏下用户主动折叠偏好 —— localStorage 持久化，方便把中间聊天区最大化。
  // 与 drawer 不同：drawer 只在窄屏响应式打开；collapse 是宽屏下的"强制隐藏"。
  const [leftCollapsed, setLeftCollapsed] = useState(() => {
    try { return localStorage.getItem('agentroom_left_collapsed') === '1'; } catch { return false; }
  });
  const [rightCollapsed, setRightCollapsed] = useState(() => {
    try { return localStorage.getItem('agentroom_right_collapsed') === '1'; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem('agentroom_left_collapsed', leftCollapsed ? '1' : '0'); } catch {} }, [leftCollapsed]);
  useEffect(() => { try { localStorage.setItem('agentroom_right_collapsed', rightCollapsed ? '1' : '0'); } catch {} }, [rightCollapsed]);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 1440);
  // WS 连接状态
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  // 引用消息（回复）
  const [replyTo, setReplyTo] = useState<RoomMessage | null>(null);
  // 快捷键 cheatsheet 开关
  const [helpOpen, setHelpOpen] = useState(false);
  // 搜索面板开关
  const [searchOpen, setSearchOpen] = useState(false);
  // v0.3 主题 D：跨房间工作台
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  useEffect(() => {
    // 监听 ParentRoomChip / Dashboard 等组件派发的"切换到目标房间"事件
    const onOpenRoom = (e: Event) => {
      const detail = (e as CustomEvent<{ roomId?: string }>).detail;
      if (detail?.roomId) {
        setActiveId(detail.roomId);
        setDashboardOpen(false);
      }
    };
    window.addEventListener('agentroom:open-room', onOpenRoom);
    return () => window.removeEventListener('agentroom:open-room', onOpenRoom);
  }, []);
  // 未读追踪：房间 id → 最后一次用户查看时的消息 timestamp（按 ms）
  const [lastSeen, setLastSeen] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('agentroom_last_seen') || '{}'); } catch { return {}; }
  });
  // 系统已配置模型列表（供成员面板模型选择器使用）
  const [systemModels, setSystemModels] = useState<SystemModel[]>([]);
  // v0.4：OpenClaw Gateway agent 目录（供 MemberRail 成员的 agent 切换下拉）
  const [gatewayAgents, setGatewayAgents] = useState<GatewayAgentInfo[]>([]);

  // 加载系统模型
  useEffect(() => {
    fetchSystemModels().then(setSystemModels).catch(() => {});
  }, []);

  // 加载 OpenClaw agents；gateway 离线时降级为空数组（下拉只剩 "默认 agent"）。
  // 订阅 gateway.status 事件在网关重连后刷新。
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      getGatewayStatus().then(st => {
        if (cancelled) return;
        if (st.available) {
          listGatewayAgents().then(list => { if (!cancelled) setGatewayAgents(list); }).catch(() => {});
        } else {
          setGatewayAgents([]);
        }
      }).catch(() => {});
    };
    refresh();
    const off = roomEvents.on('gateway.status', refresh);
    return () => { cancelled = true; off?.(); };
  }, []);

  // 订阅 WS 连接状态 + API 错误事件（toast）
  useEffect(() => {
    const offStatus = roomEvents.on('ws.status', ev => {
      setWsStatus(ev.status);
      if (ev.reconnected) {
        // 重连成功后走全局 macOS 风格 toast（顶部居中），与其他模块一致
        toast('success', tx('toastReconnected', 'Reconnected — latest state synced'), 3000);
      }
    });
    const offError = roomEvents.on('api.error', ev => {
      toast('error', ev.message, 4500);
    });
    return () => { offStatus && offStatus(); offError && offError(); };
  }, []);

  // ── 响应式断点 ──
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const isWide = viewportWidth >= 1440;
  const isMedium = viewportWidth >= 1024 && viewportWidth < 1440;
  const isNarrow = viewportWidth >= 720 && viewportWidth < 1024;
  const isMobile = viewportWidth < 720;

  // ── 初始化房间列表 ──
  useEffect(() => {
    listRooms().then(rs => {
      setRooms(rs);
      const saved = localStorage.getItem(ACTIVE_ROOM_KEY);
      const exist = rs.find(r => r.id === saved);
      setActiveId(exist ? saved : rs[0]?.id || null);
    });
  }, []);

  // ── 房间变化时刷新列表（简易轮询，真实接入后用 WS）──
  const snap = useRoom(activeId);

  useEffect(() => {
    if (!snap.room) return;
    setRooms(prev => {
      const idx = prev.findIndex(r => r.id === snap.room!.id);
      if (idx < 0) return [snap.room!, ...prev];
      const next = [...prev];
      next[idx] = snap.room!;
      return next;
    });
  }, [snap.room]);

  // ── 持久化选中房间 ──
  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_ROOM_KEY, activeId);
  }, [activeId]);


  // ── 人类 "You" 成员 id ──
  const meId = useMemo(() => {
    return snap.members.find(m => m.kind === 'human')?.id || 'me';
  }, [snap.members]);

  // ── 快捷键 ──
  const handleTogglePause = useCallback(async () => {
    if (!snap.room) return;
    if (snap.room.state === 'active') {
      const ok = await confirm({
        title: tx('pauseTitle', 'Pause current meeting?'),
        message: tx('pauseMsg', 'This will immediately stop the agent turn in progress and switch the room to paused.'),
        confirmText: tx('pauseConfirm', 'Pause now'),
        danger: true,
      });
      if (!ok) return;
      await emergencyStop(snap.room.id, 'user pressed pause');
      return;
    }
    await setRoomState(snap.room.id, 'active');
  }, [confirm, snap.room]);

  useHotkeys({
    ' ': () => handleTogglePause(),
    '⌘b': () => {
      const last = snap.messages[snap.messages.length - 1];
      if (snap.room && last) handleFork(last.id);
    },
    '⌘m': () => setRightDrawerOpen(p => !p),
    'Escape': () => { setCreatorOpen(false); setTimelineOpen(false); setLeftDrawerOpen(false); setRightDrawerOpen(false); },
  });

  // ── 操作回调 ──

  // v0.9.1：onSend options 扩展 attachments —— Composer 上传/粘贴/拖放图片后填入。
  // attachments 走后端 POST 持久化并转发给 OpenClaw agent RPC，而不是在 content 里嵌 Markdown。
  const handleSend = useCallback((content: string, opts: { mentionIds?: string[]; actingAsId?: string; whisperTargetIds?: string[]; referenceMessageId?: string; attachments?: import('./AgentRoom/types').MessageAttachment[] }) => {
    if (!snap.room) return;
    const roomId = snap.room.id;
    // 乐观 UI：立即把占位消息推入事件总线，让用户立刻看到"我"说的话，
    // 不等 WS 回推也不等 HTTP 往返。真实消息回来后 useRoom 会按 idempotencyKey 去重。
    postUserMessage(roomId, meId, content, opts).then(placeholder => {
      roomEvents.emit('message.append', { roomId, message: placeholder });
    }).catch(() => { /* postUserMessage 内部 withToast 已触发错误提示 */ });
  }, [snap.room, meId]);

  // 创建/派生/删除房间的双击守护 —— 全部走 useBusy，避免用户连点造成重复房间。
  const createBusy = useBusy();
  const forkBusy = useBusy();
  const deleteBusy = useBusy();

  const handleCreate = useCallback(async (req: CreateRequest) => {
    await createBusy.run(async () => {
      const room = req.kind === 'template'
        ? await createRoomFromTemplate(req.templateId, {
            title: req.title,
            initialPrompt: req.initialPrompt,
            budgetCNY: req.budgetCNY,
            memberOverrides: req.memberOverrides,
            auxModel: req.auxModel,
            conflictMode: req.conflictMode,
            disabledInitialTaskIndices: req.disabledInitialTaskIndices,
          })
        : await createCustomRoom({
            title: req.title,
            goal: req.goal,
            members: req.members,
            auxModel: req.auxModel,
            policy: req.policy,
            budgetCNY: req.budgetCNY,
            initialPrompt: req.initialPrompt,
            conflictMode: req.conflictMode,
            roundBudget: req.roundBudget,
            collaborationStyle: req.collaborationStyle,
            initialTasks: req.initialTasks,
            defaultDispatchMode: req.defaultDispatchMode,
          });
      const next = await listRooms();
      setRooms(next);
      setActiveId(room.id);
      setCreatorOpen(false);
      setCreatorInitialMode(undefined);
      setCreatorInitialDraft(undefined);
    });
  }, [createBusy]);

  const handleCreateSchedule = useCallback(async (payload: SchedulePayload) => {
    await createBusy.run(async () => {
      await createSchedule(payload);
      setCreatorOpen(false);
      setCreatorInitialMode(undefined);
      setCreatorInitialDraft(undefined);
    });
  }, [createBusy]);

  // ── Fork 确认流 ──
  // 用户触发 fork → 显示确认弹窗（复用调参 / 默认调参） → 执行
  const [pendingForkMsgId, setPendingForkMsgId] = useState<string | null>(null);

  const handleFork = useCallback((messageId: string) => {
    if (!snap.room) return;
    setPendingForkMsgId(messageId);
  }, [snap.room]);

  const executeFork = useCallback(async (resetPolicy: boolean) => {
    const msgId = pendingForkMsgId;
    setPendingForkMsgId(null);
    if (!snap.room || !msgId) return;
    await forkBusy.run(async () => {
      const forked = await forkRoom(snap.room!.id, msgId, resetPolicy || undefined);
      const next = await listRooms();
      setRooms(next);
      setActiveId(forked.id);
    });
  }, [snap.room, pendingForkMsgId, forkBusy]);

  // v0.9.1：投影 toggle 回调已随 UI 按钮一起移除。若后续上游 OpenClaw 提供
  // channels.deliver 类 RPC 可直接中继消息到 IM，再把 handleToggleProjection +
  // LiveControlsPanel / TopBar 的按钮恢复即可（后端 RoomProjection 数据结构和
  // Projector.ForwardMessage 骨架均保留）。

  // v0.9 高成本 LLM 调用的确认守护 —— 避免误触或手抖花 tokens。
  // 与"从讨论里抽取问题/风险"按钮一致的风格（useConfirm + 说明消耗 tokens）。
  const handleSynthesizeMinutes = useCallback(async () => {
    if (!snap.room) return;
    const ok = await confirm({
      title: '生成会议纪要',
      message: '将由主持 agent（或第一个存活 agent）汇总当前房间所有讨论，产出结构化纪要并保存为 Artifact。\n\n这次调用会消耗较多 tokens（~1200/次），请确认继续。',
      confirmText: '生成',
      cancelText: '取消',
    });
    if (!ok) return;
    await synthesizeMinutes(snap.room.id, 'minutes', false).catch(() => {});
  }, [snap.room, confirm]);

  const handleExtractTodo = useCallback(async () => {
    if (!snap.room) return;
    const ok = await confirm({
      title: '从讨论里抽取 TODO',
      message: '将由主持 agent 扫描最近讨论，把"谁-做什么-什么时候"结构化成任务写入 TODO 面板。\n\n这次调用会消耗 tokens，请确认继续。',
      confirmText: '抽取',
      cancelText: '取消',
    });
    if (!ok) return;
    await extractTodo(snap.room.id).catch(() => {});
  }, [snap.room, confirm]);

  const handleAskAll = useCallback(async (q: string) => {
    if (!snap.room) return;
    // 群询是 N 次并行 LLM 调用（房间里所有存活 agent 各跑一轮），是 UI 里最烧钱的动作之一。
    // 文案明确告知"N 个 agent 并行回答"让用户心里有数。
    const agentCount = Array.from(snap.memberMap.values())
      .filter(m => m.kind === 'agent' && !m.isKicked && !m.isMuted).length;
    const ok = await confirm({
      title: '向所有 agent 群询',
      message: `这条问题会被发给房间里 ${agentCount} 个存活 agent，他们会并行各回答一轮 —— 等于 ${agentCount} 次 LLM 调用。\n\n问题：${q}\n\n确认发送？`,
      confirmText: '发送群询',
      cancelText: '取消',
    });
    if (!ok) return;
    await askAll(snap.room.id, q).catch(() => {});
  }, [snap.room, snap.memberMap, confirm]);

  // 删除房间（带二次确认 + 双击守护）
  const handleDeleteRoom = useCallback(async (id: string, title: string) => {
    const ok = await confirm({
      title: tx('deleteRoomTitle', 'Delete room'),
      message: `${tx('deleteRoomMsgPrefix', 'Are you sure you want to delete room «')}${title}${tx('deleteRoomMsgSuffix', '»? This cannot be undone — all messages, members, tasks, and facts will be deleted.')}`,
      confirmText: tx('confirmDelete', 'Delete'),
      danger: true,
    });
    if (!ok) return;
    await deleteBusy.run(async () => {
      await deleteRoom(id);
      const next = await listRooms();
      setRooms(next);
      setActiveId(prev => prev === id ? (next[0]?.id || null) : prev);
    });
  }, [confirm, deleteBusy]);

  // ── 思考中成员 ──
  const thinkingMemberIds = snap.members.filter(m => m.status === 'thinking').map(m => m.id);
  const pendingHumanNeeded = useMemo(
    () => snap.messages.filter(m => m.humanNeeded && !m.deleted).slice(-1)[0] || null,
    [snap.messages],
  );
  const runtimeState = useMemo<'draft' | 'active' | 'paused' | 'awaiting_user' | 'closeout' | 'closed' | 'archived'>(() => {
    if (!snap.room) return 'draft';
    if (snap.room.state === 'archived') return 'archived';
    if (closeoutRunning) return 'closeout';
    if (snap.room.state === 'closed') return 'closed';
    if (snap.room.state === 'paused') return 'paused';
    if (pendingHumanNeeded) return 'awaiting_user';
    if (snap.room.state === 'draft') return 'draft';
    return 'active';
  }, [snap.room, closeoutRunning, pendingHumanNeeded]);
  const runtimeHint = useMemo(() => {
    if (!snap.room) return '';
    if (closeoutRunning) return tx('hintCloseout', 'Closeout is generating minutes, action items, playbooks, and retro');
    if (snap.room.state === 'closed') return tx('hintClosed', 'Meeting is over — you can still view and clean up AI sessions');
    if (snap.room.state === 'paused') return tx('hintPaused', 'Discussion paused — resume or adjust the next step');
    if (pendingHumanNeeded?.humanNeeded) return pendingHumanNeeded.humanNeeded;
    if (snap.room.state === 'draft') return tx('hintDraft', 'Drop an opener or click Continue to officially start the session');
    return '';
  }, [snap.room, closeoutRunning, pendingHumanNeeded]);
  const liveStatusSummary = useMemo(() => {
    const activeMembers = snap.members.filter(m => m.kind === 'agent' && !m.isKicked && m.status !== 'offline');
    const speaking = activeMembers.filter(m => m.status === 'speaking').length;
    const thinking = activeMembers.filter(m => m.status === 'thinking').length;
    const toolRunning = activeMembers.filter(m => m.status === 'tool_call' || m.status === 'tool_running').length;
    const waitingApproval = activeMembers.filter(m => m.status === 'tool_waiting_approval').length;
    const muted = snap.members.filter(m => m.kind === 'agent' && m.isMuted).length;
    const chips: Array<{ key: string; icon: string; label: string; tone: string }> = [];
    if (speaking > 0) chips.push({ key: 'speaking', icon: 'record_voice_over', label: `${speaking} ${tx('chipSpeaking', 'speaking')}`, tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30' });
    if (thinking > 0) chips.push({ key: 'thinking', icon: 'neurology', label: `${thinking} ${tx('chipThinking', 'thinking')}`, tone: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border-cyan-500/30' });
    if (toolRunning > 0) chips.push({ key: 'tool', icon: 'build_circle', label: `${toolRunning} ${tx('chipTool', 'using tools')}`, tone: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30' });
    if (waitingApproval > 0) chips.push({ key: 'approval', icon: 'approval', label: `${waitingApproval} ${tx('chipApproval', 'awaiting approval')}`, tone: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30' });
    if (muted > 0) chips.push({ key: 'muted', icon: 'volume_off', label: `${muted} ${tx('chipMuted', 'muted')}`, tone: 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/30' });
    if (chips.length === 0) {
      chips.push({ key: 'idle', icon: 'bedtime', label: tx('chipIdle', 'quiet for now'), tone: 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/30' });
    }
    return chips;
  }, [snap.members]);
  // v1.0：是否有 agent 正在活动（thinking/speaking/tool_running），供 TopBar MeetingActions 判断主按钮
  const agentsActive = useMemo(() => {
    const ACTIVE = new Set(['thinking', 'speaking', 'tool_call', 'tool_running']);
    return snap.members.some(m => m.kind === 'agent' && !m.isKicked && ACTIVE.has(m.status));
  }, [snap.members]);
  // v1.0：nudge 发出 → agent 开始响应之间的空档标记。
  // 点击「继续会议」后立刻变 true，让 UI 立即切换到"启动中"状态；
  // agentsActive 变 true 或 30s 安全超时后自动清除。
  const [nudgePending, setNudgePending] = useState(false);
  useEffect(() => {
    if (nudgePending && agentsActive) setNudgePending(false);
  }, [nudgePending, agentsActive]);
  useEffect(() => {
    if (!nudgePending) return;
    const t = setTimeout(() => setNudgePending(false), 30_000);
    return () => clearTimeout(t);
  }, [nudgePending]);
  const handleStartNextMeetingDraft = useCallback((draft: NextMeetingDraft) => {
    setCreatorInitialDraft(draft);
    setCreatorInitialMode(draft.templateId ? 'template' : 'custom');
    setCreatorScheduleEnabled(false);
    setCreatorOpen(true);
    toast('info', tx('toastNextMeetingDraftPrefilled', 'Next-meeting draft prefilled from the retro suggestion — tweak it and start'));
  }, [toast]);
  const handleSetAsSchedule = useCallback((draft: NextMeetingDraft) => {
    setCreatorInitialDraft(draft);
    setCreatorInitialMode(draft.templateId ? 'template' : 'custom');
    setCreatorScheduleEnabled(true);
    setCreatorOpen(true);
    toast('info', '已预填复盘建议并勾选「设为定时会议」，确认 cron 后提交即可');
  }, [toast]);

  // ── 面板宽度 ──
  // wideEnough* 判断响应式断点是否允许显示；collapsed 是用户主动折叠偏好。
  const wideEnoughLeft = isWide || isMedium;
  const wideEnoughRight = isWide;
  const showLeft = wideEnoughLeft && !leftCollapsed;
  const showRight = wideEnoughRight && !rightCollapsed;

  const heroTitle = arm.heroTitle || 'Summon your AI team';
  const heroDescLine1 = arm.heroDescLine1 || 'AgentRoom is a native multi-agent meeting room. Put N AIs in one room,';
  const heroDescLine2 = arm.heroDescLine2 || 'let them collaborate in real time, while you can jump in, rewrite replies, or play one of the roles yourself.';
  const heroStart = arm.heroStart || 'Start now (1 min)';
  const heroBrowseTemplates = arm.heroBrowseTemplates || 'Browse templates';
  const heroBuildCustom = arm.heroBuildCustom || 'Build your own';
  const heroFeatureRealtime = arm.heroFeatureRealtime || 'Real-time chat';
  const heroFeatureRealtimeDesc = arm.heroFeatureRealtimeDesc || 'Feels as natural as Discord';
  const heroFeatureInterrupt = arm.heroFeatureInterrupt || 'Jump in anytime';
  const heroFeatureInterruptDesc = arm.heroFeatureInterruptDesc || 'Space to pause · rewrite AI';
  // v0.9.1：投影功能已临时下架（等待上游 OpenClaw 提供 channels.deliver 类 RPC 后再恢复），
  // Hero 空态卡片里不再宣传"一键投影到 IM 群"——避免用户按按钮才发现做不到。
  // 文案键 heroFeatureProjection / heroFeatureProjectionDesc 保留在 locale 文件里，
  // 将来恢复功能时直接复用。

  if (!snap.room && rooms.length === 0) {
    // ── 空状态（全屏 Hero Card）──
    return (
      <div className="h-full flex items-center justify-center p-6 bg-gradient-to-br from-cyan-500/5 via-blue-500/5 to-purple-500/5">
        <div className="max-w-xl text-center">
          <div className="mx-auto w-20 h-20 rounded-3xl bg-gradient-to-br from-cyan-500 via-blue-500 to-purple-500 flex items-center justify-center shadow-[0_12px_40px_rgba(0,200,255,0.35)] mb-5 animate-glow-breathe">
            <span className="material-symbols-outlined text-white text-[44px]">groups_3</span>
          </div>
          <h1 className="text-2xl font-bold text-text mb-2">{heroTitle}</h1>
          <p className="text-[13.5px] text-text-secondary leading-relaxed mb-6">
            {heroDescLine1}<br className="hidden sm:inline"/>
            {heroDescLine2}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              onClick={() => { setCreatorInitialMode('template'); setCreatorOpen(true); }}
              className="inline-flex items-center gap-2 px-5 h-11 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-500 text-white font-bold shadow-[0_4px_16px_rgba(0,200,255,0.35)] hover:shadow-[0_6px_24px_rgba(0,200,255,0.5)] transition-all"
            >
              <span className="material-symbols-outlined">rocket_launch</span>
              {heroStart}
            </button>
            <button
              onClick={() => { setCreatorInitialMode('ai'); setCreatorOpen(true); }}
              className="inline-flex items-center gap-2 px-5 h-11 rounded-xl bg-surface-raised border border-border text-text font-semibold hover:bg-surface-sunken transition-all"
            >
              <span className="material-symbols-outlined">magic_button</span>
              {heroBrowseTemplates}
            </button>
            <button
              onClick={() => { setCreatorInitialMode('custom'); setCreatorOpen(true); }}
              className="inline-flex items-center gap-2 px-5 h-11 rounded-xl bg-surface-raised border border-border text-text font-semibold hover:bg-surface-sunken transition-all"
            >
              <span className="material-symbols-outlined">construction</span>
              {heroBuildCustom}
            </button>
          </div>
          {/* v0.9.1：原 3 列特性卡片里第 3 张是"一键投影"，已随投影功能临时下架移除；
              改成 2 列更简洁。恢复投影后把第 3 张卡补回（heroFeatureProjection 文案仍在）。 */}
          <div className="mt-8 grid grid-cols-2 gap-3 text-[11px] text-text-muted">
            <div className="p-3 rounded-xl bg-surface-raised border border-border">
              <span className="material-symbols-outlined text-[20px] text-cyan-500 mb-1">forum</span>
              <div className="font-semibold text-text">{heroFeatureRealtime}</div>
              <div>{heroFeatureRealtimeDesc}</div>
            </div>
            <div className="p-3 rounded-xl bg-surface-raised border border-border">
              <span className="material-symbols-outlined text-[20px] text-purple-500 mb-1">back_hand</span>
              <div className="font-semibold text-text">{heroFeatureInterrupt}</div>
              <div>{heroFeatureInterruptDesc}</div>
            </div>
          </div>
        </div>
        {creatorOpen && <CreateRoomWizard onCreate={handleCreate} onCreateSchedule={handleCreateSchedule} onCancel={() => { setCreatorOpen(false); setCreatorInitialMode(undefined); setCreatorInitialDraft(undefined); setCreatorScheduleEnabled(false); }} initialMode={creatorInitialMode} initialDraft={creatorInitialDraft} initialScheduleEnabled={creatorScheduleEnabled} />}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-surface">
      {/* 连接状态横条：断线或正在连接时显示 */}
      {wsStatus !== 'open' && (
        <div className={`shrink-0 px-3 py-1 text-[11px] flex items-center gap-2 ${wsStatus === 'closed' ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'}`}>
          <span className="material-symbols-outlined text-[14px] animate-spin-slow">
            {wsStatus === 'closed' ? 'cloud_off' : 'sync'}
          </span>
          <span className="font-semibold">
            {wsStatus === 'closed' ? tx('wsDisconnected', 'Realtime connection lost — retrying...') : tx('wsConnecting', 'Connecting...')}
          </span>
        </div>
      )}
      <div className="flex-1 min-h-0 flex relative">
        {/* 左栏 · 房间列表 */}
        {showLeft ? (
          <div className="w-[280px] xl:w-[300px] shrink-0">
            <RoomsRail
              rooms={rooms}
              activeId={activeId}
              onSelect={setActiveId}
              onCreate={() => { setCreatorInitialMode(undefined); setCreatorOpen(true); }}
              onDelete={handleDeleteRoom}
              lastSeen={lastSeen}
              onCollapse={wideEnoughLeft ? () => setLeftCollapsed(true) : undefined}
              onOpenDashboard={() => setDashboardOpen(true)}
              onOpenSchedule={() => setScheduleOpen(true)}
            />
          </div>
        ) : (
          <>
            {leftDrawerOpen && (
              <div className="fixed inset-0 z-30 lg:hidden" onClick={() => setLeftDrawerOpen(false)}>
                <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
                <div className="absolute start-0 top-0 bottom-0 w-[280px] bg-surface animate-slide-in-right" onClick={e => e.stopPropagation()}>
                  <RoomsRail rooms={rooms} activeId={activeId} onSelect={id => { setActiveId(id); setLeftDrawerOpen(false); }} onCreate={() => { setCreatorInitialMode(undefined); setCreatorOpen(true); setLeftDrawerOpen(false); }} onDelete={handleDeleteRoom} lastSeen={lastSeen} />
                </div>
              </div>
            )}
          </>
        )}

        {/* 中栏 · 聊天区 */}
        <div className="flex-1 min-w-0 flex flex-col relative">
          {/* v0.8+ 展开按钮不再 absolute 覆盖顶栏，改为传给 TopBar 内嵌渲染 */}

          {snap.room && (
            <TopBar
              room={snap.room}
              runtimeState={runtimeState}
              runtimeHint={runtimeHint || undefined}
              onShowTimeline={() => setTimelineOpen(true)}
              onOpenPlaybooks={() => setPlaybooksOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
              onCloseMeeting={() => setCloseoutOpen(true)}
              onNudge={() => { setNudgePending(true); nudgeRoom(snap.room!.id); }}
              onTogglePause={handleTogglePause}
              agentsActive={agentsActive}
              nudgePending={nudgePending}
              onReopenRoom={async () => {
                // v0.9.1：把 closed 房间重新开启到 paused。无副作用（不清纪要/不清 session），
                // 所以不做二次确认——和"继续会议"一样轻量。失败时 service 层 withToast 会提示。
                await reopenRoom(snap.room!.id);
              }}
              onExportHtml={() => {
                if (!snap.room || !snap.members.length) return;
                exportMeetingHtml({ room: snap.room, members: snap.members, messages: snap.messages });
              }}
              onPurgeSessions={async () => {
                // v0.8 确认对话——遵循 ClawDeckX 的状态变更默认确认规则。
                // 文案明确说明“仅释放上游资源，本地记录不受影响”，减少用户误以为“删了会没事”的心理负担。
                const ok = await confirm({
                  title: tx('purgeSessionsTitle', 'Clean up AI sessions'),
                  message: tx('purgeSessionsMsg', 'This will delete every member session on the upstream OpenClaw Gateway for this room (effective immediately).\n\nThe room’s messages, minutes, agenda, whiteboard, tasks, and other local data are all preserved and remain viewable.\n\nClean up?'),
                  confirmText: tx('purgeSessionsConfirm', 'Clean up'),
                });
                if (!ok) return;
                await purgeRoomSessions(snap.room!.id);
              }}
              depthBadge={
                // v0.9：去掉 overflow-hidden 和 hidden xl:flex ——
                // 原本把深度徽章限制在 xl 断点以上 + overflow-hidden 吃掉"第 N 棒 · 累计 N"后半段。
                // TopBar 中间 flex 行已自己控制最小宽度，正常桌面宽度就能完整显示。
                <div className="hidden md:flex items-center gap-1.5 min-w-0">
                  <MeetingDepthBadge
                    room={snap.room}
                    members={snap.members}
                    messages={snap.messages}
                    maxConsecutive={snap.room.policyOptions?.maxConsecutive}
                  />
                  {liveStatusSummary.map(item => (
                    <div key={item.key} className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-md border shrink-0 ${item.tone}`}>
                      <span className="material-symbols-outlined text-[13px]">{item.icon}</span>
                      <span className="text-[11px] font-semibold">{item.label}</span>
                    </div>
                  ))}
                </div>
              }
              onRename={(title) => updateRoom(snap.room!.id, { title })}
              onExpandLeft={!showLeft ? () => {
                if (wideEnoughLeft && leftCollapsed) setLeftCollapsed(false);
                else setLeftDrawerOpen(true);
              } : undefined}
              onExpandRight={!showRight ? () => {
                if (wideEnoughRight && rightCollapsed) setRightCollapsed(false);
                else setRightDrawerOpen(true);
              } : undefined}
            />
          )}

          {/* v0.4：上下文压缩横幅 —— 对齐 Sessions.tsx 的 context_compaction.started/completed。
              bridge 在 session history 检测到 compactionSummary 时通过 orchestrator 转发。 */}
          {snap.room && snap.compaction && (
            <div className={`shrink-0 px-3 py-1.5 border-b text-[11.5px] flex items-center gap-2 transition-colors ${
              snap.compaction.phase === 'start'
                ? 'bg-cyan-500/10 border-cyan-500/20 text-cyan-700 dark:text-cyan-400'
                : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-400'
            }`}>
              <span className={`material-symbols-outlined text-[15px] ${snap.compaction.phase === 'start' ? 'animate-pulse' : ''}`}>
                {snap.compaction.phase === 'start' ? 'compress' : 'check_circle'}
              </span>
              <span className="font-semibold">
                {snap.compaction.phase === 'start' ? tx('compactionStart', 'Compressing context') : tx('compactionDone', 'Context compression complete')}
              </span>
              <span className="opacity-75">
                {snap.compaction.phase === 'start'
                  ? (snap.compaction.memberId
                      ? `${tx('compactionMemberPrefix', '· ')}${snap.memberMap.get(snap.compaction.memberId)?.name || tx('compactionMemberFallback', 'a member')}${tx('compactionMemberSuffix', '’s session history is long — OpenClaw is summarizing')}`
                      : tx('compactionGeneric', '· OpenClaw is summarizing session history'))
                  : (snap.compaction.willRetry ? tx('compactionWillRetry', '· Will retry this turn with the compressed context') : '')}
              </span>
            </div>
          )}

          {/* v1.0：统一 runtime banner —— 除了 closed/archived，所有状态都在消息流上方显示一条状态横幅。
              非暂停/非闲置状态都有动态动画（spin/pulse），让用户始终感知到"系统在跑"。 */}
          {snap.room && (() => {
            // closed/archived 不画横幅（下方 Composer 有大块"会议已关闭"banner）
            if (runtimeState === 'closed' || runtimeState === 'archived') return null;
            type BannerMeta = { tone: string; icon: string; spin: boolean; label: string; detail: string };
            const banner: BannerMeta | null = (() => {
              if (runtimeState === 'closeout') return {
                tone: 'bg-cyan-500/10 border-cyan-500/20 text-cyan-700 dark:text-cyan-300',
                icon: 'progress_activity', spin: true,
                label: tx('stateCloseout', 'Meeting is wrapping up'),
                detail: runtimeHint || '',
              };
              if (runtimeState === 'paused') return {
                tone: 'bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-300',
                icon: 'pause_circle', spin: false,
                label: tx('statePaused', 'Room is paused'),
                detail: runtimeHint || '',
              };
              if (runtimeState === 'awaiting_user') return {
                tone: 'bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-300',
                icon: 'pan_tool', spin: false,
                label: tx('stateAwaitingUser', 'Waiting for your input'),
                detail: runtimeHint || '',
              };
              if (runtimeState === 'draft') return {
                tone: 'bg-slate-500/10 border-slate-500/20 text-slate-600 dark:text-slate-400',
                icon: 'edit_calendar', spin: false,
                label: tx('stateDraft', 'Room hasn\'t fully warmed up yet'),
                detail: runtimeHint || '',
              };
              // active 子态
              if (snap.biddingInProgress) return {
                tone: 'bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-300',
                icon: 'gavel', spin: true,
                label: tx('stateBidding', 'Agents are evaluating bids'),
                detail: tx('stateBiddingDetail', 'All agents are scoring their intent to speak; the highest scorer will present next'),
              };
              // v1.0：active + agents 正在活动 → 不显示横幅（标题栏已有 "N思考中" chips，
              // 底部有 StatusChip "运行中"，底栏有 agent 实时状态。横幅重复且占空间）。
              if (agentsActive) return null;
              // v1.0：nudge 已发出 → agent 还没开始响应的空档 → 显示"启动中"
              if (nudgePending) return {
                tone: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-300',
                icon: 'progress_activity', spin: true,
                label: tx('stateStarting', 'Starting next round'),
                detail: tx('stateStartingDetail', 'Waiting for agents to pick up…'),
              };
              // active idle
              return {
                tone: 'bg-slate-500/10 border-slate-500/20 text-text-muted',
                icon: 'schedule', spin: false,
                label: tx('stateIdle', 'Waiting for next round'),
                detail: tx('stateIdleDetail', 'Click Continue or send a message to kick off the next round'),
              };
            })();
            if (!banner) return null;
            return (
              <div className={`shrink-0 px-3 py-1.5 border-b text-[11.5px] flex items-center gap-2 ${banner.tone}`}>
                <span className={`material-symbols-outlined text-[15px] ${banner.spin ? 'animate-spin' : ''}`}>
                  {banner.icon}
                </span>
                <span className="font-semibold">{banner.label}</span>
                {banner.detail && <span className="opacity-80 truncate">· {banner.detail}</span>}
              </div>
            );
          })()}

          {snap.room && (() => {
            const b = snap.room.budget;
            const pct = b.limitCNY > 0 ? b.usedCNY / b.limitCNY : 0;
            const warnAt = b.warnAt ?? 0.7;
            const hardStopAt = b.hardStopAt ?? 1.0;
            if (pct < warnAt) return null;
            const hot = pct >= hardStopAt * 0.9;
            return (
              <div className={`shrink-0 px-3 py-1.5 border-b text-[11.5px] flex items-center gap-2 ${hot ? 'bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400 animate-pulse' : 'bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-400'}`}>
                <span className="material-symbols-outlined text-[15px]">warning</span>
                <span className="font-semibold">
                  {hot ? tx('budgetOver', 'Budget is about to exceed the cap') : `${tx('budgetUsedPrefix', 'Budget used ')}${Math.round(pct * 100)}%`}
                  {` (¥${b.usedCNY.toFixed(2)} / ¥${b.limitCNY})`}
                </span>
              </div>
            );
          })()}

          {snap.room && (
            <>
              {/* v0.2 GAP G5：三层 phase 统一工作流时间轴 */}
              <WorkflowTimeline
                room={snap.room}
                activeAgendaItem={activeAgendaItem}
                onJumpAgenda={() => {
                  // 触发右栏议程区域的滚动 / 高亮（保持轻量：自定义事件，由 RightPanel 监听）
                  window.dispatchEvent(new CustomEvent('agentroom:focus-section', {
                    detail: { roomId: snap.room!.id, section: 'agenda' },
                  }));
                }}
              />
              <AwaySummaryBanner
                roomId={snap.room.id}
                messages={snap.messages}
                members={snap.memberMap}
                meId={meId}
                onJump={(mid) => setHighlightMessageId(mid)}
              />
              <HumanNeededBanner
                roomId={snap.room.id}
                messages={snap.messages}
                members={snap.memberMap}
                onJump={(mid) => setHighlightMessageId(mid)}
              />
              {/* v0.4：工具审批由 OpenClaw 原生 UI 接管，AgentRoom 不再显示本地审批横幅。 */}
            </>
          )}

          {snap.room ? (
            <MessageStream
              messages={snap.messages}
              members={snap.memberMap}
              meId={meId}
              highlightMessageId={highlightMessageId}
              onHighlightConsumed={() => setHighlightMessageId(null)}
              thinkingMemberIds={thinkingMemberIds}
              onEdit={(id, content) => editMessage(snap.room!.id, id, content)}
              onDelete={(id) => deleteMessage(snap.room!.id, id)}
              onFork={handleFork}
              onReact={(id, emoji) => reactMessage(snap.room!.id, id, emoji, meId)}
              onReply={(id) => {
                const m = snap.messages.find(x => x.id === id);
                if (m) setReplyTo(m);
              }}
              onWhisper={(mid) => { /* TODO: 打开 Composer whisper */ }}
              onPromoteDecision={(mid, summary) => promoteDecision(mid, summary).catch(() => {})}
              onDemoteDecision={async (mid) => {
                // v0.3 主题 D：撤回前先查影响
                const impact = await getDecisionImpact(mid);
                const derived = impact?.derivedTasks || [];
                if (derived.length > 0) {
                  const sample = derived.slice(0, 5).map(t => `· ${t.text}`).join('\n');
                  const more = derived.length > 5 ? `\n…还有 ${derived.length - 5} 个` : '';
                  const ok = await confirm({
                    title: '此决策已派生 ' + derived.length + ' 个任务',
                    message:
                      '撤销决策后，下列任务的"决策来源"链接将失效（任务本身不会被删除）：\n\n' +
                      sample + more + '\n\n确认要撤销吗？',
                    confirmText: '仍然撤销',
                    danger: true,
                  });
                  if (!ok) return;
                }
                demoteDecision(mid).catch(() => {});
              }}
              onRerun={(mid, model) => rerunMessage(mid, model).catch(() => {})}
              systemModels={systemModels}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-text-muted">
              <div className="text-center">
                <span className="material-symbols-outlined text-[32px] opacity-40">meeting_room</span>
                <p className="text-[13px] mt-2">{tx('emptyPickRoom', 'Pick or create a room')}</p>
              </div>
            </div>
          )}

          {/* 活跃成员读秒条：thinking/speaking/tool_running 时显示 "still working... Xs" */}
          {snap.room && <ActivityStrip members={snap.members} />}

          {snap.room && (
            <Composer
              members={snap.members}
              meId={meId}
              policy={snap.room.policy}
              paused={snap.room.state === 'paused'}
              budgetPct={snap.room.budget.usedCNY / snap.room.budget.limitCNY}
              disabled={snap.room.state === 'closed' || snap.room.state === 'archived' || closeoutRunning}
              runtimeState={runtimeState}
              runtimeHint={runtimeHint || undefined}
              referenceMessage={replyTo}
              onClearReference={() => setReplyTo(null)}
              onSend={handleSend}
              onChangePolicy={(p) => setRoomPolicy(snap.room!.id, p)}
              onForceNext={(mid) => forceNextSpeaker(snap.room!.id, mid)}
              onTogglePause={handleTogglePause}
              onForkHere={() => {
                const last = snap.messages[snap.messages.length - 1];
                if (last) handleFork(last.id);
              }}
              onExport={() => exportRoom(snap.room!.id, 'markdown')}
              onExportHtml={() => {
                if (!snap.room || !snap.members.length) return;
                exportMeetingHtml({ room: snap.room, members: snap.members, messages: snap.messages });
              }}
              onAddFact={(k, v) => upsertFact(snap.room!.id, { key: k, value: v, authorId: meId, updatedAt: Date.now() })}
              onAddTask={(text) => addTask(snap.room!.id, { text, creatorId: meId, status: 'todo' })}
              onOpenHelp={() => setHelpOpen(true)}
              onCloseRoom={handleSynthesizeMinutes}
              onExtractTodo={handleExtractTodo}
              onAskAll={handleAskAll}
              onPromoteLastAsDecision={(summary) => {
                // 选取最近一条 agent/human 的 chat 消息
                const last = [...snap.messages].reverse().find(m =>
                  !m.deleted && (m.kind === 'chat' || m.kind === 'decision'));
                if (!last) return;
                promoteDecision(last.id, summary).catch(() => {});
              }}
              onNudge={(text) => nudgeRoom(snap.room!.id, text)}
              biddingInProgress={snap.biddingInProgress}
              agentsActive={agentsActive}
              nudgePending={nudgePending}
            />
          )}

          {/* v0.8+ 右侧展开按钮已上移到 TopBar 内部，不再 absolute 遮挡消息流 */}
        </div>

        {/* 右栏 · 成员 / 记忆 / 白板 / 任务 / 指标 */}
        {showRight ? (
          <aside className="w-[320px] shrink-0 border-s border-border bg-surface-raised/40 flex flex-col">
            <RightPanel
              snap={snap}
              meId={meId}
              language={language}
              systemModels={systemModels}
              gatewayAgents={gatewayAgents}
              onChangeModel={updateMemberModel}
              onChangeAgent={updateMemberAgent}
              onChangeThinking={updateMemberThinking}
              onChangeSystemPrompt={updateMemberSystemPrompt}
              onCollapse={() => setRightCollapsed(true)}
              activeAgendaItem={activeAgendaItem}
              onActiveAgendaItemChange={setActiveAgendaItem}
              onStartNextMeetingDraft={handleStartNextMeetingDraft}
              onSetAsSchedule={handleSetAsSchedule}
              onOpenPlaybook={(playbookId, context) => {
                setPlaybookEditorTargetId(playbookId);
                setPlaybookHighlightContext(context);
                setPlaybooksOpen(true);
              }}
              // v0.9：TopBar 的经验库 / 设置按钮下沉到 RightPanel 的 LiveControlsPanel；
              // v0.9.1 投影按钮已下架（见 AgentRoom.tsx handleToggleProjection 处注释）。
              onOpenPlaybooks={() => setPlaybooksOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </aside>
        ) : (
          <>
            {rightDrawerOpen && (
              <div className="fixed inset-0 z-30" onClick={() => setRightDrawerOpen(false)}>
                <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
                <div className="absolute end-0 top-0 bottom-0 w-[320px] max-w-[85vw] bg-surface animate-slide-in-right border-s border-border flex flex-col" onClick={e => e.stopPropagation()}>
                  <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                    <span className="text-[12px] font-bold">{tx('rightDrawerTitle', 'Room panels')}</span>
                    <button onClick={() => setRightDrawerOpen(false)} className="w-7 h-7 rounded-md hover:bg-surface-sunken flex items-center justify-center">
                      <span className="material-symbols-outlined text-[16px]">close</span>
                    </button>
                  </div>
                  <RightPanel snap={snap} meId={meId} language={language} systemModels={systemModels} gatewayAgents={gatewayAgents} onChangeModel={updateMemberModel} onChangeAgent={updateMemberAgent} onChangeThinking={updateMemberThinking} onChangeSystemPrompt={updateMemberSystemPrompt} activeAgendaItem={activeAgendaItem} onActiveAgendaItemChange={setActiveAgendaItem} onStartNextMeetingDraft={handleStartNextMeetingDraft} onOpenPlaybook={(playbookId, context) => { setPlaybookEditorTargetId(playbookId); setPlaybookHighlightContext(context); setPlaybooksOpen(true); }} onOpenPlaybooks={() => setPlaybooksOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 创建向导 */}
      {creatorOpen && (
        <CreateRoomWizard
          onCreate={handleCreate}
          onCreateSchedule={handleCreateSchedule}
          onCancel={() => {
            setCreatorOpen(false);
            setCreatorInitialMode(undefined);
            setCreatorInitialDraft(undefined);
            setCreatorScheduleEnabled(false);
          }}
          initialMode={creatorInitialMode}
          initialDraft={creatorInitialDraft}
          initialScheduleEnabled={creatorScheduleEnabled}
        />
      )}

      {/* 错误 / 重连提示走全局 <ToastProvider>（顶部居中，macOS 风格），此处不再本地渲染 */}

      {/* 房间内搜索 */}
      {searchOpen && snap.room && (
        <SearchPanel
          roomId={snap.room.id}
          members={snap.memberMap}
          onJump={(mid) => { setHighlightMessageId(mid); }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {/* v0.3 主题 D：跨房间工作台 */}
      <CrossRoomDashboard
        open={dashboardOpen}
        onClose={() => setDashboardOpen(false)}
        onOpenRoom={(rid) => { setActiveId(rid); setDashboardOpen(false); }}
      />

      {/* v1.0 定时会议 */}
      {scheduleOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setScheduleOpen(false)}>
          <div
            className="w-[90vw] max-w-[800px] max-h-[88vh] bg-surface rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-4 h-11 shrink-0 border-b border-border flex items-center justify-between">
              <span className="text-sm font-semibold text-text flex items-center gap-2">
                <span className="material-symbols-outlined text-base text-cyan-500">schedule</span>定时会议管理
              </span>
              <button onClick={() => setScheduleOpen(false)} className="w-7 h-7 rounded-md hover:bg-surface-sunken flex items-center justify-center text-text-muted">
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <SchedulePanel onOpenRoom={(rid) => { setActiveId(rid); setScheduleOpen(false); }} />
            </div>
          </div>
        </div>
      )}

      {/* 快捷键帮助 cheatsheet */}
      {helpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setHelpOpen(false)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" />
          <div className="relative max-w-lg w-full bg-surface-overlay backdrop-blur-md rounded-xl border border-border shadow-2xl p-5 animate-card-enter" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-text">{tx('helpTitle', 'Shortcuts & commands')}</h3>
              <button onClick={() => setHelpOpen(false)} className="w-7 h-7 rounded-md hover:bg-surface-sunken flex items-center justify-center text-text-muted">
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px] text-text-secondary">
              <div className="flex items-center gap-2"><kbd className="px-1.5 py-0.5 rounded bg-surface-sunken border border-border text-[11px] font-mono">Space</kbd><span>{tx('helpPauseResume', 'Pause / Resume')}</span></div>
              <div className="flex items-center gap-2"><kbd className="px-1.5 py-0.5 rounded bg-surface-sunken border border-border text-[11px] font-mono">Enter</kbd><span>{tx('helpSend', 'Send message')}</span></div>
              <div className="flex items-center gap-2"><kbd className="px-1.5 py-0.5 rounded bg-surface-sunken border border-border text-[11px] font-mono">Shift+Enter</kbd><span>{tx('helpNewline', 'New line')}</span></div>
              <div className="flex items-center gap-2"><kbd className="px-1.5 py-0.5 rounded bg-surface-sunken border border-border text-[11px] font-mono">⌘B</kbd><span>{tx('helpForkLast', 'Fork from last message')}</span></div>
              <div className="flex items-center gap-2"><kbd className="px-1.5 py-0.5 rounded bg-surface-sunken border border-border text-[11px] font-mono">⌘M</kbd><span>{tx('helpRightDrawer', 'Right panel drawer')}</span></div>
              <div className="flex items-center gap-2"><kbd className="px-1.5 py-0.5 rounded bg-surface-sunken border border-border text-[11px] font-mono">⌘F</kbd><span>{tx('helpSearch', 'Search in room')}</span></div>
              <div className="flex items-center gap-2"><kbd className="px-1.5 py-0.5 rounded bg-surface-sunken border border-border text-[11px] font-mono">Esc</kbd><span>{tx('helpClosePopups', 'Close modal / drawer')}</span></div>
              <div className="flex items-center gap-2"><kbd className="px-1.5 py-0.5 rounded bg-surface-sunken border border-border text-[11px] font-mono">@</kbd><span>{tx('helpMention', 'Mention a member (autocomplete)')}</span></div>
              <div className="flex items-center gap-2"><kbd className="px-1.5 py-0.5 rounded bg-surface-sunken border border-border text-[11px] font-mono">Tab</kbd><span>{tx('helpAcceptCompletion', 'Accept completion candidate')}</span></div>
            </div>
            <div className="mt-4 pt-3 border-t border-border">
              <div className="text-[11px] uppercase tracking-wider text-text-muted mb-2">{tx('helpSlashTitle', 'Slash commands')}</div>
              <div className="space-y-1 text-[12px] text-text-secondary">
                <div><code className="font-mono text-cyan-500">/pause</code> {tx('helpSlashPause', '— pause/resume the room')}</div>
                <div><code className="font-mono text-cyan-500">/fact {tx('helpSlashFactArg', 'key=value')}</code> {tx('helpSlashFact', '— record a shared fact')}</div>
                <div><code className="font-mono text-cyan-500">/task {tx('helpSlashTaskArg', 'text')}</code> {tx('helpSlashTask', '— create a task')}</div>
                <div><code className="font-mono text-cyan-500">/fork</code> {tx('helpSlashFork', '— fork a new room from here')}</div>
                <div><code className="font-mono text-cyan-500">/export</code> {tx('helpSlashExport', '— export the room as Markdown')}</div>
                <div><code className="font-mono text-cyan-500">/export-html</code> — 导出为可分享的 HTML 文件</div>
                <div><code className="font-mono text-cyan-500">/help</code> {tx('helpSlashHelp', '— open this panel')}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 时间轴 */}
      {timelineOpen && snap.room && (
        <TimelineOverlay
          messages={snap.messages}
          interventions={snap.interventions}
          members={snap.memberMap}
          onJump={(mid) => { setHighlightMessageId(mid); setTimelineOpen(false); }}
          onFork={(mid) => { handleFork(mid); setTimelineOpen(false); }}
          onClose={() => setTimelineOpen(false)}
        />
      )}

      {/* 分叉确认弹窗 */}
      {pendingForkMsgId && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setPendingForkMsgId(null)} />
          <div className="relative mac-glass rounded-2xl shadow-2xl overflow-hidden animate-scale-in w-[380px] backdrop-blur-3xl">
            <div className="px-6 pt-6 pb-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-11 h-11 rounded-full bg-violet-500/15 flex items-center justify-center">
                  <span className="material-symbols-outlined text-[24px] text-violet-500">fork_right</span>
                </div>
                <div>
                  <h3 className="text-[14px] font-bold text-text">分叉新房间</h3>
                  <p className="text-[11px] text-text-secondary">从选中消息处分叉，产生独立副本</p>
                </div>
              </div>
              <div className="text-[12px] text-text-secondary leading-relaxed mb-1">
                新房间是否沿用当前房间的<strong>发言策略、记忆压缩、人设文案</strong>等调参？
              </div>
            </div>
            <div className="px-6 pb-5 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => executeFork(false)}
                className="w-full h-10 rounded-xl text-[13px] font-semibold bg-violet-500 hover:bg-violet-600 text-white transition-colors inline-flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-[16px]">content_copy</span>
                复用当前调参
              </button>
              <button
                type="button"
                onClick={() => executeFork(true)}
                className="w-full h-10 rounded-xl text-[13px] font-medium bg-surface-raised hover:bg-surface-sunken border border-border text-text transition-colors inline-flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-[16px]">restart_alt</span>
                使用默认调参
              </button>
              <button
                type="button"
                onClick={() => setPendingForkMsgId(null)}
                className="w-full h-8 rounded-lg text-[12px] text-text-muted hover:text-text transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 经验库 · v0.7 Studio */}
      <PlaybookLibraryModal
        open={playbooksOpen}
        currentRoomId={snap.room?.id}
        initialEditingId={playbookEditorTargetId}
        highlightContext={playbookHighlightContext}
        onClose={() => {
          setPlaybooksOpen(false);
          setPlaybookEditorTargetId(null);
          setPlaybookHighlightContext(null);
        }}
      />

      {/* v0.7 关闭仪式 · 生成正式产出 */}
      {snap.room && (
        <MeetingCloseoutModal
          roomId={snap.room.id}
          roomTitle={snap.room.title}
          members={snap.memberMap}
          open={closeoutOpen}
          onClose={() => setCloseoutOpen(false)}
          onDone={(result) => {
            toast(
              result.ok ? 'success' : 'info',
              result.ok
                ? tx('toastCloseoutSuccess', 'Closeout complete — check minutes, action items, and retro in the Outcome panel on the right')
                : tx('toastCloseoutPartial', 'Closeout finished with some steps failing — check the result panel for what was generated'),
              4200,
            );
          }}
          onRunningChange={setCloseoutRunning}
          onJump={(mid) => {
            setHighlightMessageId(mid);
            setCloseoutOpen(false);
          }}
          onOpenPlaybooks={(playbookId, context) => {
            setPlaybookEditorTargetId(playbookId || null);
            setPlaybookHighlightContext(context || null);
            setPlaybooksOpen(true);
          }}
        />
      )}

      {/* v0.4：AI 会议设置（辅助模型：本房间 + 全局默认） */}
      {snap.room && (
        <RoomSettingsModal
          language={language}
          room={snap.room}
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
};

// ── 右侧面板分组小标题 ──
//
// 在右侧栏里把逻辑相近的 CollapsibleSection 聚拢为 4 组（推进会议 / 产出 & 决策 /
// 知识 & 记忆 / 调控 & 高级），让侧栏在滚动时更容易扫视 —— 之前十几个 section 平铺
// 导致"什么都能点"但"什么都找不到"。采用细字号 + 分色小图标的轻量风格，避免喧宾夺主。
const PanelGroupHeader: React.FC<{
  icon: string;
  label: string;
  /** 左侧圆点色，用于组间视觉区分 */
  accent?: 'cyan' | 'purple' | 'emerald' | 'slate';
}> = ({ icon, label, accent = 'cyan' }) => {
  const dotCls = {
    cyan: 'bg-cyan-500',
    purple: 'bg-purple-500',
    emerald: 'bg-emerald-500',
    slate: 'bg-slate-400 dark:bg-slate-500',
  }[accent];
  return (
    <div className="px-3 pt-3 pb-1 flex items-center gap-1.5 select-none">
      <span className={`w-1.5 h-1.5 rounded-full ${dotCls}`} />
      <span className="material-symbols-outlined text-[13px] text-text-muted">{icon}</span>
      <span className="text-[10px] font-bold uppercase tracking-wider text-text-muted">{label}</span>
      <div className="flex-1 h-px bg-border/60" />
    </div>
  );
};

// ── 右侧复合面板 ──

const RightPanel: React.FC<{
  snap: ReturnType<typeof useRoom>;
  meId: string;
  language: Language;
  systemModels: SystemModel[];
  gatewayAgents?: GatewayAgentInfo[];
  onChangeModel: (memberId: string, model: string) => Promise<void> | void;
  onChangeAgent?: (memberId: string, agentId: string) => Promise<void> | void;
  onChangeThinking?: (memberId: string, thinking: string) => Promise<void> | void;
  // v0.8 编辑成员 SystemPrompt
  onChangeSystemPrompt?: (memberId: string, systemPrompt: string) => Promise<void> | void;
  // 折叠到宽屏时由父组件注入；未注入 → 不渲染折叠按钮（例如抽屉里）。
  onCollapse?: () => void;
  // v0.7 当前激活议项 —— 供 VotePanel / QuestionsPanel 绑定议程
  activeAgendaItem: AgendaItem | null;
  onActiveAgendaItemChange: (item: AgendaItem | null) => void;
  onStartNextMeetingDraft?: (draft: NextMeetingDraft) => void;
  onSetAsSchedule?: (draft: NextMeetingDraft) => void;
  onOpenPlaybook?: (playbookId: string, context: PlaybookHighlightContext) => void;
  // v0.9：TopBar 的经验库 / 设置按钮已下沉到 LiveControlsPanel，
  // 由父组件在同一处定义回调并同时注入给 TopBar 和 RightPanel。
  // v0.9.1：投影按钮已下架（见 AgentRoom.tsx handleToggleProjection 处注释）。
  onOpenPlaybooks?: () => void;
  onOpenSettings?: () => void;
}> = ({ snap, meId, language, systemModels, gatewayAgents, onChangeModel, onChangeAgent, onChangeThinking, onChangeSystemPrompt, onCollapse, activeAgendaItem, onActiveAgendaItemChange, onStartNextMeetingDraft, onSetAsSchedule, onOpenPlaybook, onOpenPlaybooks, onOpenSettings }) => {
  const { confirm } = useConfirm();
  // v0.8 需要 toast 给"离席/邀回/静音"等成员级操作补交互反馈
  const { toast } = useToast();
  const arm = (((getTranslation(language) as any)?.multiAgentRoom) || {}) as Record<string, string>;
  const tx = (k: string, fb: string) => arm[k] || fb;
  const [personaFor, setPersonaFor] = useState<{ key: string; name: string } | null>(null);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  // v0.9：右栏各面板的"自上次展开以来新增条数"——订阅 WS room.*.append 事件累计,
  // 展开时由 onOpenChange 触发 markSeen 归零，提醒用户折叠面板里有新产出。
  const { counts: unseen, markSeen } = useUnseenCounts(snap.room?.id ?? null);
  if (!snap.room) return null;
  const room = snap.room;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto neon-scrollbar">
      <div className="px-3 h-11 shrink-0 flex items-center justify-end border-b border-border gap-2">
        <div className="flex items-center gap-2 shrink-0">
          <TimeboxMeter room={room} compact />
          <CostMeter used={room.budget.usedCNY} limit={room.budget.limitCNY} compact />
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="w-6 h-6 rounded-md hover:bg-surface-sunken text-text-muted hover:text-text flex items-center justify-center"
              title={tx('collapseRightTitle', 'Collapse right panel')}
            >
              <span className="material-symbols-outlined text-[15px]">right_panel_close</span>
            </button>
          )}
        </div>
      </div>
      <CollapsibleSection
        title={`${tx('memberCountPrefix', 'Members')} (${snap.members.filter(m => !m.isKicked).length})`}
        icon="group"
        defaultOpen={true}
      >
        <MemberRail
          members={snap.members}
          meId={meId}
          systemModels={systemModels}
          gatewayAgents={gatewayAgents}
          onChangeAgent={onChangeAgent}
          onChangeThinking={onChangeThinking}
          onChangeSystemPrompt={onChangeSystemPrompt}
          onInvite={() => setAddMemberOpen(true)}
          onRemove={async (id) => {
            const member = snap.members.find(m => m.id === id);
            const name = member?.name || tx('toastMemberMissingName', 'Member');
            // 第一步：确认是否删除
            const ok = await confirm({
              title: tx('removeMemberTitle', 'Delete member'),
              message: `${tx('removeMemberMessage', 'Permanently delete')} «${name}»? ${tx('removeMemberUndoWarning', 'This cannot be undone.')}`,
              confirmText: tx('removeMemberConfirm', 'Delete'),
              danger: true,
            });
            if (!ok) return;
            // 第二步：选择是否级联删除消息
            const cascade = await confirm({
              title: tx('removeMemberCascadeTitle', 'Delete messages too?'),
              message: tx('removeMemberCascadeMessage', 'Also remove all messages sent by this member? Choose "Cancel" to keep their message history.'),
              confirmText: tx('removeMemberCascadeYes', 'Yes, remove messages'),
              cancelText: tx('removeMemberCascadeNo', 'No, keep messages'),
              danger: true,
            });
            await removeMember(id, cascade);
            toast('info', cascade
              ? `«${name}» ${tx('toastMemberRemovedCascade', 'has been permanently deleted along with all their messages')}`
              : `«${name}» ${tx('toastMemberRemovedKeep', 'has been permanently deleted — their messages are preserved')}`);
          }}
          onKick={async (id) => {
            // v0.8：原"踢出"改"离席"——可逆操作，不再二次确认（降低杂音）。
            // toast 里带回撤指引，用户点错随时可从 MemberRail 里点"邀回"恢复。
            const member = snap.members.find(m => m.id === id);
            await kickMember(room.id, id);
            toast('info', `${tx('toastMemberKickedPrefix', '«')}${member?.name || tx('toastMemberMissingName', 'Member')}${tx('toastMemberKickedSuffix', '» has left — invite them back from the member list to restore')}`);
          }}
          onInviteBack={async (id) => {
            const member = snap.members.find(m => m.id === id);
            await inviteBackMember(room.id, id);
            toast('success', `${tx('toastMemberInvitedBackPrefix', '«')}${member?.name || tx('toastMemberMissingName', 'Member')}${tx('toastMemberInvitedBackSuffix', '» has been invited back and will speak again')}`);
          }}
          onToggleMute={async (id) => {
            const member = snap.members.find(m => m.id === id);
            const wasMuted = !!member?.isMuted;
            await toggleMute(room.id, id);
            toast('info', wasMuted
              ? `${tx('toastMemberUnmutedPrefix', '«')}${member?.name || tx('toastMemberMissingName', 'Member')}${tx('toastMemberUnmutedSuffix', '» is unmuted and will speak again next turn')}`
              : `${tx('toastMemberMutedPrefix', '«')}${member?.name || tx('toastMemberMissingName', 'Member')}${tx('toastMemberMutedSuffix', '» is muted — speaking is skipped in this room (still in the meeting)')}`);
          }}
          onWhisper={(id) => {
            window.dispatchEvent(new CustomEvent('agentroom:set-whisper', { detail: { memberId: id } }));
          }}
          onChangeModel={onChangeModel}
          onOpenPersonaMemory={(m) => {
            // memory key: user:<meId>:<agent role 或 agent name fallback>
            const role = (m.role || m.name || m.id).toLowerCase().replace(/\s+/g, '-');
            setPersonaFor({ key: `user:${meId}:${role}`, name: m.name });
          }}
        />
      </CollapsibleSection>

      {/*
        v0.8+ 右栏按"功能 + 使用频率 + 重要度"重排为 4 组：
          1) 推进会议（议程/投票/问题/风险）—— 开会时高频操作
          2) 产出 & 决策（会议产出/决策流/任务/Artifacts）—— 会议中后期产物
          3) 知识 & 记忆（房间记忆/资料 RAG/白板）—— 背景输入，按需展开
          4) 调控 & 高级（协作质量/质量指标/行为指标/安全模式/执行计划）—— 低频调试项
        每组之间有轻量分组标题，让侧栏"有呼吸"，扫视时快速定位。
        v0.8 更新：所有小面板默认折叠——之前议程/任务/白板条件性默认展开，
        导致"打开房间一屏满屏都是东西"的噪声；改为按需点击展开。
      */}

      {/* ── 1. 推进会议 ──────────────────────── */}
      <PanelGroupHeader icon="rocket_launch" label={tx('groupAdvanceMeeting', 'Advance meeting')} accent="cyan" />
      {/* v0.9：会议控制台 — 聚合 7 个热调配置项（目标 / 对抗 / 策略 / 轮次 /
          协作风格 / 预算 / 安全 / 红线），draft + 显式保存模式，点保存后一次性 PATCH。
          放在推进会议组第一个，默认折叠。 */}
      <CollapsibleSection title={tx('sectionLiveControls', 'Live controls')} icon="tune" defaultOpen={false}>
        {/* v0.9：TopBar 的投影 / 经验库 / 设置按钮下沉到此面板顶部；
            顶栏节省出来的横向空间留给"讨论中 / 当前较安静"等运行态 pill 完整显示。 */}
        <LiveControlsPanel
          room={room}
          onOpenPlaybooks={onOpenPlaybooks}
          onOpenSettings={onOpenSettings}
        />
      </CollapsibleSection>
      {/* v0.8：右栅所有小面板默认折叠，避免新人打开房间时被"满屏面板"吓到。按需展开，
          收起状态在同一 session 内用户自己展开后会持续展开。 */}
      <CollapsibleSection title={tx('sectionAgenda', 'Agenda')} icon="list_alt" defaultOpen={false}
        unseenCount={unseen.agenda} onOpenChange={(open) => open && markSeen('agenda')}>
        <AgendaRail
          roomId={room.id}
          members={snap.memberMap}
          onChange={(items) => {
            const active = items.find(x => x.status === 'active') || null;
            onActiveAgendaItemChange(active);
          }}
          readonly={room.state === 'closed' || room.state === 'archived'}
        />
      </CollapsibleSection>
      <CollapsibleSection title={tx('sectionVote', 'Vote')} icon="how_to_vote" defaultOpen={false}
        unseenCount={unseen.votes} onOpenChange={(open) => open && markSeen('votes')}>
        <VotePanel
          roomId={room.id}
          meId={meId}
          members={snap.memberMap}
          activeAgendaItem={activeAgendaItem}
        />
      </CollapsibleSection>
      <CollapsibleSection title={tx('sectionQuestions', 'Questions')} icon="help_outline" defaultOpen={false}
        unseenCount={unseen.questions} onOpenChange={(open) => open && markSeen('questions')}>
        <div className="space-y-3">
          <div>
            <div className="text-[10.5px] text-text-muted mb-1 font-semibold">{tx('sectionQuestionsOpen', 'Open questions')}</div>
            <QuestionsPanel
              roomId={room.id}
              members={snap.memberMap}
              activeAgendaItemId={activeAgendaItem?.id}
              onJump={(mid) => {
                window.dispatchEvent(new CustomEvent('agentroom:highlight-message', { detail: { roomId: room.id, messageId: mid } }));
              }}
            />
          </div>
        </div>
      </CollapsibleSection>
      <CollapsibleSection title={tx('sectionRisks', 'Risks')} icon="warning" defaultOpen={false}
        unseenCount={unseen.risks} onOpenChange={(open) => open && markSeen('risks')}>
        <RisksPanel roomId={room.id} members={snap.memberMap} />
      </CollapsibleSection>

      {/* ── 2. 产出 & 决策 ───────────────────────── */}
      <PanelGroupHeader icon="workspace_premium" label={tx('groupOutcomeDecisions', 'Outcomes & decisions')} accent="purple" />
      <CollapsibleSection title={tx('sectionOutcome', 'Outcome')} icon="flag" defaultOpen={room.state === 'closed' || room.state === 'archived'}
        unseenCount={unseen.outcome} onOpenChange={(open) => open && markSeen('outcome')}>
        <OutcomeBundleView
          roomId={room.id}
          members={snap.memberMap}
          onJump={(mid) => {
            window.dispatchEvent(new CustomEvent('agentroom:highlight-message', { detail: { roomId: room.id, messageId: mid } }));
          }}
          onStartNextMeeting={onStartNextMeetingDraft}
          onSetAsSchedule={onSetAsSchedule}
          onOpenPlaybook={onOpenPlaybook}
        />
      </CollapsibleSection>
      <CollapsibleSection
        title={`${tx('sectionDecisionsPrefix', 'Decision stream')} · ${snap.messages.filter(m => m.isDecision).length}`}
        icon="bookmark"
        defaultOpen={false}
      >
        <DecisionsPanel
          roomId={room.id}
          meId={meId}
          members={snap.memberMap}
          onJump={(mid) => {
            window.dispatchEvent(new CustomEvent('agentroom:highlight-message', { detail: { roomId: room.id, messageId: mid } }));
          }}
        />
      </CollapsibleSection>
      <CollapsibleSection title={`${tx('sectionTasksPrefix', 'Tasks')} (${(room.tasks ?? []).filter(t => t.status !== 'done').length})`} icon="task_alt" defaultOpen={false}>
        <TasksPanel
          roomId={room.id}
          tasks={room.tasks ?? []}
          members={snap.memberMap}
          meId={meId}
          onAdd={(text, aid) => addTask(room.id, { text, assigneeId: aid, creatorId: meId, status: 'todo' })}
          onToggle={(tid) => {
            const t = (room.tasks ?? []).find(x => x.id === tid);
            if (!t) return;
            updateTask(room.id, tid, { status: t.status === 'done' ? 'todo' : 'done' });
          }}
          onDelete={(tid) => updateTask(room.id, tid, { status: 'cancelled' })}
          onJumpMessage={(mid) => window.dispatchEvent(new CustomEvent('agentroom:highlight-message', { detail: { roomId: room.id, messageId: mid } }))}
        />
      </CollapsibleSection>
      <CollapsibleSection title={tx('sectionArtifacts', 'Artifacts')} icon="inventory_2" defaultOpen={false}>
        <ArtifactsPanel roomId={room.id} />
      </CollapsibleSection>

      {/* ── 3. 知识 & 记忆 ───────────────────────── */}
      <PanelGroupHeader icon="neurology" label={tx('groupKnowledgeMemory', 'Knowledge & memory')} accent="emerald" />
      <CollapsibleSection title={tx('sectionRoomMemory', 'Room memory')} icon="neurology" defaultOpen={false}>
        <MemoryPanel
          facts={room.facts ?? []}
          members={snap.memberMap}
          onUpsert={(k, v) => upsertFact(room.id, { key: k, value: v, authorId: meId, updatedAt: Date.now() })}
          onDelete={(k) => deleteFact(room.id, k)}
        />
      </CollapsibleSection>
      <CollapsibleSection title={tx('sectionDocs', 'Documents (RAG)')} icon="library_books" defaultOpen={false}>
        <DocsPanel roomId={room.id} />
      </CollapsibleSection>
      <CollapsibleSection title={tx('sectionWhiteboard', 'Whiteboard')} icon="draw" defaultOpen={false}>
        <WhiteboardPanel content={room.whiteboard} onChange={(c) => setWhiteboard(room.id, c)} />
      </CollapsibleSection>

      {/* ── 4. 指标 & 诊断 ───────────────── */}
      {/* v0.9：原“调控 & 高级”重命名为“指标 & 诊断” — 里面只剩下系统自动统计的
          质量 / 行为 / 执行计划，用户可操作的安全开关已都移到 LiveControlsPanel。 */}
      <PanelGroupHeader icon="insights" label={tx('groupControlsAdvanced', 'Metrics & diagnostics')} accent="slate" />
      {/* v0.9.1：原"协作质量"配置面板已整体下沉到 LiveControlsPanel（配置）。
          指标仪表板（QualityMetricsPanel）仍保留，它只是只读可视化，不与配置重复。 */}
      <CollapsibleSection title={tx('sectionQualityMetrics', 'Quality metrics')} icon="query_stats" defaultOpen={false}>
        <QualityMetricsPanel messages={snap.messages} />
      </CollapsibleSection>
      {snap.metrics && (
        <CollapsibleSection title={tx('sectionBehaviorMetrics', 'Behavior metrics')} icon="insights" defaultOpen={false}>
          <MetricsPanel metrics={snap.metrics} members={snap.memberMap} />
        </CollapsibleSection>
      )}
      {room.policy === 'planned' && (
        <CollapsibleSection title={tx('sectionExecutionPlan', 'Execution plan')} icon="list_alt" defaultOpen={false}>
          <PlanningPanel room={room} members={snap.members} meId={meId} />
        </CollapsibleSection>
      )}
      {/* v0.9：安全模式已移至 LiveControlsPanel（会议控制台）中的两个开关，
          避免右栏两处重复入口。 */}

      {/* v0.6 · 长期画像记忆 modal */}
      <PersonaMemoryModal
        open={!!personaFor}
        memoryKey={personaFor?.key ?? ''}
        agentName={personaFor?.name ?? ''}
        onClose={() => setPersonaFor(null)}
      />
      <AddMemberModal
        open={addMemberOpen}
        onClose={() => setAddMemberOpen(false)}
        onAdd={async (params) => {
          await addMember(room.id, params);
          toast('success', tx('toastMemberAdded', 'New member added — they will join the next round'));
        }}
        systemModels={systemModels}
        gatewayAgents={gatewayAgents}
      />
    </div>
  );
};

export default AgentRoom;
