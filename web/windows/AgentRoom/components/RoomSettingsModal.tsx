// RoomSettingsModal —— AI 会议房间设置弹窗
//
// 由 TopBar 的齿轮按钮唤起。目前包含两类设置：
//   1) 本房间（room-scoped）：auxModel —— 覆盖全局默认
//   2) 全局默认（tenant-wide）：auxModel —— 所有房间未设置时 fallback
//
// "辅助模型（Aux Model）"是专门给竞言打分、会议纪要、extract-todo、
// promote-decision、away-summary 等后台辅助 LLM 调用用的 —— 走便宜模型省钱，
// 主对话仍然用成员自己选的模型。
//
// 设计取舍：
//   - 两项都空串 = "跟随成员主模型"；不在 UI 里隐式塞硬编码兜底，避免和 Settings.tsx 风格冲突
//   - 全局默认和房间覆盖放在同一张弹窗，用户一眼能看出 fallback 链
//   - 保存分两步（各自按钮），不做"一键保存所有"，避免误改全局默认
import React, { useEffect, useMemo, useState } from 'react';
import type { Language } from '../../../types';
import { getTranslation } from '../../../locales';
import { useConfirm } from '../../../components/ConfirmDialog';
import CustomSelect from '../../../components/CustomSelect';
import {
  fetchSystemModels,
  getAgentRoomSettings,
  listRooms,
  updateAgentRoomSettings,
  updateRoom,
  type AgentRoomSettings,
  type SystemModel,
} from '../service';
import type { InterRoomBusRoute, Room, RoomProjection } from '../types';
import RoomTuningModal from './RoomTuningModal';

interface Props {
  language: Language;
  room: Room;
  open: boolean;
  onClose: () => void;
  onRoomUpdated?: (patch: Partial<Room>) => void;
}

const SectionBlock: React.FC<{
  title: string;
  hint?: string;
  children: React.ReactNode;
}> = ({ title, hint, children }) => (
  <div className="rounded-xl border border-border bg-surface-sunken/30 p-3 space-y-2.5">
    <div>
      <div className="text-[11px] font-semibold text-text-secondary">{title}</div>
      {hint ? <div className="text-[10px] text-text-muted mt-0.5 leading-relaxed">{hint}</div> : null}
    </div>
    {children}
  </div>
);

// StepBlock —— 二级弹窗里的分步卡片，与 CreateRoomWizard 的阶梯视觉保持一致：
// 左侧编号圆章 + 色带强调，右侧为步骤标题 / 描述 / 内容主体。
const StepBlock: React.FC<{
  index: number;
  title: string;
  hint?: string;
  accent?: 'cyan' | 'indigo' | 'violet';
  badge?: React.ReactNode;
  children: React.ReactNode;
}> = ({ index, title, hint, accent = 'cyan', badge, children }) => {
  const tone = accent === 'indigo'
    ? { ring: 'border-indigo-500/30', chip: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 border-indigo-500/30', bar: 'from-indigo-500/40 via-indigo-500/10 to-transparent' }
    : accent === 'violet'
    ? { ring: 'border-violet-500/30', chip: 'bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/30', bar: 'from-violet-500/40 via-violet-500/10 to-transparent' }
    : { ring: 'border-cyan-500/30', chip: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 border-cyan-500/30', bar: 'from-cyan-500/40 via-cyan-500/10 to-transparent' };
  return (
    <section className={`relative rounded-xl border ${tone.ring} bg-surface-raised/60 overflow-hidden`}>
      <div className={`absolute inset-y-0 start-0 w-0.5 bg-gradient-to-b ${tone.bar}`} />
      <div className="p-3 space-y-2.5 ps-4">
        <div className="flex items-start gap-2.5">
          <div className={`shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full border text-[11px] font-bold ${tone.chip}`}>
            {index}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-[12px] font-semibold text-text">{title}</div>
              {badge}
            </div>
            {hint ? <div className="text-[10.5px] text-text-muted mt-0.5 leading-relaxed">{hint}</div> : null}
          </div>
        </div>
        <div className="ps-8 space-y-2">{children}</div>
      </div>
    </section>
  );
};

const EntryCard: React.FC<{
  icon: string;
  accentClass: string;
  title: string;
  summary: string;
  meta?: string;
  status?: string;
  details?: string[];
  onClick: () => void;
}> = ({ icon, accentClass, title, summary, meta, status, details, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full text-start rounded-2xl border border-border bg-gradient-to-br from-surface-raised/80 via-surface to-surface-sunken/40 p-4 hover:border-cyan-500/30 hover:shadow-[0_12px_32px_rgba(0,200,255,0.12)] transition-all"
  >
    <div className="flex items-start gap-3">
      <div className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 shadow ${accentClass}`}>
        <span className="material-symbols-outlined text-[20px] text-white">{icon}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-bold text-text truncate">{title}</div>
            {status ? (
              <div className="mt-1 inline-flex items-center rounded-md border border-border bg-surface-sunken/60 px-1.5 h-5 text-[9px] font-semibold text-text-secondary">
                {status}
              </div>
            ) : null}
          </div>
          {meta ? <div className="text-[10px] font-mono text-text-muted text-end max-w-[12rem] truncate">{meta}</div> : null}
        </div>
        <div className="mt-1 text-[11px] leading-relaxed text-text-secondary">{summary}</div>
        {details && details.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {details.filter(Boolean).map((item) => (
              <span key={item} className="inline-flex items-center rounded-md border border-border bg-surface-sunken/50 px-1.5 h-5 text-[9px] text-text-muted">
                {item}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <span className="material-symbols-outlined text-[18px] text-text-muted shrink-0">arrow_forward</span>
    </div>
  </button>
);

const DetailModal: React.FC<{
  title: string;
  subtitle?: string;
  icon: string;
  open: boolean;
  onClose: () => void;
  closeLabel?: string;
  children: React.ReactNode;
}> = ({ title, subtitle, icon, open, onClose, closeLabel, children }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-[780px] max-w-[94vw] max-h-[88vh] overflow-y-auto rounded-2xl border border-border bg-surface-overlay shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-border flex items-center gap-3 bg-gradient-to-r from-cyan-500/5 via-blue-500/5 to-purple-500/5">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-500 flex items-center justify-center shrink-0 shadow-[0_4px_12px_rgba(0,200,255,0.3)]">
            <span className="material-symbols-outlined text-[20px] text-white">{icon}</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-bold text-text truncate">{title}</div>
            {subtitle ? <div className="text-[11px] text-text-muted truncate">{subtitle}</div> : null}
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-md hover:bg-surface-sunken text-text-muted hover:text-text transition-colors"
            aria-label={closeLabel || 'Close'}
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
      </div>
    </div>
  );
};

const RoomSettingsModal: React.FC<Props> = ({ language, room, open, onClose, onRoomUpdated }) => {
  const { confirm } = useConfirm();
  const tAll = useMemo(() => getTranslation(language) as any, [language]);
  const arm = (tAll?.multiAgentRoom || {}) as Record<string, string>;
  // i18n helper: prefer new arm.* key, fallback to English literal.
  const tx = (key: string, fallback: string) => (arm[key] || fallback);
  const [systemModels, setSystemModels] = useState<SystemModel[]>([]);
  const [globalSettings, setGlobalSettings] = useState<AgentRoomSettings>({ auxModel: '' });
  const [loading, setLoading] = useState(false);
  const [roomAux, setRoomAux] = useState<string>(room.auxModel || '');
  const [globalAux, setGlobalAux] = useState<string>('');
  const [savingRoom, setSavingRoom] = useState(false);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [projectionDraft, setProjectionDraft] = useState<RoomProjection>(room.projection || { enabled: false, targets: [], inboundEnabled: false, busRoutes: [] });
  const [savingBus, setSavingBus] = useState(false);
  // v0.7+ 调参向导入口 —— 把"辅助模型"设置和"调参向导"放在同一张弹窗，避免用户找不到入口。
  const [tuningOpen, setTuningOpen] = useState(false);
  const [detailView, setDetailView] = useState<'aux' | 'bus' | null>(null);

  // 打开时拉取数据；关闭时重置编辑态。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchSystemModels(false), getAgentRoomSettings(), listRooms().catch(() => [])])
      .then(([models, s, allRooms]) => {
        if (cancelled) return;
        setSystemModels(models);
        setGlobalSettings(s);
        setRooms(allRooms);
        setRoomAux(room.auxModel || '');
        setGlobalAux(s.auxModel || '');
        setProjectionDraft(room.projection || { enabled: false, targets: [], inboundEnabled: false, busRoutes: [] });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, room.id, room.auxModel]);

  useEffect(() => {
    if (!open) {
      setDetailView(null);
      setTuningOpen(false);
    }
  }, [open]);

  const modelOptions = useMemo(
    () => [
      { value: '', label: tx('auxPlaceholderRoom', 'Follow the next-level default') },
      ...systemModels.map(m => ({ value: m.id, label: m.label || m.id })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [systemModels, arm],
  );

  // 房间 aux 改了才允许保存；改回原值等价于未改
  const roomDirty = (roomAux || '') !== (room.auxModel || '');
  const globalDirty = (globalAux || '') !== (globalSettings.auxModel || '');

  // 保存失败时自动回滚本地编辑态到服务端权威值 —— 避免 UI 停留在脏值让用户困惑。
  // （hook 负责超时/失败回滚语义；此处用它只为了复用 pattern，保持代码风格一致。）
  const saveRoom = async () => {
    if (!roomDirty || savingRoom) return;
    setSavingRoom(true);
    const prev = room.auxModel || '';
    try {
      const patch: Partial<Room> = { auxModel: roomAux || '' };
      await updateRoom(room.id, patch);
      onRoomUpdated?.(patch);
    } catch {
      setRoomAux(prev); // 失败回滚到服务端真值
    } finally {
      setSavingRoom(false);
    }
  };

  const saveGlobal = async () => {
    if (!globalDirty || savingGlobal) return;
    setSavingGlobal(true);
    const prev = globalSettings.auxModel || '';
    try {
      const next = await updateAgentRoomSettings({ auxModel: globalAux });
      setGlobalSettings(next);
    } catch {
      setGlobalAux(prev); // 失败回滚
    } finally {
      setSavingGlobal(false);
    }
  };

  // 有效模型（预览 fallback 链的实际结果）
  const effectivePreview = useMemo(() => {
    if (roomAux) return `${tx('auxEffectiveRoomPrefix', 'Room override:')}${roomAux}`;
    if (globalAux) return `${tx('auxEffectiveGlobalPrefix', 'Global default:')}${globalAux}`;
    return tx('auxEffectiveFallback', "Follow members' main model (no cheap model configured)");
  }, [roomAux, globalAux, arm]);

  const busRoutes = projectionDraft.busRoutes || [];
  const enabledBusRoutes = busRoutes.filter((route) => route.enabled && String(route.targetRoomId || '').trim()).length;
  const auxStatus = roomAux
    ? tx('auxStatusRoomOverride', 'Room override active')
    : globalAux
    ? tx('auxStatusGlobalDefault', 'Using global default')
    : tx('auxStatusFollowMember', "Following members' main model");
  const busStatus = enabledBusRoutes > 0
    ? `${tx('busStatusActivePrefix', 'Active:')} ${enabledBusRoutes} ${tx('busStatusActiveSuffix', 'rule(s)')}`
    : busRoutes.length > 0
    ? tx('busStatusInactive', 'Configured but not enabled')
    : tx('busStatusNoRules', 'No rules configured');
  const ensureProjectionBase = (prev?: RoomProjection): RoomProjection => ({
    enabled: prev?.enabled || false,
    targets: prev?.targets || [],
    inboundEnabled: prev?.inboundEnabled || false,
    busRoutes: prev?.busRoutes || [],
  });

  const updateBusRoute = (id: string, patch: Partial<InterRoomBusRoute>) => {
    setProjectionDraft((prev) => {
      const base = ensureProjectionBase(prev);
      return {
        ...base,
        busRoutes: (base.busRoutes || []).map((route) => route.id === id ? { ...route, ...patch } : route),
      };
    });
  };

  const addBusRoute = () => {
    const id = `closeout-agenda-${Date.now()}`;
    setProjectionDraft((prev) => {
      const base = ensureProjectionBase(prev);
      return {
        ...base,
        busRoutes: [
          ...(base.busRoutes || []),
          {
            id,
            enabled: false,
            trigger: 'closeout.done',
            deliveryMode: 'agenda_item',
            targetRoomId: '',
            titleTemplate: tx('busDefaultTitleTemplate', 'Retro source output: {{sourceRoomTitle}}'),
            note: '',
          },
        ],
      };
    });
  };

  const removeBusRoute = async (id: string) => {
    const ok = await confirm({
      title: tx('busRemoveRuleTitle', 'Remove delivery rule'),
      message: tx('busRemoveRuleMsg', 'This cross-room delivery rule will be removed. Continue?'),
      confirmText: tx('confirmDelete', 'Delete'),
      danger: true,
    });
    if (!ok) return;
    setProjectionDraft((prev) => {
      const base = ensureProjectionBase(prev);
      return {
        ...base,
        busRoutes: (base.busRoutes || []).filter((route) => route.id !== id),
      };
    });
  };

  const busDirty = JSON.stringify(projectionDraft || {}) !== JSON.stringify(room.projection || { enabled: false, targets: [], inboundEnabled: false, busRoutes: [] });
  const pendingChanges = [roomDirty, globalDirty, busDirty].filter(Boolean).length;

  const saveBus = async () => {
    if (!busDirty || savingBus) return;
    const enabledCount = busRoutes.filter((route) => route.enabled && String(route.targetRoomId || '').trim()).length;
    const ok = await confirm({
      title: enabledCount > 0 ? '保存跨房间投递' : '关闭跨房间投递',
      message: enabledCount > 0
        ? `保存后，本房间 closeout 完成时会按已启用规则把会议产出自动投递到目标房间议程。当前启用 ${enabledCount} 条规则，确认继续吗？`
        : '保存后将关闭当前房间的跨房间投递规则。确认继续吗？',
      confirmText: '确认保存',
    });
    if (!ok) return;
    setSavingBus(true);
    try {
      const sanitizedRoutes = busRoutes
        .map((route) => ({
          ...route,
          targetRoomId: String(route.targetRoomId || '').trim(),
          titleTemplate: String(route.titleTemplate || '').trim(),
          note: String(route.note || '').trim(),
        }))
        .filter((route) => route.enabled ? !!route.targetRoomId : true);
      const patch: Partial<Room> = {
        projection: {
          ...ensureProjectionBase(projectionDraft),
          busRoutes: sanitizedRoutes,
        },
      };
      await updateRoom(room.id, patch);
      onRoomUpdated?.(patch);
    } finally {
      setSavingBus(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={tx('settingsModalTitle', 'AI Meeting Settings')}
    >
      <div
        className="sci-card w-[520px] max-w-[92vw] max-h-[85vh] overflow-y-auto bg-surface-overlay border border-border rounded-xl shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px] text-cyan-500">tune</span>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-bold text-text truncate">{tx('settingsModalTitle', 'AI Meeting Settings')}</div>
            <div className="text-[11px] text-text-muted truncate">{room.title}</div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md hover:bg-surface-sunken text-text-muted hover:text-text transition-colors"
            aria-label={tx('close', 'Close')}
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>

        {loading ? (
          <div className="px-4 py-8 text-center text-[12px] text-text-muted">{tx('loading', 'Loading…')}</div>
        ) : (
          <div className="p-4 space-y-5">
            {/* v0.7+ 调参向导入口 —— 放在最顶，新手首选路径。
                辅助模型 / 全局默认这些"只是 aux LLM"的设置放下面，避免遮盖主力入口。 */}
            <button
              type="button"
              onClick={() => setTuningOpen(true)}
              className="w-full text-start p-3 rounded-xl border border-violet-500/40 bg-gradient-to-br from-violet-500/10 to-cyan-500/5 hover:border-violet-500/70 hover:shadow-[0_0_16px_var(--glow-violet)] transition-all group"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-[22px] text-violet-500 group-hover:scale-110 transition-transform">
                  settings_suggest
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-[13px] font-bold text-text">{tx('settingsTuningTitle', 'Room tuning wizard')}</div>
                    <span className="inline-flex items-center px-1.5 h-4 rounded text-[9px] font-semibold bg-violet-500/15 text-violet-600 dark:text-violet-400">
                      v0.7+
                    </span>
                  </div>
                  <div className="text-[11px] text-text-secondary mt-0.5 leading-relaxed">
                    {tx('settingsTuningDesc', 'Apply preset styles (casual / deep work / debate / brainstorm), or fine-tune speaking thresholds, memory compression, and persona prompts.')}
                  </div>
                </div>
                <span className="material-symbols-outlined text-[18px] text-text-muted group-hover:text-violet-500 transition-colors">
                  arrow_forward
                </span>
              </div>
            </button>

            <div className="text-[11px] font-semibold text-text-secondary">{tx('settingsCategoryTitle', 'Categories')}</div>

            <EntryCard
              icon="tune"
              accentClass="bg-gradient-to-br from-cyan-500 to-blue-500"
              title={tx('auxCardTitle', 'Aux model & defaults')}
              summary={tx('auxCardSummary', 'Manage room-level Aux overrides and the workspace-wide default value.')}
              meta={effectivePreview}
              status={auxStatus}
              details={[
                roomAux ? tx('auxDetailRoomSetLabel', 'Room override set') : tx('auxDetailRoomUnsetLabel', 'No room override'),
                globalAux ? tx('auxDetailGlobalSetLabel', 'Global default set') : tx('auxDetailGlobalUnsetLabel', 'Global default unset'),
                roomDirty || globalDirty ? tx('auxDetailHasChanges', 'Unsaved changes') : tx('auxDetailNoChanges', 'No pending changes'),
              ]}
              onClick={() => setDetailView('aux')}
            />

            <EntryCard
              icon="hub"
              accentClass="bg-gradient-to-br from-indigo-500 to-violet-500"
              title={tx('busCardTitle', 'Inter-room bus')}
              summary={tx('busCardSummary', 'Configure delivery rules, target rooms, and title templates for sending closeout results to other rooms.')}
              meta={`${busRoutes.length} ${tx('busCardRouteCountSuffix', 'rule(s)')}`}
              status={busStatus}
              details={[
                enabledBusRoutes > 0 ? `${enabledBusRoutes} ${tx('busCardEnabledSuffix', 'rule(s) enabled')}` : tx('busCardNoneEnabled', 'No rules enabled'),
                busDirty ? tx('busCardHasChanges', 'Unsaved changes') : tx('busCardNoChanges', 'No pending changes'),
              ]}
              onClick={() => setDetailView('bus')}
            />

            <DetailModal
              title={tx('auxDetailTitle', 'Aux model & defaults')}
              subtitle={tx('auxDetailSubtitle', 'Manage the current-room Aux override and the global default')}
              icon="tune"
              open={detailView === 'aux'}
              onClose={() => setDetailView(null)}
              closeLabel={tx('close', 'Close')}
            >

            {/* 概念导读 —— 与 CreateRoomWizard 的 intro bar 保持一致的色调 */}
            <div className="rounded-xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/8 via-blue-500/5 to-surface p-3">
              <div className="flex items-start gap-2.5">
                <span className="material-symbols-outlined text-[18px] text-cyan-500 mt-0.5">info</span>
                <div className="text-[11.5px] text-text-secondary leading-relaxed">
                  <span className="font-semibold text-cyan-600 dark:text-cyan-400">{tx('auxIntroLead', 'Aux Model')}</span>{' '}
                  {tx('auxIntroBody', 'is used for internal LLM calls in this room: competitive-speaking scoring, meeting minutes, TODO extraction, decision summaries, absence digests, etc. These calls are not quality-sensitive — a cheap model (gpt-4o-mini / gpt-5-mini / haiku) is recommended to save cost.')}
                  <span className="block mt-1 text-text-muted">{tx('auxIntroFooter', "Main dialogue keeps using each member's own model and is not affected.")}</span>
                </div>
              </div>
            </div>

            {/* 步骤 1 · 本房间覆盖 */}
            <StepBlock
              index={1}
              accent="cyan"
              title={tx('auxStep1Title', 'Room override')}
              hint={tx('auxStep1Hint', 'Highest priority. Only affects the current room. Leave empty to follow the next level.')}
              badge={
                <span className="inline-flex items-center rounded-md border border-border bg-surface-sunken/60 px-1.5 h-5 text-[9px] font-mono text-text-muted">auxModel</span>
              }
            >
              <CustomSelect
                value={roomAux}
                onChange={v => setRoomAux(v)}
                options={modelOptions}
                placeholder={tx('auxPlaceholderRoom', 'Follow the next-level default')}
                className="h-9 w-full px-2 rounded-lg text-[12px] bg-surface-raised border border-border"
              />
              <div className="flex justify-end">
                <button
                  onClick={saveRoom}
                  disabled={!roomDirty || savingRoom}
                  className="inline-flex items-center gap-1.5 px-3 h-7 rounded-md text-[11.5px] font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-cyan-500 hover:bg-cyan-600 text-white"
                >
                  {savingRoom ? (
                    <>
                      <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                      {tx('saving', 'Saving…')}
                    </>
                  ) : tx('auxSaveRoom', 'Save this room')}
                </button>
              </div>
            </StepBlock>

            {/* 步骤 2 · 全局默认 */}
            <StepBlock
              index={2}
              accent="cyan"
              title={tx('auxStep2Title', 'Global default')}
              hint={tx('auxStep2Hint', 'Applied to rooms without their own override. Leave empty to fall back to members’ main models.')}
              badge={
                <span className="inline-flex items-center rounded-md border border-border bg-surface-sunken/60 px-1.5 h-5 text-[9px] font-mono text-text-muted">agentroom.aux_model</span>
              }
            >
              <CustomSelect
                value={globalAux}
                onChange={v => setGlobalAux(v)}
                options={modelOptions}
                placeholder={tx('auxPlaceholderGlobal', "Unset (follow members' main model)")}
                className="h-9 w-full px-2 rounded-lg text-[12px] bg-surface-raised border border-border"
              />
              <div className="flex justify-end">
                <button
                  onClick={saveGlobal}
                  disabled={!globalDirty || savingGlobal}
                  className="inline-flex items-center gap-1.5 px-3 h-7 rounded-md text-[11.5px] font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-surface-raised hover:bg-surface-sunken border border-border text-text"
                >
                  {savingGlobal ? (
                    <>
                      <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                      {tx('saving', 'Saving…')}
                    </>
                  ) : tx('auxSaveGlobal', 'Save global')}
                </button>
              </div>
            </StepBlock>

            {/* 步骤 3 · 生效预览 */}
            <StepBlock
              index={3}
              accent="cyan"
              title={tx('auxStep3Title', 'Currently effective')}
              hint={tx('auxStep3Hint', 'Fallback chain: room → global default → member main model. Below is the value actually used right now.')}
            >
              <div className="rounded-lg border border-border bg-surface-sunken/40 px-3 py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10.5px] text-text-muted">{tx('settingsAuxSourceLabel', 'Aux source')}</div>
                  <div className="mt-0.5 text-[12px] font-semibold text-text truncate">{auxStatus}</div>
                </div>
                <div className="text-[10.5px] font-mono text-text-secondary text-end max-w-[16rem] truncate">
                  {effectivePreview}
                </div>
              </div>
            </StepBlock>

            </DetailModal>

            <DetailModal
              title={tx('busDetailTitle', 'Inter-room bus')}
              subtitle={tx('busDetailSubtitle', 'Configure rules for delivering closeout results to other rooms')}
              icon="hub"
              open={detailView === 'bus'}
              closeLabel={tx('close', 'Close')}
              onClose={() => setDetailView(null)}
            >

            {/* 概念导读 */}
            <div className="rounded-xl border border-indigo-500/20 bg-gradient-to-br from-indigo-500/8 via-violet-500/5 to-surface p-3">
              <div className="flex items-start gap-2.5">
                <span className="material-symbols-outlined text-[18px] text-indigo-500 mt-0.5">hub</span>
                <div className="text-[11.5px] text-text-secondary leading-relaxed">
                  <span className="font-semibold text-indigo-600 dark:text-indigo-300">{tx('busIntroLead', 'Inter-room bus')}</span>{' '}
                  {tx('busIntroBody', 'Automatically forwards this room’s closeout output to another room as a new agenda item or task.')}
                  <span className="block mt-1 text-text-muted font-mono text-[10.5px]">closeout.done → agenda</span>
                </div>
              </div>
            </div>

            {/* 步骤 1 · 规则列表 */}
            <StepBlock
              index={1}
              accent="indigo"
              title={tx('busStep1Title', 'Delivery rules')}
              hint={tx('busStep1Hint', 'Each rule describes one cross-room delivery: trigger event, target room, and agenda title template.')}
              badge={
                <span className="inline-flex items-center rounded-md border border-border bg-surface-sunken/60 px-1.5 h-5 text-[9px] text-text-muted">
                  {tx('busStep1CountPrefix', 'Configured')} {busRoutes.length} {tx('busStep1CountSuffix', 'rule(s)')}
                </span>
              }
            >
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={addBusRoute}
                    className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-md text-[11px] font-semibold bg-surface-raised hover:bg-surface-sunken border border-border text-text"
                  >
                    <span className="material-symbols-outlined text-[14px]">add</span>
                    {tx('busAddRule', 'Add rule')}
                  </button>
                </div>

                {busRoutes.length === 0 ? (
                  <div className="px-2 py-6 text-center text-[11px] text-text-muted border border-dashed border-border rounded-md">
                    {tx('busNoRulesHint', 'No delivery rules yet. Add a closeout → agenda automation.')}
                  </div>
                ) : busRoutes.map((route, idx) => (
                  <div key={route.id} className="rounded-lg border border-border bg-surface-raised/40 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] font-semibold text-text-secondary">{tx('busRuleNumberPrefix', 'Rule')} {idx + 1}</div>
                      <button
                        type="button"
                        onClick={() => removeBusRoute(route.id)}
                        className="inline-flex items-center gap-1 px-2 h-6 rounded text-[10.5px] border border-danger/30 text-danger hover:bg-danger/10"
                      >
                        <span className="material-symbols-outlined text-[12px]">delete</span>
                        {tx('delete', 'Delete')}
                      </button>
                    </div>

                    <label className="inline-flex items-center gap-2 text-[11.5px] text-text-secondary">
                      <input
                        type="checkbox"
                        checked={!!route.enabled}
                        onChange={(e) => updateBusRoute(route.id, { enabled: e.target.checked })}
                        className="rounded border-border"
                      />
                      {tx('busRuleEnabledLabel', 'Enable closeout auto-delivery')}
                    </label>

                    <div className="grid grid-cols-2 gap-2">
                      <CustomSelect
                        value={route.trigger || 'closeout.done'}
                        onChange={(v) => updateBusRoute(route.id, { trigger: (v || 'closeout.done') as InterRoomBusRoute['trigger'] })}
                        options={[
                          { value: 'closeout.done', label: tx('busTriggerClosesoutDone', 'Trigger: closeout.done') },
                          { value: 'retro.updated', label: tx('busTriggerRetroUpdated', 'Trigger: retro.updated') },
                        ]}
                        className="h-9 w-full px-2 rounded-lg text-[12px] bg-surface-raised border border-border"
                      />
                      <CustomSelect
                        value={route.deliveryMode || 'agenda_item'}
                        onChange={(v) => updateBusRoute(route.id, { deliveryMode: (v || 'agenda_item') as InterRoomBusRoute['deliveryMode'] })}
                        options={[
                          { value: 'agenda_item', label: tx('busDeliverAgenda', 'Deliver: Agenda') },
                          { value: 'task', label: tx('busDeliverTask', 'Deliver: Task') },
                        ]}
                        className="h-9 w-full px-2 rounded-lg text-[12px] bg-surface-raised border border-border"
                      />
                    </div>

                    <CustomSelect
                      value={route.targetRoomId || ''}
                      onChange={(v) => updateBusRoute(route.id, { targetRoomId: v || '' })}
                      options={[
                        { value: '', label: tx('busTargetRoomPlaceholder', 'Select target room') },
                        ...rooms.filter((item) => item.id !== room.id).map((item) => ({ value: item.id, label: item.title || item.id })),
                      ]}
                      className="h-9 w-full px-2 rounded-lg text-[12px] bg-surface-raised border border-border"
                    />

                    <input
                      value={String(route.titleTemplate || '')}
                      onChange={(e) => updateBusRoute(route.id, { titleTemplate: e.target.value })}
                      placeholder={tx('busTitleTemplatePlaceholder', 'Agenda title template, e.g. Retro source output: {{sourceRoomTitle}}')}
                      className="h-9 px-2.5 rounded-lg bg-surface-raised border border-border sci-input text-[12px]"
                    />

                    <textarea
                      value={String(route.note || '')}
                      onChange={(e) => updateBusRoute(route.id, { note: e.target.value })}
                      rows={2}
                      placeholder={tx('busNotePlaceholder', 'Extra note (appended to the target agenda description)')}
                      className="w-full px-2.5 py-2 rounded-lg bg-surface-raised border border-border sci-input text-[11.5px] resize-none"
                    />
                  </div>
                ))}

            </StepBlock>

            {/* 步骤 2 · 护栏说明 */}
            <StepBlock
              index={2}
              accent="indigo"
              title={tx('busStep2Title', 'Delivery guardrails')}
              hint={tx('busStep2Hint', 'These guardrails apply automatically — no extra configuration required. Just know what they do.')}
            >
              <ul className="text-[10.5px] text-text-secondary leading-relaxed bg-surface-sunken/40 border border-border rounded-md px-3 py-2 space-y-1 list-disc list-inside marker:text-text-muted">
                <li>{tx('busGuardrail1', 'Only rooms owned by the same user can deliver to each other; cross-owner is rejected.')}</li>
                <li>{tx('busGuardrail2', 'Direct A→B + B→A loops are avoided by default to prevent cascading triggers.')}</li>
                <li>{tx('busGuardrail3', 'Duplicate closeouts are deduplicated idempotently via a bundle marker — no duplicate agenda items.')}</li>
              </ul>
            </StepBlock>

            {/* 步骤 3 · 保存 */}
            <StepBlock
              index={3}
              accent="indigo"
              title={tx('busStep3Title', 'Save and apply')}
              hint={tx('busStep3Hint', 'Once saved, new rules take effect on the next closeout.done event in the order shown above.')}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10.5px] text-text-muted">
                  {busDirty ? tx('busStep3HasChanges', 'You have unsaved changes. Save to apply.') : tx('busStep3NoChanges', 'Rules are in sync with the server.')}
                </div>
                <button
                  type="button"
                  onClick={saveBus}
                  disabled={!busDirty || savingBus}
                  className="inline-flex items-center gap-1.5 px-3 h-7 rounded-md text-[11.5px] font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-indigo-500 hover:bg-indigo-600 text-white"
                >
                  {savingBus ? (
                    <>
                      <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                      {tx('saving', 'Saving…')}
                    </>
                  ) : tx('busSave', 'Save delivery rules')}
                </button>
              </div>
            </StepBlock>

            </DetailModal>

          </div>
        )}
      </div>

      {/* v0.7+ 调参向导 —— 独立浮层；关闭时回调 onRoomUpdated 让父组件同步 policyOptions */}
      <RoomTuningModal
        room={room}
        open={tuningOpen}
        onClose={() => setTuningOpen(false)}
        onRoomUpdated={onRoomUpdated}
      />
    </div>
  );
};

export default RoomSettingsModal;
