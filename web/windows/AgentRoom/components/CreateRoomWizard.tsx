// 创建房间向导 —— 两条路径：
//   1) 模板路径（新手 2 步）：模板 + 初始 prompt
//   2) 自定义路径（高级 5 步）：目标 / 成员 / 氛围 / 策略 / 预算
//      v0.9：第 3 步原为"工具配置"，与成员卡高级区重复、价值低；已替换为房间级
//      "氛围与节奏"（冲突模式 + 轮次预算 + 协作风格），直接注入每轮 system prompt。
import React, { useEffect, useMemo, useState } from 'react';
import type { NextMeetingDraft, RoomTemplate, RoomPolicy, TemplateMemberOverride, RoleProfile, GatewayAgentInfo, PlaybookV7 } from '../types';
import {
  listTemplates,
  listGatewayAgents, getGatewayStatus,
  fetchSystemModels,
  SUGGESTED_EMOJIS, listRoleProfiles,
  createRoleProfile, updateRoleProfile, deleteRoleProfile,
  recommendPlaybooks,
  type CustomMemberSpec,
  type SystemModel,
} from '../service';
import { POLICY_META } from '../shared';
import CustomSelect from '../../../components/CustomSelect';
import { useConfirm } from '../../../components/ConfirmDialog';
import RoleEditorModal from './RoleEditorModal';
import AiRoomPath from './AiRoomPath';
import { resolveTemplateColor } from '../../../utils/templateColors';

type ConflictMode = '' | 'review' | 'debate';

type CreateRequest =
  | { kind: 'template'; templateId: string; title?: string; initialPrompt?: string; budgetCNY?: number; memberOverrides?: TemplateMemberOverride[]; auxModel?: string; conflictMode?: ConflictMode }
  | { kind: 'custom'; title: string; goal?: string; members: CustomMemberSpec[]; policy: RoomPolicy; budgetCNY: number; initialPrompt?: string; auxModel?: string; conflictMode?: ConflictMode; roundBudget?: number; collaborationStyle?: string };

interface Props {
  // onCreate 支持 async — 向导据此显示 loading 并锁住 primary 按钮，避免双击创建重复房间。
  onCreate: (req: CreateRequest) => void | Promise<void>;
  onCancel: () => void;
  initialMode?: Exclude<Mode, 'choose'>;
  initialDraft?: NextMeetingDraft;
}

type Mode = 'choose' | 'template' | 'custom' | 'ai' | 'roles';

const CreateRoomWizard: React.FC<Props> = ({ onCreate, onCancel, initialMode, initialDraft }) => {
  const [mode, setMode] = useState<Mode>(initialMode || 'choose');

  useEffect(() => {
    setMode(initialMode || 'choose');
  }, [initialMode]);

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-surface rounded-2xl shadow-2xl border border-border w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-card-enter">
        {mode === 'choose' && <ModeChooser onPick={setMode} onCancel={onCancel} />}
        {mode === 'template' && <TemplatePath onCreate={onCreate} onCancel={onCancel} onBack={() => setMode('choose')} initialDraft={initialDraft} />}
        {mode === 'custom' && <CustomPath onCreate={onCreate} onCancel={onCancel} onBack={() => setMode('choose')} initialDraft={initialDraft} />}
        {mode === 'ai' && <AiRoomPath onCreate={onCreate} onCancel={onCancel} onBack={() => setMode('choose')} />}
        {mode === 'roles' && <RoleLibraryView onBack={() => setMode('choose')} onCancel={onCancel} />}
      </div>
    </div>
  );
};

// ─────────────────────────── Mode chooser ───────────────────────────

const ModeChooser: React.FC<{ onPick: (m: Mode) => void; onCancel: () => void }> = ({ onPick, onCancel }) => (
  <>
    <div className="shrink-0 px-5 py-4 border-b border-border flex items-center gap-3 bg-gradient-to-r from-cyan-500/5 via-blue-500/5 to-purple-500/5">
      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-500 flex items-center justify-center shadow-[0_4px_12px_rgba(0,200,255,0.3)]">
        <span className="material-symbols-outlined text-white text-[22px]">groups_3</span>
      </div>
      <div className="flex-1">
        <h2 className="text-[15px] font-bold text-text">召集你的 AI 团队</h2>
        <p className="text-[11px] text-text-secondary">先选个起点</p>
      </div>
      <button onClick={onCancel} className="w-8 h-8 rounded-md hover:bg-surface-sunken flex items-center justify-center text-text-secondary">
        <span className="material-symbols-outlined text-[18px]">close</span>
      </button>
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto neon-scrollbar p-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl mx-auto">
        <button
          onClick={() => onPick('template')}
          className="group relative overflow-hidden rounded-2xl ring-1 ring-border hover:ring-cyan-400/50 hover:shadow-[0_12px_32px_rgba(0,200,255,0.25)] transition-all text-start p-5 bg-gradient-to-br from-cyan-500/5 via-blue-500/5 to-transparent"
        >
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-500 flex items-center justify-center shadow mb-3 group-hover:scale-110 transition-transform">
            <span className="material-symbols-outlined text-white text-[24px]">auto_awesome</span>
          </div>
          <h3 className="text-[14px] font-bold text-text mb-1">选一个模板</h3>
          <p className="text-[11px] text-text-secondary leading-relaxed mb-3">
            从 10 个官方场景开始：产品评审 / 代码审查 / 故事接龙 / 反向对抗…
          </p>
          <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-cyan-600 dark:text-cyan-400">
            <span>60 秒上手</span>
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </div>
        </button>

        <button
          onClick={() => onPick('custom')}
          className="group relative overflow-hidden rounded-2xl ring-1 ring-border hover:ring-purple-400/50 hover:shadow-[0_12px_32px_rgba(139,92,246,0.25)] transition-all text-start p-5 bg-gradient-to-br from-purple-500/5 via-fuchsia-500/5 to-transparent"
        >
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-purple-500 to-fuchsia-500 flex items-center justify-center shadow mb-3 group-hover:scale-110 transition-transform">
            <span className="material-symbols-outlined text-white text-[24px]">construction</span>
          </div>
          <h3 className="text-[14px] font-bold text-text mb-1">自己搭建</h3>
          <p className="text-[11px] text-text-secondary leading-relaxed mb-3">
            逐个定义成员 / 模型 / 策略。适合你有明确想法、或要做实验的场景。
          </p>
          <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-purple-600 dark:text-purple-400">
            <span>5 步完成</span>
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </div>
        </button>

        <button
          onClick={() => onPick('ai')}
          className="group relative overflow-hidden rounded-2xl ring-1 ring-border hover:ring-amber-400/50 hover:shadow-[0_12px_32px_rgba(245,158,11,0.25)] transition-all text-start p-5 bg-gradient-to-br from-amber-500/5 via-orange-500/5 to-transparent"
        >
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center shadow mb-3 group-hover:scale-110 transition-transform">
            <span className="material-symbols-outlined text-white text-[24px]">magic_button</span>
          </div>
          <h3 className="text-[14px] font-bold text-text mb-1">AI 一句话建会</h3>
          <p className="text-[11px] text-text-secondary leading-relaxed mb-3">
            描述你的场景，AI 自动生成标题、目标、成员阵容和策略，一键启动。
          </p>
          <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
            <span>智能搭建</span>
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </div>
        </button>

        <button
          onClick={() => onPick('roles')}
          className="group relative overflow-hidden rounded-2xl ring-1 ring-border hover:ring-fuchsia-400/50 hover:shadow-[0_12px_32px_rgba(217,70,239,0.2)] transition-all text-start p-5 bg-gradient-to-br from-fuchsia-500/5 via-violet-500/5 to-transparent"
        >
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-fuchsia-500 to-violet-500 flex items-center justify-center shadow mb-3 group-hover:scale-110 transition-transform">
            <span className="material-symbols-outlined text-white text-[24px]">badge</span>
          </div>
          <h3 className="text-[14px] font-bold text-text mb-1">管理角色库</h3>
          <p className="text-[11px] text-text-secondary leading-relaxed mb-3">
            维护可复用的角色模板：提示词、模型绑定、立场与交互偏好。
          </p>
          <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-fuchsia-600 dark:text-fuchsia-400">
            <span>角色管理</span>
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </div>
        </button>
      </div>
    </div>
  </>
);

// ─────────────────────────── Template path (2 steps) ───────────────────────────

const CATEGORIES: { id: RoomTemplate['category']; label: string; icon: string }[] = [
  { id: 'ops',      label: '运营',       icon: 'support_agent' },
  { id: 'dev',      label: '开发',       icon: 'code' },
  { id: 'research', label: '研究/对抗',  icon: 'science' },
  { id: 'fun',      label: '娱乐',       icon: 'celebration' },
];

type HealthItem = { level: 'good' | 'warn'; text: string };

function renderHealthItems(items: HealthItem[]) {
  return (
    <div className="rounded-xl border border-border bg-surface-raised p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="material-symbols-outlined text-[16px] text-cyan-500">health_and_safety</span>
        <span className="text-[12.5px] font-semibold text-text">会前体检</span>
      </div>
      <div className="space-y-1.5">
        {items.map((item, idx) => (
          <div key={idx} className="flex items-start gap-2 text-[11.5px]">
            <span className={`material-symbols-outlined text-[14px] mt-0.5 shrink-0 ${item.level === 'good' ? 'text-emerald-500' : 'text-amber-500'}`}>
              {item.level === 'good' ? 'check_circle' : 'warning'}
            </span>
            <span className={item.level === 'good' ? 'text-text-secondary' : 'text-amber-700 dark:text-amber-300'}>{item.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const TemplatePath: React.FC<{ onCreate: (r: CreateRequest) => void | Promise<void>; onCancel: () => void; onBack: () => void; initialDraft?: NextMeetingDraft }> = ({ onCreate, onCancel, onBack, initialDraft }) => {
  const [templates, setTemplates] = useState<RoomTemplate[]>([]);
  const [selected, setSelected] = useState<RoomTemplate | null>(null);
  const [category, setCategory] = useState<RoomTemplate['category'] | 'all'>('all');
  const [step, setStep] = useState<1 | 2>(1);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [budget, setBudget] = useState(10);
  // v0.8 建房即选冲突驱动模式。'' = 跟模板 preset 的默认值（后端不下发即走 preset）。
  // 切换模板时自动回到 '' 让用户重新判断，避免残留上一模板的选择。
  const [conflictMode, setConflictMode] = useState<ConflictMode>('');

  useEffect(() => { listTemplates().then(setTemplates); }, []);

  // v0.4 高级覆盖：每个模板 member 的 agentId / thinking 可单独覆盖。keyed by roleId。
  const [overrides, setOverrides] = useState<Record<string, { agentId?: string; thinking?: string }>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // v0.4：房间级辅助模型（竞言 / 纪要 / extract-todo 等），留空跟随全局默认
  const [auxModel, setAuxModel] = useState<string>('');
  const [gatewayAgents, setGatewayAgents] = useState<GatewayAgentInfo[]>([]);
  const [gatewayReady, setGatewayReady] = useState<boolean | null>(null);
  // v0.4：辅助模型下拉改从 OpenClaw config.models.providers 拉真实列表
  // （和 RoomSettingsModal 一致），不再用硬编码 SUGGESTED_MODELS。
  const [systemModels, setSystemModels] = useState<SystemModel[]>([]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([listGatewayAgents(), getGatewayStatus(), fetchSystemModels(false)]).then(([list, st, models]) => {
      if (cancelled) return;
      setGatewayAgents(list);
      setGatewayReady(!!st.available);
      setSystemModels(models);
    }).catch(() => { if (!cancelled) setGatewayReady(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!initialDraft) return;
    setTitle(initialDraft.title || '');
    setPrompt(initialDraft.goal || initialDraft.agendaItems.join('\n'));
  }, [initialDraft]);
  useEffect(() => {
    if (!initialDraft?.templateId || templates.length === 0) return;
    const matched = templates.find(t => t.id === initialDraft.templateId);
    if (!matched) return;
    setSelected(matched);
    setStep(2);
    if (!title.trim()) setTitle(initialDraft.title || matched.name);
    if (!prompt.trim()) setPrompt(initialDraft.goal || initialDraft.agendaItems.join('\n') || '');
  }, [initialDraft, templates, title, prompt]);
  // 切换模板时清空覆盖（避免跨模板残留无效 roleId）+ 冲突模式（回到"跟模板"）。
  useEffect(() => {
    setOverrides({});
    setAdvancedOpen(false);
    setConflictMode('');
  }, [selected?.id]);

  const filtered = category === 'all' ? templates : templates.filter(t => t.category === category);
  // v0.8：隐藏“热门模板”置顶区——stars 字段是占位虚数，排名感不真实。保留分类 Tab 即可。
  // 如果以后接入真实使用数据（install count / last月使用）再重新开启。

  const buildOverridesPayload = (): TemplateMemberOverride[] | undefined => {
    const list: TemplateMemberOverride[] = [];
    for (const [roleId, ov] of Object.entries(overrides)) {
      const agentId = ov.agentId?.trim();
      const thinking = ov.thinking?.trim();
      if (agentId || thinking) list.push({ roleId, agentId: agentId || undefined, thinking: thinking || undefined });
    }
    return list.length > 0 ? list : undefined;
  };

  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    if (!selected || submitting) return; // 双击守护
    setSubmitting(true);
    try {
      await onCreate({
        kind: 'template',
        templateId: selected.id,
        title: title.trim() || selected.name,
        initialPrompt: prompt.trim() || undefined,
        budgetCNY: budget,
        memberOverrides: buildOverridesPayload(),
        auxModel: auxModel.trim() || undefined,
        conflictMode: conflictMode || undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const overrideCount = Object.values(overrides).filter(o => o.agentId || o.thinking).length;
  const healthItems = useMemo<HealthItem[]>(() => {
    const items: HealthItem[] = [];
    if (selected) items.push({ level: 'good', text: `将以「${selected.name}」模板开局，默认包含 ${selected.members.length} 个角色` });
    items.push(prompt.trim()
      ? { level: 'good', text: '已写开场白，房间启动后更容易直接进入讨论' }
      : { level: 'warn', text: '还没写开场白。新手建议补一句目标或背景，避免 AI 开局跑偏' });
    items.push(budget >= 8
      ? { level: 'good', text: `预算 ¥${budget} 较稳妥，适合完整跑完讨论与收尾` }
      : { level: 'warn', text: `预算 ¥${budget} 偏紧，长讨论或总结阶段可能更早触发预算提醒` });
    if (gatewayReady === false) items.push({ level: 'warn', text: 'Gateway 当前未连接。房间可以创建，但 AI 角色要等网关恢复后才能顺畅工作' });
    else items.push({ level: 'good', text: 'Gateway 状态正常，可直接发起会议' });
    return items;
  }, [selected, prompt, budget, gatewayReady]);

  return (
    <>
      <WizardHeader
        icon="auto_awesome"
        gradient="from-cyan-500 to-blue-500"
        title="从模板开始"
        subtitle={step === 1 ? '第 1 步 · 选一个场景' : '第 2 步 · 告诉团队要做什么'}
        onBack={onBack}
        onCancel={onCancel}
        stepLabel={`${step} / 2`}
      />
      <div className="flex-1 min-h-0 overflow-y-auto neon-scrollbar p-5">
        {step === 1 && (
          <>
            {/* v0.8：移除“热门模板”置顶区和底部“想要更多”提示——前者靠虚构 stars 排序，
                后者指向的模板市场尚未落地，避免做假动作。 */}
            <div className="flex items-center gap-1 mb-3 p-0.5 rounded-lg bg-surface-sunken max-w-md">
              <CatTab active={category === 'all'} onClick={() => setCategory('all')}>全部</CatTab>
              {CATEGORIES.map(c => (
                <CatTab key={c.id} active={category === c.id} onClick={() => setCategory(c.id)} icon={c.icon}>{c.label}</CatTab>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered.map(t => <TemplateCard key={t.id} t={t} selected={selected?.id === t.id} onSelect={() => setSelected(t)} />)}
            </div>
          </>
        )}

        {step === 2 && selected && (
          <div className="max-w-2xl mx-auto">
            {/* v0.9 同样用 inline style 渲染 hero banner —— 与 TemplateCard 一致，
                避免 Tailwind JIT 扫不到动态 gradient class 导致的黑底回退。 */}
            <div className="p-4 mb-4 rounded-xl relative overflow-hidden" style={resolveTemplateColor(selected.gradient)}>
              <div className="relative z-10">
                <div className="flex items-center gap-3 mb-2">
                  <span className="material-symbols-outlined text-white text-[24px]">{selected.icon}</span>
                  <div>
                    <div className="text-[14px] font-bold text-white">{selected.name}</div>
                    <div className="text-[11px] text-white/80">{selected.tagline}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {selected.members.map(m => (
                    <span key={m.roleId} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/20 text-white text-[10.5px] font-semibold backdrop-blur-sm">
                      <span>{m.emoji}</span>{m.role}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="space-y-4">
              {renderHealthItems(healthItems)}
              <Field label="房间名称" hint="留空则用模板默认名">
                <input value={title} onChange={e => setTitle(e.target.value)} placeholder={selected.name} className="w-full h-9 px-3 rounded-lg bg-surface-raised border border-border sci-input text-[13px]" />
              </Field>
              <Field label="开场白" hint="可留空，房间会直接激活等你发言">
                <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} placeholder={selected.initialPromptHint || '简单描述一下场景或问题...'} className="w-full px-3 py-2 rounded-lg bg-surface-raised border border-border sci-input text-[13px] resize-none" />
              </Field>
              <BudgetField value={budget} onChange={setBudget} />
              {/* v0.8 冲突驱动：建房时就能定调。默认跟随模板的 preset（'' = 走 preset）。
                  辩论/评审类模板 preset 已内置合理默认，用户通常不用改；
                  但聊类模板想"开一次硬辩论"时在这里一选即可，避免进房后再找调参入口。 */}
              <ConflictModeField
                value={conflictMode}
                onChange={setConflictMode}
                // 模板没有显式 presetId，靠 defaultPolicy 推断 preset 默认：
                //   debate policy → 'debate' preset（硬对抗）
                //   其它 policy → 不暗示，让用户按需选（'' = 跟 preset / 不注入）
                presetHint={selected.defaultPolicy === 'debate' ? 'debate' : undefined}
              />

              {/* v0.4：高级 · 覆盖每个角色的 agent / thinking */}
              <div className="rounded-xl border border-border bg-surface-raised overflow-hidden">
                <button
                  onClick={() => setAdvancedOpen(o => !o)}
                  className="w-full px-3 py-2 flex items-center justify-between text-start hover:bg-surface-sunken/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[16px] text-text-secondary">tune</span>
                    <span className="text-[12.5px] font-semibold text-text">高级 · 为每个角色指定 OpenClaw agent / 思考强度</span>
                    {overrideCount > 0 && (
                      <span className="inline-flex items-center px-1.5 h-4 rounded-full bg-cyan-500/15 text-cyan-500 text-[10px] font-bold">
                        已覆盖 {overrideCount}
                      </span>
                    )}
                  </div>
                  <span className={`material-symbols-outlined text-[18px] text-text-muted transition-transform ${advancedOpen ? 'rotate-180' : ''}`}>expand_more</span>
                </button>
                {advancedOpen && (
                  <div className="px-3 pb-3 pt-0 space-y-2 border-t border-border">
                    {gatewayReady === false && (
                      <div className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] bg-warning/15 text-warning">
                        <span className="material-symbols-outlined text-[14px]">cloud_off</span>
                        Gateway 未连接 · 可先保存覆盖，连接成功后生效
                      </div>
                    )}
                    {/* v0.4：房间级辅助模型（aux）—— 覆盖全局默认，保持短输出任务省钱 */}
                    <div className="mt-2 rounded-lg border border-border bg-surface px-2.5 py-2">
                      <div className="flex items-center justify-between mb-1">
                        <div>
                          <div className="text-[11.5px] font-semibold text-text">辅助模型（aux）</div>
                          <div className="text-[10.5px] text-text-muted">竞言 / 纪要 / extract-todo 等内部调用用这个</div>
                        </div>
                        <span className="text-[10px] text-text-muted font-mono">auxModel</span>
                      </div>
                      <CustomSelect
                        value={auxModel}
                        onChange={setAuxModel}
                        options={[
                          { value: '', label: '跟随全局默认' },
                          ...systemModels.map(m => ({ value: m.id, label: m.label || m.id })),
                        ]}
                        placeholder={systemModels.length === 0 ? '无可用模型，请检查网关' : '跟随全局默认'}
                        className="h-7 px-2 rounded-md text-[11.5px] bg-surface-raised border border-border"
                      />
                    </div>
                    <p className="text-[11px] text-text-muted mt-2 mb-1">留空则使用模板默认（通常是 OpenClaw 的 default agent）。</p>
                    {selected.members.map(m => {
                      const ov = overrides[m.roleId] || {};
                      const patch = (p: Partial<{ agentId: string; thinking: string }>) => {
                        setOverrides(prev => ({ ...prev, [m.roleId]: { ...prev[m.roleId], ...p } }));
                      };
                      return (
                        <div key={m.roleId} className="grid grid-cols-[auto_1fr_1fr] items-center gap-2 py-1.5">
                          <div className="flex items-center gap-1.5 min-w-0 pe-2">
                            <span className="text-[15px]">{m.emoji}</span>
                            <span className="text-[12px] font-semibold text-text truncate">{m.role}</span>
                            {m.isModerator && <span className="material-symbols-outlined text-[13px] text-purple-500" title="主持人">record_voice_over</span>}
                          </div>
                          <CustomSelect
                            value={ov.agentId || ''}
                            onChange={(v) => patch({ agentId: v })}
                            options={[
                              { value: '', label: '默认 agent' },
                              ...gatewayAgents.map(a => ({
                                value: a.id,
                                label: (a.name || a.id) + (a.model ? ` · ${a.model}` : ''),
                              })),
                            ]}
                            className="h-8 px-2 rounded-lg bg-surface border border-border text-[11.5px] min-w-0"
                          />
                          <CustomSelect
                            value={ov.thinking || ''}
                            onChange={(v) => patch({ thinking: v })}
                            options={[
                              { value: '', label: '思考强度（默认）' },
                              { value: 'off', label: '关闭' },
                              { value: 'low', label: '低' },
                              { value: 'medium', label: '中' },
                              { value: 'high', label: '高' },
                            ]}
                            className="h-8 px-2 rounded-lg bg-surface border border-border text-[11.5px] min-w-0"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      <WizardFooter
        backLabel={step === 1 ? '返回' : '上一步'}
        onBack={() => step === 1 ? onBack() : setStep(1)}
        primaryLabel={step === 1 ? '下一步' : (submitting ? '创建中…' : '启动房间')}
        primaryIcon={step === 1 ? 'arrow_forward' : 'rocket_launch'}
        primaryDisabled={!selected || submitting}
        primaryLoading={submitting}
        onPrimary={() => (step === 1 ? setStep(2) : submit())}
      />
    </>
  );
};

// ─────────────────────────── Custom path (5 steps) ───────────────────────────

interface CustomState {
  title: string;
  goal: string;
  roundBudget: number;           // v0.9：会议节奏硬闸（0 = 无上限）
  collaborationStyle: string;    // v0.9：房间级协作风格，注入每轮 system prompt
  members: CustomMemberSpec[];
  policy: RoomPolicy;
  budget: number;
  prompt: string;
  // v0.8 冲突驱动模式：'' = 不注入（保留系统默认）。直接提升到 top-level state，
  // 方便 step 5 评审界面头尾捷径。
  conflictMode: '' | 'review' | 'debate';
}

const CUSTOM_STARTER: CustomState = {
  title: '',
  goal: '',
  roundBudget: 12,               // 默认标准节奏 12 轮
  collaborationStyle: '',        // 默认不注入
  members: [
    { role: '提议者', emoji: '💡', model: '', systemPrompt: '大胆提出新想法，保持简洁。' },
    { role: '批评者', emoji: '🛡️', model: '', systemPrompt: '挑毛病、找漏洞、提反驳，但要具体。' },
  ],
  policy: 'free',
  budget: 10,
  prompt: '',
  conflictMode: '',
};

function buildMembersFromInviteRoles(inviteRoles: string[]): CustomMemberSpec[] {
  const trimmed = inviteRoles.map(r => r.trim()).filter(Boolean);
  if (trimmed.length === 0) return CUSTOM_STARTER.members;
  return trimmed.map((role, idx) => ({
    role,
    emoji: SUGGESTED_EMOJIS[idx % SUGGESTED_EMOJIS.length] || '🤖',
    model: '',
    systemPrompt: idx === 0 ? '主持讨论、澄清目标、推进收敛。' : '围绕议题给出具体观点、追问与建议。',
  }));
}

const CustomPath: React.FC<{ onCreate: (r: CreateRequest) => void | Promise<void>; onCancel: () => void; onBack: () => void; initialDraft?: NextMeetingDraft }> = ({ onCreate, onCancel, onBack, initialDraft }) => {
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [state, setState] = useState<CustomState>(CUSTOM_STARTER);
  // v0.4：自定义路径的成员 model 下拉也改走真实配置（同 RoomSettingsModal）。
  const [systemModels, setSystemModels] = useState<SystemModel[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchSystemModels(false).then(m => { if (!cancelled) setSystemModels(m); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const update = <K extends keyof CustomState>(k: K, v: CustomState[K]) => setState(prev => ({ ...prev, [k]: v }));

  useEffect(() => {
    if (!initialDraft) return;
    setState(s => ({
      ...s,
      title: initialDraft.title || s.title,
      goal: initialDraft.goal || initialDraft.agendaItems.join('；') || s.goal,
      prompt: initialDraft.goal || initialDraft.agendaItems.join('\n') || s.prompt,
      members: initialDraft.inviteRoles.length > 0 ? buildMembersFromInviteRoles(initialDraft.inviteRoles) : s.members,
    }));
  }, [initialDraft]);

  // v0.8 角色去重：后端不强制 unique role，但重复角色在 orchestrator.filterAgentMembers
  // 里无法区分"提议者 #1 vs 提议者 #2"（@mention / 日志里会歧义）。这里做 UI 层硬约束，
  // 大小写/前后空白折叠后判断。返回冲突的 role 名集合；空 set = 合法。
  const duplicateRoles = useMemo(() => {
    const seen = new Map<string, number>();
    const dup = new Set<string>();
    for (const m of state.members) {
      const k = m.role.trim().toLowerCase();
      if (!k) continue;
      const c = (seen.get(k) || 0) + 1;
      seen.set(k, c);
      if (c > 1) dup.add(k);
    }
    return dup;
  }, [state.members]);

  const canNext = () => {
    if (step === 1) return state.title.trim().length > 0;
    if (step === 2) return state.members.length > 0
      && state.members.every(m => m.role.trim().length > 0)
      && duplicateRoles.size === 0;
    return true;
  };

  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    if (submitting) return; // 双击守护
    setSubmitting(true);
    try {
      await onCreate({
        kind: 'custom',
        title: state.title.trim(),
        goal: state.goal.trim() || undefined,
        members: state.members,
        policy: state.policy,
        budgetCNY: state.budget,
        initialPrompt: state.prompt.trim() || undefined,
        conflictMode: state.conflictMode || undefined,
        roundBudget: state.roundBudget > 0 ? state.roundBudget : undefined,
        collaborationStyle: state.collaborationStyle.trim() || undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <WizardHeader
        icon="construction"
        gradient="from-purple-500 to-fuchsia-500"
        title="自己搭建一个房间"
        subtitle={['目标与名称', '成员阵容', '氛围与节奏', '发言策略', '预算与总览'][step - 1]}
        onBack={onBack}
        onCancel={onCancel}
        stepLabel={`${step} / 5`}
      />

      {/* Stepper */}
      <div className="shrink-0 px-5 py-2 border-b border-border bg-surface-sunken/30">
        <div className="flex items-center gap-1.5 max-w-2xl mx-auto">
          {['目标', '成员', '氛围', '策略', '预算'].map((label, i) => {
            const s = (i + 1) as 1 | 2 | 3 | 4 | 5;
            const active = step === s;
            const done = step > s;
            return (
              <React.Fragment key={s}>
                <button
                  onClick={() => s <= step && setStep(s)}
                  className={`flex items-center gap-1.5 h-7 px-2 rounded-md transition-all ${active ? 'bg-purple-500/15 text-purple-600 dark:text-purple-400 ring-1 ring-purple-400/40' : done ? 'text-text-secondary hover:bg-surface-raised' : 'text-text-muted cursor-default'}`}
                >
                  <span className={`w-4 h-4 rounded-full text-[10px] font-bold flex items-center justify-center ${active ? 'bg-purple-500 text-white' : done ? 'bg-surface-raised text-text-secondary' : 'bg-surface-sunken text-text-disabled'}`}>
                    {done ? '✓' : s}
                  </span>
                  <span className="text-[11.5px] font-semibold">{label}</span>
                </button>
                {i < 4 && <div className={`flex-1 h-px ${done ? 'bg-purple-400/40' : 'bg-border'}`} />}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto neon-scrollbar p-5">
        {step === 1 && <Step1Goal state={state} update={update} />}
        {step === 2 && <Step2Members state={state} update={update} systemModels={systemModels} />}
        {step === 3 && <Step3Vibe state={state} update={update} />}
        {step === 4 && <Step4Policy state={state} update={update} />}
        {step === 5 && <Step5Review state={state} update={update} />}
      </div>

      <WizardFooter
        backLabel={step === 1 ? '返回' : '上一步'}
        onBack={() => step === 1 ? onBack() : setStep((step - 1) as 1 | 2 | 3 | 4)}
        primaryLabel={step === 5 ? (submitting ? '创建中…' : '启动房间') : '下一步'}
        primaryIcon={step === 5 ? 'rocket_launch' : 'arrow_forward'}
        primaryDisabled={!canNext() || submitting}
        primaryLoading={submitting && step === 5}
        onPrimary={() => (step === 5 ? submit() : setStep((step + 1) as 2 | 3 | 4 | 5))}
      />
    </>
  );
};

// ── Step 1: Goal ──

const Step1Goal: React.FC<{
  state: CustomState;
  update: <K extends keyof CustomState>(k: K, v: CustomState[K]) => void;
}> = ({ state, update }) => {
  // v0.7 Playbook 推荐 —— 用户在目标里打字时实时匹配经验库。
  // debounce 400ms，避免每次 keystroke 都打一次后端。
  const [recs, setRecs] = useState<PlaybookV7[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const goal = state.goal.trim();
    if (!goal || goal.length < 4) {
      setRecs([]);
      return;
    }
    const t = window.setTimeout(() => {
      recommendPlaybooks(goal).then(setRecs).catch(() => setRecs([]));
    }, 400);
    return () => window.clearTimeout(t);
  }, [state.goal]);

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div className="text-center mb-2">
        <div className="inline-flex w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-500 to-fuchsia-500 items-center justify-center shadow-[0_8px_24px_rgba(139,92,246,0.3)] mb-3">
          <span className="material-symbols-outlined text-white text-[28px]">flag</span>
        </div>
        <h3 className="text-[15px] font-bold text-text">这个房间要解决什么？</h3>
        <p className="text-[12px] text-text-secondary mt-1">先给团队一个清晰的名字和目标</p>
      </div>
      <Field label="房间名称 *" hint='像给群聊起名那样，例如 "周报脑暴" / "上线事故复盘"'>
        <input value={state.title} onChange={e => update('title', e.target.value)} placeholder="给这场会议起个名..." className="w-full h-10 px-3 rounded-lg bg-surface-raised border border-border sci-input text-[13px]" autoFocus />
      </Field>
      <Field label="目标（可选）" hint="把它写进房间记忆，所有 Agent 都看得到">
        <textarea value={state.goal} onChange={e => update('goal', e.target.value)} rows={3} placeholder="例如：2 小时内产出 3 个候选方案，每个都有可行性、风险、工期评估..." className="w-full px-3 py-2 rounded-lg bg-surface-raised border border-border sci-input text-[13px] resize-none" />
      </Field>

      {recs.length > 0 && (
        <div className="rounded-xl border border-indigo-500/30 bg-gradient-to-br from-indigo-500/[0.08] via-purple-500/[0.04] to-transparent overflow-hidden animate-card-enter">
          <button type="button" onClick={() => setExpanded(v => !v)}
            className="w-full px-3 py-2.5 flex items-center gap-2 text-left hover:bg-indigo-500/[0.04] transition">
            <span className="material-symbols-outlined text-[20px] text-indigo-500 shrink-0">menu_book</span>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold text-text">
                检测到 {recs.length} 个相关经验可复用
              </div>
              <div className="text-[11px] text-text-muted">
                创建房间后，可在顶栏「经验库」里一键应用到当前对话
              </div>
            </div>
            <span className="material-symbols-outlined text-[18px] text-text-muted shrink-0">
              {expanded ? 'expand_less' : 'expand_more'}
            </span>
          </button>
          {expanded && (
            <ul className="px-3 pb-3 space-y-1.5">
              {recs.slice(0, 5).map(p => (
                <li key={p.id}
                  className="flex items-start gap-2 px-2 py-1.5 rounded-md bg-surface border border-border hover:bg-surface-sunken transition">
                  <span className="material-symbols-outlined text-[14px] text-indigo-500 mt-0.5 shrink-0">auto_stories</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[12px] font-semibold text-text truncate">{p.title}</span>
                      {p.isFavorite && <span className="material-symbols-outlined text-[12px] text-amber-500">star</span>}
                      {p.usageCount > 0 && (
                        <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-300">× {p.usageCount}</span>
                      )}
                    </div>
                    {p.problem && (
                      <div className="text-[11px] text-text-secondary line-clamp-1">{p.problem}</div>
                    )}
                    {p.tags.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {p.tags.slice(0, 3).map(t => (
                          <span key={t} className="px-1.5 py-[1px] rounded-full text-[10px] bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-500/20">#{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              ))}
              {recs.length > 5 && (
                <li className="text-[10.5px] text-text-muted text-center">还有 {recs.length - 5} 条…</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

// ── Step 2: Members ──

const Step2Members: React.FC<{ state: CustomState; update: <K extends keyof CustomState>(k: K, v: CustomState[K]) => void; systemModels: SystemModel[] }> = ({ state, update, systemModels }) => {
  // v0.4：从 OpenClaw Gateway 拉取 agents.list，给每个成员选可绑定的 agent 实例。
  // 拉取失败（gateway 离线）则下拉只有 "default"，房间仍可创建但运行时会报"网关未就绪"。
  const [gatewayAgents, setGatewayAgents] = useState<GatewayAgentInfo[]>([]);
  const [gatewayReady, setGatewayReady] = useState<boolean | null>(null); // null = probing
  const [roleProfiles, setRoleProfiles] = useState<RoleProfile[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listGatewayAgents(), getGatewayStatus(), listRoleProfiles().catch(() => [])]).then(([list, st, roles]) => {
      if (cancelled) return;
      setGatewayAgents(list);
      setGatewayReady(!!st.available);
      setRoleProfiles(roles);
    });
    return () => { cancelled = true; };
  }, []);

  // v0.9.2：统一入口——所有角色必须从角色库选择或新建。
  // "新建角色"打开 RoleEditorModal，保存后自动加入成员列表。
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorDraft, setEditorDraft] = useState<Partial<RoleProfile>>({ name: '', role: '', visibility: 'private' });
  const [editorSaving, setEditorSaving] = useState(false);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of roleProfiles) if (p.category) set.add(p.category);
    return Array.from(set).sort();
  }, [roleProfiles]);

  const openNewRoleEditor = () => {
    setEditorDraft({ name: '', role: '', visibility: 'private' });
    setEditorOpen(true);
  };

  const saveNewRole = async () => {
    if (!String(editorDraft.name || '').trim() || !String(editorDraft.role || '').trim()) return;
    setEditorSaving(true);
    try {
      const saved = await createRoleProfile(editorDraft);
      setRoleProfiles(prev => [saved, ...prev]);
      // 保存后自动加入成员列表
      update('members', [...state.members, {
        role: saved.role || saved.name,
        roleProfileId: saved.id,
        emoji: saved.emoji || '🤖',
        model: saved.model || '',
        isModerator: !!saved.isModerator,
        systemPrompt: saved.systemPrompt || '',
        agentId: saved.agentId || '',
        thinking: saved.thinking || '',
      }]);
      setEditorOpen(false);
    } finally { setEditorSaving(false); }
  };

  const remove = (i: number) => update('members', state.members.filter((_, idx) => idx !== i));
  const patch = (i: number, p: Partial<CustomMemberSpec>) => {
    update('members', state.members.map((m, idx) => idx === i ? { ...m, ...p } : m));
  };
  const addFromRoleProfile = (profileId: string) => {
    const profile = roleProfiles.find((item) => item.id === profileId);
    if (!profile) return;
    update('members', [...state.members, {
      role: profile.role || profile.name,
      roleProfileId: profile.id,
      emoji: profile.emoji || '🤖',
      model: profile.model || '',
      isModerator: !!profile.isModerator,
      systemPrompt: profile.systemPrompt || '',
      agentId: profile.agentId || '',
      thinking: profile.thinking || '',
    }]);
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-4">
        <h3 className="text-[15px] font-bold text-text">加入成员</h3>
        <p className="text-[12px] text-text-secondary mt-1">
          最少 1 个，推荐 3–5 个。Agent 太多会互相打断而且烧钱。
        </p>
        {gatewayReady === false && (
          <div className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] bg-warning/15 text-warning">
            <span className="material-symbols-outlined text-[14px]">cloud_off</span>
            OpenClaw Gateway 未连接 · 房间可创建但 agent 暂时不会发言
          </div>
        )}
      </div>
      <div className="mb-3 rounded-xl border border-border bg-surface-raised p-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="material-symbols-outlined text-[16px] text-purple-500">collections_bookmark</span>
          <span className="text-[12px] font-semibold text-text">从角色库快速加人</span>
          <span className="ms-auto text-[10.5px] text-text-muted">{roleProfiles.length} 个角色</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <CustomSelect
              value=""
              onChange={(v) => {
                if (v) addFromRoleProfile(v);
              }}
              options={[
                { value: '', label: roleProfiles.length > 0 ? '选择一个角色库角色…' : '暂无角色库角色' },
                ...roleProfiles.map((profile) => ({
                  value: profile.id,
                  label: `${profile.emoji || '🤖'} ${profile.role || profile.name}${profile.category ? ` · ${profile.category}` : ''}`,
                })),
              ]}
              className="h-9 w-full px-2 rounded-lg bg-surface border border-border text-[12px]"
            />
          </div>
          <button
            onClick={openNewRoleEditor}
            disabled={state.members.length >= 8}
            className="shrink-0 h-9 px-3 rounded-lg border border-border bg-surface hover:bg-purple-500/10 hover:border-purple-400/50 hover:text-purple-500 text-text-secondary text-[11.5px] font-semibold inline-flex items-center gap-1.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            title="新建角色并加入"
          >
            <span className="material-symbols-outlined text-[15px]">person_add</span>
            新建角色
          </button>
        </div>
      </div>
      <div className="space-y-3">
        {state.members.map((m, i) => {
          // v0.8 角色重复检测：同 trim+lowercase 出现 ≥2 次 → 所有同名行标红。
          const dupKey = m.role.trim().toLowerCase();
          const dupCount = dupKey ? state.members.reduce((c, x) => c + (x.role.trim().toLowerCase() === dupKey ? 1 : 0), 0) : 0;
          return (
            <MemberRow
              key={i}
              member={m}
              index={i}
              onPatch={p => patch(i, p)}
              onRemove={() => remove(i)}
              canRemove={state.members.length > 1}
              gatewayAgents={gatewayAgents}
              systemModels={systemModels}
              roleDuplicate={dupCount > 1}
            />
          );
        })}
      </div>
      {state.members.length === 0 && (
        <div className="mt-4 text-center text-[12px] text-text-muted py-6 rounded-xl border-2 border-dashed border-border">
          <span className="material-symbols-outlined text-[24px] opacity-40 block mb-1">group_add</span>
          从上方角色库选择角色，或新建一个
        </div>
      )}
      <RoleEditorModal
        open={editorOpen}
        draft={editorDraft}
        isNew
        isBuiltin={false}
        saving={editorSaving}
        deleting={false}
        onDraftChange={setEditorDraft}
        onSave={saveNewRole}
        onDelete={() => {}}
        onClose={() => setEditorOpen(false)}
        gatewayAgents={gatewayAgents}
        systemModels={systemModels}
        categories={categories}
      />
    </div>
  );
};

const THINKING_LEVELS: Array<{ id: string; label: string }> = [
  { id: '', label: '默认' },
  { id: 'off', label: '关闭' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
];

const MemberRow: React.FC<{
  member: CustomMemberSpec;
  index: number;
  onPatch: (p: Partial<CustomMemberSpec>) => void;
  onRemove: () => void;
  canRemove: boolean;
  gatewayAgents: GatewayAgentInfo[];
  systemModels: SystemModel[];
  /** v0.8 角色名与其他成员重复时为 true，加红框提示。 */
  roleDuplicate?: boolean;
}> = ({ member, index, onPatch, onRemove, canRemove, gatewayAgents, systemModels, roleDuplicate }) => {
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [expanded, setExpanded] = useState(index < 2);

  return (
    <div className="rounded-xl border border-border bg-surface-raised overflow-hidden">
      <div className="flex items-center gap-2 p-2.5">
        <button
          onClick={() => setShowEmojiPicker(p => !p)}
          className="relative w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500/20 to-fuchsia-500/20 hover:from-purple-500/30 hover:to-fuchsia-500/30 flex items-center justify-center text-[22px] shrink-0 transition-all"
          title="更换 emoji"
        >
          {member.emoji || '🤖'}
          {showEmojiPicker && (
            <>
              <div className="fixed inset-0 z-10" onClick={e => { e.stopPropagation(); setShowEmojiPicker(false); }} />
              <div className="absolute top-full start-0 mt-1 p-1.5 rounded-lg bg-surface-overlay backdrop-blur-md border border-border shadow-xl z-20 grid grid-cols-6 gap-0.5 w-56 animate-card-enter">
                {SUGGESTED_EMOJIS.map(e => (
                  <button
                    key={e}
                    onClick={ev => { ev.stopPropagation(); onPatch({ emoji: e }); setShowEmojiPicker(false); }}
                    className="w-8 h-8 rounded-md hover:bg-surface-sunken text-lg flex items-center justify-center"
                  >{e}</button>
                ))}
              </div>
            </>
          )}
        </button>
        <div className="flex-1 min-w-0">
          <input
            value={member.role}
            onChange={e => onPatch({ role: e.target.value })}
            placeholder="角色名（例：产品经理）"
            className={`w-full h-9 px-2.5 rounded-lg bg-surface sci-input text-[12.5px] font-semibold border ${
              roleDuplicate ? 'border-red-500/60 focus:border-red-500' : 'border-border'
            }`}
          />
          {roleDuplicate && (
            <div className="mt-1 text-[10.5px] text-red-500 flex items-center gap-1">
              <span className="material-symbols-outlined text-[12px]">error</span>
              角色名已存在 · @mention / 日志上会歧义，请改为唯一名称
            </div>
          )}
          {member.roleProfileId && (
            <div className="mt-1 text-[10.5px] text-violet-600 dark:text-violet-400 flex items-center gap-1">
              <span className="material-symbols-outlined text-[12px]">bookmark</span>
              来自角色库
            </div>
          )}
        </div>
        <div className="w-[140px] shrink-0">
          <CustomSelect
            value={member.model || ''}
            onChange={(v) => onPatch({ model: v })}
            options={[
              { value: '', label: '（未选模型）' },
              ...systemModels.map(m => ({ value: m.id, label: m.label || m.id })),
            ]}
            placeholder={systemModels.length === 0 ? '无可用模型，请检查网关' : '（未选模型）'}
            className="h-9 px-2 rounded-lg bg-surface border border-border text-[11.5px] font-mono text-text-secondary"
          />
        </div>
        <button
          onClick={() => onPatch({ isModerator: !member.isModerator })}
          title={member.isModerator ? '取消主持人' : '设为主持人'}
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${member.isModerator ? 'bg-purple-500/15 text-purple-500 ring-1 ring-purple-400/40' : 'text-text-muted hover:bg-surface-sunken hover:text-text'}`}
        >
          <span className="material-symbols-outlined text-[18px]">record_voice_over</span>
        </button>
        <button
          onClick={() => setExpanded(p => !p)}
          className="w-9 h-9 rounded-lg flex items-center justify-center text-text-muted hover:bg-surface-sunken hover:text-text"
          title={expanded ? '收起' : '展开'}
        >
          <span className={`material-symbols-outlined text-[18px] transition-transform ${expanded ? 'rotate-180' : ''}`}>expand_more</span>
        </button>
        {canRemove && (
          <button
            onClick={onRemove}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-text-muted hover:bg-red-500/10 hover:text-red-500"
            title="移除"
          >
            <span className="material-symbols-outlined text-[17px]">close</span>
          </button>
        )}
      </div>
      {expanded && (
        <div className="px-2.5 pb-2.5 pt-0 space-y-2">
          {/* v0.4：OpenClaw agent 绑定 + Thinking 级别 */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10.5px] text-text-muted mb-1 block">OpenClaw Agent · 推理后端</label>
              <CustomSelect
                value={member.agentId || ''}
                onChange={(v) => onPatch({ agentId: v })}
                options={[
                  { value: '', label: '默认 agent' },
                  ...gatewayAgents.map(a => ({
                    value: a.id,
                    label: (a.name || a.id) + (a.model ? ` · ${a.model}` : ''),
                  })),
                ]}
                className="w-full h-8 px-2 rounded-lg bg-surface border border-border text-[11.5px]"
              />
            </div>
            <div>
              <label className="text-[10.5px] text-text-muted mb-1 block">Thinking · 思考强度</label>
              <CustomSelect
                value={member.thinking || ''}
                onChange={(v) => onPatch({ thinking: v })}
                options={THINKING_LEVELS.map(t => ({ value: t.id, label: t.label }))}
                className="w-full h-8 px-2 rounded-lg bg-surface border border-border text-[11.5px]"
              />
            </div>
          </div>
          <div>
            <label className="text-[10.5px] text-text-muted mb-1 block">系统提示词 · 定义这个 Agent 的性格与职责</label>
            <textarea
              value={member.systemPrompt || ''}
              onChange={e => onPatch({ systemPrompt: e.target.value })}
              rows={2}
              placeholder="例如：你是资深架构师，擅长在 10 秒内识别技术债。语气简洁，只说能落地的点子。"
              className="w-full px-2.5 py-1.5 rounded-lg bg-surface border border-border sci-input text-[11.5px] resize-none font-sans"
            />
          </div>
        </div>
      )}
    </div>
  );
};

// ── Step 3: Vibe & Rhythm ──
// v0.9：把原"工具配置"替换成房间级氛围与节奏三件套。
// 成员工具仍在 Step2 成员卡的高级折叠区里调，这里不重复暴露。
//   · 对抗烈度（conflictMode）— 3 档，决定 AI 是否敢挑战不是礼貌点头
//   · 会议节奏（roundBudget）— 轮次硬闸，防止会议跑太久烧预算
//   · 协作风格（collaborationStyle）— 一句话注入每轮 system prompt

const CONFLICT_OPTIONS: Array<{ id: '' | 'review' | 'debate'; icon: string; label: string; desc: string; tone: string }> = [
  { id: '', icon: 'handshake', label: '协作', desc: '默认。成员互相支持、补位、发散。适合脑暴、闲聊、创意。', tone: 'from-emerald-500/15 to-teal-500/10 ring-emerald-400/40 text-emerald-600 dark:text-emerald-300' },
  { id: 'review', icon: 'search_check', label: '评审挑战', desc: '允许部分同意，但每轮必须带新视角或新风险。评审/复盘/方案讨论首选。', tone: 'from-amber-500/15 to-orange-500/10 ring-amber-400/40 text-amber-600 dark:text-amber-300' },
  { id: 'debate', icon: 'bolt', label: '硬对抗', desc: '必须带具体反驳 / 证据 / 新论点，禁止点头式同意。高风险决策、质询、辩论。', tone: 'from-rose-500/15 to-red-500/10 ring-rose-400/40 text-rose-600 dark:text-rose-300' },
];

const RHYTHM_PRESETS: Array<{ id: number; icon: string; label: string; hint: string }> = [
  { id: 6, icon: 'bolt', label: '快速', hint: '6 轮内收尾' },
  { id: 12, icon: 'timer', label: '标准', hint: '12 轮，推荐' },
  { id: 20, icon: 'psychology', label: '深入', hint: '20 轮，复杂议题' },
  { id: 0, icon: 'all_inclusive', label: '自由', hint: '不限轮次' },
];

const STYLE_PRESETS: Array<{ label: string; text: string }> = [
  { label: '简洁中文', text: '发言简洁，中文为主，每条不超过 80 字。避免客套话。' },
  { label: '数据驱动', text: '重要判断必须带数据或引用来源，避免空泛的主观断言。' },
  { label: '工程口吻', text: '像资深工程师 code review 那样说话：直接、具体、给修改建议不只是指出问题。' },
  { label: '先结论后理由', text: '每条发言先给结论（一句话），再列支撑理由。不要铺垫。' },
];

const Step3Vibe: React.FC<{ state: CustomState; update: <K extends keyof CustomState>(k: K, v: CustomState[K]) => void }> = ({ state, update }) => {
  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div className="text-center mb-1">
        <div className="inline-flex w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-500 to-fuchsia-500 items-center justify-center shadow-[0_8px_24px_rgba(139,92,246,0.3)] mb-3">
          <span className="material-symbols-outlined text-white text-[28px]">graphic_eq</span>
        </div>
        <h3 className="text-[15px] font-bold text-text">定调：这场会什么氛围？</h3>
        <p className="text-[12px] text-text-secondary mt-1">三个决定会议体感的房间级开关。都可以进房后再调。</p>
      </div>

      {/* 对抗烈度 */}
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <label className="text-[12.5px] font-semibold text-text">对抗烈度</label>
          <span className="text-[11px] text-text-muted">解决 "AI 礼貌点头" 问题</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {CONFLICT_OPTIONS.map(opt => {
            const selected = state.conflictMode === opt.id;
            return (
              <button
                key={opt.id || 'off'}
                onClick={() => update('conflictMode', opt.id)}
                className={`relative p-3 rounded-xl text-start transition-all ${selected
                  ? `bg-gradient-to-br ${opt.tone} ring-2 shadow-[0_6px_18px_rgba(139,92,246,0.15)]`
                  : 'ring-1 ring-border hover:ring-purple-400/40 hover:bg-surface-sunken'}`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span className={`material-symbols-outlined text-[18px] ${selected ? '' : 'text-text-muted'}`}>{opt.icon}</span>
                  <span className="text-[12.5px] font-bold text-text">{opt.label}</span>
                  {selected && <span className="ms-auto material-symbols-outlined text-[16px] text-purple-500">check_circle</span>}
                </div>
                <p className="text-[11px] text-text-secondary leading-relaxed">{opt.desc}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* 会议节奏 */}
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <label className="text-[12.5px] font-semibold text-text">会议节奏</label>
          <span className="text-[11px] text-text-muted">轮次硬闸，防止跑太久烧预算</span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {RHYTHM_PRESETS.map(p => {
            const selected = state.roundBudget === p.id;
            return (
              <button
                key={p.id}
                onClick={() => update('roundBudget', p.id)}
                className={`p-2.5 rounded-xl text-center transition-all ${selected
                  ? 'bg-purple-500/15 ring-2 ring-purple-400/60 shadow-[0_4px_12px_rgba(139,92,246,0.2)]'
                  : 'ring-1 ring-border hover:ring-purple-400/40 hover:bg-surface-sunken'}`}
              >
                <span className={`material-symbols-outlined text-[22px] ${selected ? 'text-purple-500' : 'text-text-muted'}`}>{p.icon}</span>
                <div className="text-[12px] font-bold text-text mt-0.5">{p.label}</div>
                <div className="text-[10px] text-text-muted mt-0.5">{p.hint}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 协作风格 */}
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <label className="text-[12.5px] font-semibold text-text">协作风格（可选）</label>
          <span className="text-[11px] text-text-muted">一句话注入每轮 system prompt</span>
        </div>
        <textarea
          value={state.collaborationStyle}
          onChange={e => update('collaborationStyle', e.target.value)}
          rows={2}
          placeholder="例：发言简洁，中文为主，每条不超过 80 字。避免客套话。"
          className="w-full px-3 py-2 rounded-lg bg-surface-raised border border-border sci-input text-[13px] resize-none"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="text-[10.5px] text-text-muted self-center me-1">一键套用：</span>
          {STYLE_PRESETS.map(p => (
            <button
              key={p.label}
              onClick={() => update('collaborationStyle', p.text)}
              className="px-2 h-6 rounded-md text-[10.5px] font-semibold bg-surface border border-border text-text-secondary hover:bg-purple-500/10 hover:border-purple-400/40 hover:text-purple-600 dark:hover:text-purple-300 transition"
              type="button"
            >
              {p.label}
            </button>
          ))}
          {state.collaborationStyle && (
            <button
              onClick={() => update('collaborationStyle', '')}
              className="px-2 h-6 rounded-md text-[10.5px] font-semibold bg-surface border border-border text-text-muted hover:text-rose-500 transition"
              type="button"
            >
              清空
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Step 4: Policy ──

const POLICY_LIST: RoomPolicy[] = ['free', 'reactive', 'roundRobin', 'moderator', 'bidding', 'parallel', 'debate', 'planned'];
const POLICY_DESC: Record<RoomPolicy, string> = {
  free: '谁有话说谁说。对话最自然，可能抢麦。',
  reactive: 'Agent 只在被 @ 或直接点名时回应。安静、可控。',
  roundRobin: '按顺序一人说一句。最节省 token，不会漏人。',
  moderator: '主持人决定下一位发言者。严肃讨论首选。',
  bidding: 'Agent 先投"想说的程度"分，得分最高者发言。最贴近真会议。',
  observer: '所有 Agent 静默。只有人类发言。用于记录/演示。',
  planned: '先讨论、再按计划排序执行、末尾人工 review。适合多步任务分工协作。',
  parallel: '一次触发 → 多位 Agent 并行独立回复，彼此看不见本轮输出。头脑风暴 / 多方案并行评估首选。',
  debate: '成员分正方 / 反方 / 中立三方，按立场轮转 pro → con → pro …。方案评审 / 风险质询 / 决策对抗首选。',
};

const Step4Policy: React.FC<{ state: CustomState; update: <K extends keyof CustomState>(k: K, v: CustomState[K]) => void }> = ({ state, update }) => {
  const hasModerator = state.members.some(m => m.isModerator);
  return (
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-4">
        <h3 className="text-[15px] font-bold text-text">发言策略</h3>
        <p className="text-[12px] text-text-secondary mt-1">决定 Agent 之间怎么"抢话筒"。随时可切换。</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {POLICY_LIST.map(p => {
          const meta = POLICY_META[p];
          const selected = state.policy === p;
          const disabled = p === 'moderator' && !hasModerator;
          return (
            <button
              key={p}
              onClick={() => !disabled && update('policy', p)}
              disabled={disabled}
              className={`relative p-3 rounded-xl text-start transition-all ${selected ? 'bg-gradient-to-br from-purple-500/10 to-fuchsia-500/10 ring-2 ring-purple-400/60 shadow-[0_8px_24px_rgba(139,92,246,0.2)]' : disabled ? 'ring-1 ring-border opacity-50 cursor-not-allowed' : 'ring-1 ring-border hover:ring-purple-400/40 hover:bg-surface-sunken'}`}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`material-symbols-outlined text-[20px] ${meta.color}`}>{meta.icon}</span>
                <span className="text-[13px] font-bold text-text">{meta.label}</span>
                {selected && <span className="ms-auto material-symbols-outlined text-[18px] text-purple-500">check_circle</span>}
              </div>
              <p className="text-[11.5px] text-text-secondary leading-relaxed">{POLICY_DESC[p]}</p>
              {disabled && <div className="mt-1.5 text-[10.5px] text-amber-600 dark:text-amber-400">⚠ 需要至少一名主持人</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
};

// ── Step 5: Review + budget + initial prompt ──

const Step5Review: React.FC<{ state: CustomState; update: <K extends keyof CustomState>(k: K, v: CustomState[K]) => void }> = ({ state, update }) => {
  const meta = POLICY_META[state.policy];
  const reviewHealthItems = useMemo<HealthItem[]>(() => {
    const items: HealthItem[] = [];
    items.push(state.members.length >= 2
      ? { level: 'good', text: `当前有 ${state.members.length} 位成员，足够形成真实讨论` }
      : { level: 'warn', text: '成员太少，建议至少保留 2 位不同角色，否则会议感会很弱' });
    items.push(state.prompt.trim()
      ? { level: 'good', text: '已提供开场白，团队进入房间后会更快对齐上下文' }
      : { level: 'warn', text: '还没写开场白。建议至少补一句任务背景，减少第一轮互相试探' });
    items.push(state.budget >= 8
      ? { level: 'good', text: `预算 ¥${state.budget} 适合完成多轮讨论与关闭仪式` }
      : { level: 'warn', text: `预算 ¥${state.budget} 偏紧，复杂策略或多人协作下更容易提前撞预算` });
    items.push(state.policy === 'debate' || state.conflictMode === 'debate'
      ? { level: 'good', text: '已开启更强对抗性，适合做评审、质询和立场碰撞' }
      : { level: 'good', text: '当前策略偏协作型，适合脑暴、分工和温和推进' });
    return items;
  }, [state.members.length, state.prompt, state.budget, state.policy, state.conflictMode]);
  return (
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-4">
        <h3 className="text-[15px] font-bold text-text">最后一步：预算与开场白</h3>
      </div>
      <div className="p-4 mb-4 rounded-xl bg-gradient-to-br from-purple-500/10 via-fuchsia-500/10 to-cyan-500/5 border border-purple-400/30">
        <div className="text-[14px] font-bold text-text mb-0.5">{state.title || '（未命名）'}</div>
        {state.goal && <div className="text-[11px] text-text-secondary mb-2 line-clamp-2">🎯 {state.goal}</div>}
        <div className="flex flex-wrap gap-1.5 mb-2">
          {state.members.map((m, i) => (
            <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface text-[10.5px] font-semibold text-text">
              <span>{m.emoji}</span>
              {m.role}
              {m.isModerator && <span className="text-[8px] text-purple-500">MOD</span>}
            </span>
          ))}
        </div>
        <div className="inline-flex items-center gap-1 text-[11px] text-text-secondary">
          <span className={`material-symbols-outlined text-[13px] ${meta.color}`}>{meta.icon}</span>
          <span className="font-semibold">{meta.label}</span>
        </div>
      </div>
      <div className="space-y-4">
        {renderHealthItems(reviewHealthItems)}
        <Field label="开场白（可选）" hint="房间第一条消息。留空则等你进去再说">
          <textarea value={state.prompt} onChange={e => update('prompt', e.target.value)} rows={3} placeholder="简单描述一下要讨论什么..." className="w-full px-3 py-2 rounded-lg bg-surface-raised border border-border sci-input text-[13px] resize-none" />
        </Field>
        <BudgetField value={state.budget} onChange={v => update('budget', v)} />
        {/* v0.9：冲突驱动已移到 Step3 "氛围与节奏" 做一次性定调，此处不再重复暴露。 */}
      </div>
    </div>
  );
};

// ─────────────────────────── Shared pieces ───────────────────────────

const WizardHeader: React.FC<{
  icon: string;
  gradient: string;
  title: string;
  subtitle: string;
  stepLabel?: string;
  onBack: () => void;
  onCancel: () => void;
}> = ({ icon, gradient, title, subtitle, stepLabel, onBack, onCancel }) => (
  <div className="shrink-0 px-5 py-4 border-b border-border flex items-center gap-3 bg-gradient-to-r from-cyan-500/5 via-blue-500/5 to-purple-500/5">
    <button onClick={onBack} className="w-8 h-8 rounded-md hover:bg-surface-sunken flex items-center justify-center text-text-secondary" title="返回">
      <span className="material-symbols-outlined text-[18px]">arrow_back</span>
    </button>
    <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center shadow-[0_4px_12px_rgba(0,200,255,0.3)]`}>
      <span className="material-symbols-outlined text-white text-[22px]">{icon}</span>
    </div>
    <div className="flex-1 min-w-0">
      <h2 className="text-[15px] font-bold text-text truncate">{title}</h2>
      <p className="text-[11px] text-text-secondary truncate">{subtitle}</p>
    </div>
    {stepLabel && <span className="text-[11px] font-mono font-bold text-text-muted px-2 py-1 rounded bg-surface-sunken">{stepLabel}</span>}
    <button onClick={onCancel} className="w-8 h-8 rounded-md hover:bg-surface-sunken flex items-center justify-center text-text-secondary" title="关闭">
      <span className="material-symbols-outlined text-[18px]">close</span>
    </button>
  </div>
);

// v0.9：移除底部“取消”按钮 — 右上角 X 已经承担了关闭向导的职责，
// 底部双出口反而让用户迟疑“两个按钮在哪里点”。
const WizardFooter: React.FC<{
  backLabel: string;
  onBack: () => void;
  primaryLabel: string;
  primaryIcon: string;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  onPrimary: () => void;
}> = ({ backLabel, onBack, primaryLabel, primaryIcon, primaryDisabled, primaryLoading, onPrimary }) => (
  <div className="shrink-0 flex items-center gap-2 px-5 py-3 border-t border-border bg-surface-sunken/40">
    <button onClick={onBack} className="inline-flex items-center gap-1 px-3 h-9 rounded-lg text-[12px] font-semibold bg-surface hover:bg-surface-raised border border-border">
      <span className="material-symbols-outlined text-[15px]">arrow_back</span>
      {backLabel}
    </button>
    <div className="flex-1" />
    <button
      onClick={onPrimary}
      disabled={primaryDisabled}
      className={`inline-flex items-center gap-1 px-4 h-9 rounded-lg text-[12px] font-bold transition-all ${primaryDisabled
        ? 'bg-surface-sunken text-text-muted cursor-not-allowed'
        : 'bg-gradient-to-r from-cyan-500 to-blue-500 text-white shadow-[0_2px_8px_rgba(0,200,255,0.3)] hover:shadow-[0_4px_16px_rgba(0,200,255,0.5)]'}`}
    >
      {primaryLabel}
      {primaryLoading ? (
        <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
      ) : (
        <span className="material-symbols-outlined text-[16px]">{primaryIcon}</span>
      )}
    </button>
  </div>
);

const TemplateCard: React.FC<{ t: RoomTemplate; selected?: boolean; onSelect: () => void }> = ({ t, selected, onSelect }) => (
  <button
    onClick={onSelect}
    className={`group relative rounded-xl overflow-hidden text-start transition-all ${selected
      ? 'ring-2 ring-cyan-400 shadow-[0_8px_24px_rgba(0,200,255,0.25)] scale-[1.01]'
      : 'ring-1 ring-border hover:ring-cyan-400/40 hover:shadow-lg'}`}
  >
    {/* v0.9 修复：模板 gradient 是后端 JSON 动态类名（如 "from-violet-400 via-purple-500 to-fuchsia-500"），
        Tailwind 4.x JIT 扫不到这些运行时字符串，导致故事接龙/研究小组/危机作战室等卡片渲染为黑底。
        改用 resolveTemplateColor() 把 class string 转成 inline CSS linear-gradient，一劳永逸。 */}
    <div className="relative h-24 p-3 flex items-start gap-2" style={resolveTemplateColor(t.gradient)}>
      <span className="material-symbols-outlined text-white text-[28px] drop-shadow-sm">{t.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-bold text-white truncate">{t.name}</div>
        <div className="text-[10.5px] text-white/85 leading-snug mt-0.5 line-clamp-2">{t.tagline}</div>
      </div>
      {selected && (
        <span className="absolute top-2 end-2 w-5 h-5 rounded-full bg-white flex items-center justify-center shadow">
          <span className="material-symbols-outlined text-[14px] text-cyan-500">check</span>
        </span>
      )}
    </div>
    {/* v0.8：卡片底部 meta 区——移除虚构星标 + 预算成本，改为角色数 + 沟通类型 + 投影能力。
        沟通类型用 POLICY_META 的中文label，让用户一眼看懂这是"辩论/轮流/反应"哪一种。
        v0.9.1：投影能力徽章（"可投影"）随投影 UI 下架一并隐藏。template 的 supportsProjection
        字段保留不动，等恢复后直接再展示即可。 */}
    <div className="p-2 bg-surface flex items-center gap-1.5 text-[10.5px] text-text-muted flex-wrap">
      <span className="inline-flex items-center gap-0.5">
        <span className="material-symbols-outlined text-[12px]">group</span>
        {t.memberCount}
      </span>
      <span className="opacity-40">·</span>
      {(() => {
        const pm = POLICY_META[t.defaultPolicy];
        return (
          <span className={`inline-flex items-center gap-0.5 ${pm?.color || 'text-text-secondary'}`} title={pm?.label ? `沟通类型：${pm.label}` : undefined}>
            <span className="material-symbols-outlined text-[12px]">{pm?.icon || 'forum'}</span>
            {pm?.label || t.defaultPolicy}
          </span>
        );
      })()}
      {/* v0.9.1：投影徽章暂时隐藏（投影 UI 下架）。 */}
    </div>
  </button>
);

const CatTab: React.FC<{ active?: boolean; onClick: () => void; icon?: string; children: React.ReactNode }> = ({ active, onClick, icon, children }) => (
  <button
    onClick={onClick}
    className={`inline-flex items-center gap-1 px-2.5 h-7 rounded-md text-[11.5px] font-semibold transition-all ${active ? 'bg-surface shadow-sm text-text' : 'text-text-secondary hover:text-text'}`}
  >
    {icon && <span className="material-symbols-outlined text-[13px]">{icon}</span>}
    {children}
  </button>
);

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div>
    <label className="flex items-center gap-2 mb-1 text-[12px] font-semibold text-text">
      {label}
      {hint && <span className="text-text-muted font-normal text-[10.5px]">{hint}</span>}
    </label>
    {children}
  </div>
);

const BudgetField: React.FC<{ value: number; onChange: (v: number) => void }> = ({ value, onChange }) => (
  <Field label="预算上限（¥）" hint="到达自动暂停，随时可调">
    <div className="flex items-center gap-3">
      <input type="range" min={1} max={100} step={1} value={value} onChange={e => onChange(Number(e.target.value))} className="flex-1 accent-cyan-500" />
      <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-surface-raised border border-border font-mono tabular-nums text-[13px] font-bold text-text min-w-[80px] justify-center">
        ¥{value}
      </span>
    </div>
    <div className="flex gap-1.5 mt-2">
      {[3, 10, 25, 50].map(v => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`px-2 h-6 rounded-md text-[11px] font-semibold transition-all ${value === v ? 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border border-cyan-500/30' : 'bg-surface hover:bg-surface-raised border border-border text-text-secondary'}`}
        >
          ¥{v}
        </button>
      ))}
    </div>
  </Field>
);

// ConflictModeField —— 建房时选冲突驱动模式。
//
// 三选分段按钮，和 BudgetField 的"快速金额" chip 一个视觉语言，直接选中就落 state。
// 默认空 = 跟随 preset：
//   - 后端 ConflictMode 字段为空时走 preset 的默认值（debate preset → debate）。
// presetHint（可选）让 UI 明示"跟模板"这档其实等于 debate/review，减少"选默认还是选对抗"的困惑。
const ConflictModeField: React.FC<{
  value: '' | 'review' | 'debate';
  onChange: (v: '' | 'review' | 'debate') => void;
  /** 'debate' / 'deep' 等 —— 模板 preset id，用于提示"跟模板 = xxx"。 */
  presetHint?: string;
}> = ({ value, onChange, presetHint }) => {
  const presetDefault = presetHint === 'debate' ? 'debate' : presetHint === 'deep' ? 'review' : '';
  const options: { key: '' | 'review' | 'debate'; label: string; icon: string; hint: string }[] = [
    { key: '', label: '跟模板', icon: 'auto_awesome', hint: presetDefault === 'debate' ? '≈ 硬对抗' : presetDefault === 'review' ? '≈ 评审挑战' : '走 preset 默认' },
    { key: 'review', label: '评审挑战', icon: 'rate_review', hint: '允许部分同意，每轮必带新视角/风险' },
    { key: 'debate', label: '硬对抗', icon: 'swords', hint: '必须带反驳+证据，禁止点头' },
  ];
  return (
    <Field label="冲突驱动模式" hint="对抗 AI 礼貌点头型会议。随时可在房间调参改。">
      <div className="grid grid-cols-3 gap-1.5">
        {options.map(o => {
          const active = value === o.key;
          return (
            <button
              key={o.key || 'default'}
              type="button"
              onClick={() => onChange(o.key)}
              title={o.hint}
              className={[
                'px-2 h-9 rounded-md border text-[11.5px] font-semibold inline-flex items-center justify-center gap-1 transition-all',
                active
                  ? (o.key === 'debate' ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/40'
                    : o.key === 'review' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40'
                    : 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/40')
                  : 'bg-surface-raised hover:bg-surface-sunken border-border text-text-secondary',
              ].join(' ')}
            >
              <span className="material-symbols-outlined text-[14px]">{o.icon}</span>
              <span>{o.label}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-1 text-[11px] text-text-muted">
        {options.find(o => o.key === value)?.hint}
      </div>
    </Field>
  );
};

// ─────────────────────────── Role Library View ───────────────────────────
// 嵌入在「召集你的 AI 团队」向导里的角色库管理视图。
// 角色列表采用卡片网格；编辑 / 新建弹出独立浮窗（RoleEditorModal）。

const RoleLibraryView: React.FC<{ onBack: () => void; onCancel: () => void }> = ({ onBack, onCancel }) => {
  const { confirm } = useConfirm();
  const [profiles, setProfiles] = useState<RoleProfile[]>([]);
  const [activeId, setActiveId] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<RoleProfile>>({ name: '', role: '', visibility: 'private' });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [gatewayAgents, setGatewayAgents] = useState<GatewayAgentInfo[]>([]);
  const [systemModels, setSystemModels] = useState<SystemModel[]>([]);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      listRoleProfiles().catch(() => [] as RoleProfile[]),
      listGatewayAgents().catch(() => [] as GatewayAgentInfo[]),
      fetchSystemModels(false).catch(() => [] as SystemModel[]),
    ]).then(([roles, agents, models]) => {
      setProfiles(roles);
      setGatewayAgents(agents);
      setSystemModels(models);
      setLoading(false);
    });
  }, []);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of profiles) if (p.category) set.add(p.category);
    return Array.from(set).sort();
  }, [profiles]);

  const openEditor = (id: string) => {
    const cur = id ? profiles.find(p => p.id === id) : undefined;
    setActiveId(id);
    setDraft(cur ? { ...cur } : { name: '', role: '', visibility: 'private' });
    setEditorOpen(true);
  };

  const saveRole = async () => {
    if (!String(draft.name || '').trim() || !String(draft.role || '').trim()) return;
    setSaving(true);
    try {
      let saved: RoleProfile;
      if (activeId) {
        saved = await updateRoleProfile(activeId, draft);
        setProfiles(prev => prev.map(p => p.id === saved.id ? saved : p));
      } else {
        saved = await createRoleProfile(draft);
        setProfiles(prev => [saved, ...prev]);
        setActiveId(saved.id);
      }
      setDraft(saved);
      setEditorOpen(false);
    } finally { setSaving(false); }
  };

  const removeRole = async () => {
    if (!activeId || deleting) return;
    const cur = profiles.find(p => p.id === activeId);
    if (!cur || cur.builtin) return;
    const ok = await confirm({ title: '删除角色', message: `永久删除「${cur.role || cur.name}」？此操作不可撤销。`, confirmText: '删除', danger: true });
    if (!ok) return;
    setDeleting(true);
    try {
      await deleteRoleProfile(activeId);
      setProfiles(prev => prev.filter(p => p.id !== activeId));
      setActiveId('');
      setEditorOpen(false);
    } finally { setDeleting(false); }
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return profiles;
    const q = search.toLowerCase();
    return profiles.filter(p =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.role || '').toLowerCase().includes(q) ||
      (p.category || '').toLowerCase().includes(q),
    );
  }, [profiles, search]);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(p => p.id)));
    }
  };

  // ── 导出：选中的角色序列化为 JSON 文件下载 ──
  const exportRoles = () => {
    const toExport = selected.size > 0
      ? profiles.filter(p => selected.has(p.id))
      : profiles;
    if (toExport.length === 0) return;
    const exportable = toExport.map(({ id, ownerUserId, createdAt, updatedAt, ...rest }) => rest);
    const blob = new Blob([JSON.stringify(exportable, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `role-library-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setSelected(new Set());
    setSelectMode(false);
  };

  // ── 导入：从 JSON 文件读取角色列表，逐个创建 ──
  const [importing, setImporting] = useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // 重置 input 以允许重复选择同一文件
    e.target.value = '';
    try {
      const text = await file.text();
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) throw new Error('not array');
      const valid = arr.filter((item: any) => item && typeof item.name === 'string' && typeof item.role === 'string');
      if (valid.length === 0) { alert('文件中未找到有效的角色数据'); return; }
      const ok = await confirm({
        title: '导入角色',
        message: `将从文件中导入 ${valid.length} 个角色模板到角色库。已存在的同名角色不会被覆盖。`,
        confirmText: `导入 ${valid.length} 个`,
      });
      if (!ok) return;
      setImporting(true);
      const created: RoleProfile[] = [];
      for (const item of valid) {
        try {
          const { id, ownerUserId, createdAt, updatedAt, builtin, ...rest } = item;
          const saved = await createRoleProfile(rest);
          created.push(saved);
        } catch { /* skip duplicates or errors */ }
      }
      if (created.length > 0) {
        setProfiles(prev => [...created, ...prev]);
      }
      alert(`成功导入 ${created.length} / ${valid.length} 个角色`);
    } catch {
      alert('文件解析失败，请确认为有效的角色库 JSON 文件');
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      {/* Header */}
      <div className="shrink-0 px-5 py-4 border-b border-border flex items-center gap-3 bg-gradient-to-r from-fuchsia-500/5 via-violet-500/5 to-purple-500/5">
        <button onClick={onBack} className="w-8 h-8 rounded-md hover:bg-surface-sunken flex items-center justify-center text-text-secondary">
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
        </button>
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-fuchsia-500 to-violet-500 flex items-center justify-center shadow">
          <span className="material-symbols-outlined text-white text-[22px]">badge</span>
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-bold text-text">角色库</h2>
          <p className="text-[11px] text-text-secondary">维护可复用的角色模板 — 创建房间时可一键选用</p>
        </div>
        <button onClick={onCancel} className="w-8 h-8 rounded-md hover:bg-surface-sunken flex items-center justify-center text-text-secondary">
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto neon-scrollbar p-5 space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-text-muted text-[12px]">
            <span className="w-4 h-4 rounded-full border-2 border-violet-400 border-t-transparent animate-spin me-2" />加载中…
          </div>
        ) : (
          <>
            {/* Intro for new users */}
            <div className="rounded-xl border border-fuchsia-500/20 bg-gradient-to-br from-fuchsia-500/5 via-violet-500/5 to-surface p-3">
              <div className="flex items-start gap-2.5">
                <span className="material-symbols-outlined text-[18px] text-fuchsia-500 mt-0.5 shrink-0">lightbulb</span>
                <div className="text-[11px] text-text-secondary leading-relaxed">
                  <span className="font-semibold text-fuchsia-600 dark:text-fuchsia-400">角色模板</span> 是可复用的 AI 身份配置。
                  每个角色包含系统提示词、立场、模型绑定等信息。
                  创建房间时，选择模板或自己搭建都可以从角色库快速选人入会。
                  <span className="block mt-1 text-text-muted">点击角色卡片可编辑，或点右上角「新建角色」创建新模板。</span>
                </div>
              </div>
            </div>

            {/* Toolbar: search + import/export + new */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1 min-w-0">
                <span className="material-symbols-outlined text-[16px] text-text-muted absolute start-2.5 top-1/2 -translate-y-1/2 pointer-events-none">search</span>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder={`搜索 ${profiles.length} 个角色…`} className="w-full h-8 ps-8 pe-3 rounded-lg bg-surface-raised border border-border sci-input text-[11.5px]" />
              </div>
              <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={handleImport} />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={importing}
                title="从 JSON 文件导入角色"
                className="inline-flex items-center gap-1 px-2.5 h-8 rounded-lg text-[11px] font-semibold border border-border hover:bg-surface-raised text-text-secondary transition-colors shrink-0 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[14px]">upload</span>
                {importing ? '导入中…' : '导入'}
              </button>
              <button
                onClick={() => { if (selectMode) { setSelectMode(false); setSelected(new Set()); } else { setSelectMode(true); } }}
                disabled={profiles.length === 0}
                title={selectMode ? '退出选择模式' : '选择角色后导出'}
                className={`inline-flex items-center gap-1 px-2.5 h-8 rounded-lg text-[11px] font-semibold border transition-colors shrink-0 disabled:opacity-50 ${selectMode ? 'border-violet-500/50 bg-violet-500/10 text-violet-600 dark:text-violet-400' : 'border-border hover:bg-surface-raised text-text-secondary'}`}
              >
                <span className="material-symbols-outlined text-[14px]">download</span>
                {selectMode ? '取消选择' : '导出'}
              </button>
              <button onClick={() => openEditor('')} className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-[11px] font-semibold bg-violet-500 hover:bg-violet-600 text-white shrink-0">
                <span className="material-symbols-outlined text-[14px]">add</span>新建角色
              </button>
            </div>

            {/* Select mode bar */}
            {selectMode && filtered.length > 0 && (
              <div className="flex items-center gap-3 rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2">
                <button onClick={toggleSelectAll} className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-violet-600 dark:text-violet-400 hover:underline">
                  <span className="material-symbols-outlined text-[14px]">{selected.size === filtered.length ? 'deselect' : 'select_all'}</span>
                  {selected.size === filtered.length ? '取消全选' : '全选'}
                </button>
                <span className="text-[11px] text-text-muted">已选 {selected.size} / {filtered.length}</span>
                <div className="flex-1" />
                <button
                  onClick={exportRoles}
                  disabled={selected.size === 0}
                  className="inline-flex items-center gap-1.5 px-3 h-7 rounded-md text-[11px] font-semibold bg-violet-500 hover:bg-violet-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span className="material-symbols-outlined text-[13px]">download</span>
                  导出 {selected.size > 0 ? `${selected.size} 个` : ''}
                </button>
              </div>
            )}

            {/* Role card grid */}
            {filtered.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-surface-sunken/30 px-4 py-10 text-center">
                <div className="w-12 h-12 mx-auto rounded-2xl bg-violet-500/10 flex items-center justify-center mb-3">
                  <span className="material-symbols-outlined text-[22px] text-violet-500">{search ? 'search_off' : 'person_add'}</span>
                </div>
                <div className="text-[12px] font-semibold text-text">{search ? '没有匹配的角色' : '角色库为空'}</div>
                <div className="text-[10.5px] text-text-muted mt-1">{search ? '尝试其他关键词' : '点击上方「新建角色」创建第一个模板'}</div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {filtered.map(p => (
                  <button
                    key={p.id}
                    onClick={() => selectMode ? toggleSelect(p.id) : openEditor(p.id)}
                    className={`group text-start px-3 py-2.5 rounded-xl border transition-all ${selectMode && selected.has(p.id) ? 'border-violet-500 bg-violet-500/10 ring-1 ring-violet-500/30' : 'border-border hover:border-violet-500/40 hover:shadow-[0_4px_16px_rgba(139,92,246,0.12)] bg-surface-raised/60 hover:bg-surface-raised'}`}
                  >
                    <div className="flex items-start gap-2.5 min-w-0">
                      {selectMode ? (
                        <span className={`w-5 h-5 mt-0.5 shrink-0 rounded border-2 flex items-center justify-center transition-colors ${selected.has(p.id) ? 'border-violet-500 bg-violet-500' : 'border-border bg-surface-raised'}`}>
                          {selected.has(p.id) && <span className="material-symbols-outlined text-white text-[14px]">check</span>}
                        </span>
                      ) : (
                        <span className="text-[20px] mt-0.5 shrink-0 group-hover:scale-110 transition-transform">{p.emoji || '🤖'}</span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-semibold text-text truncate">{p.role || p.name}</div>
                        <div className="text-[10px] text-text-muted truncate mt-0.5">{p.name}</div>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          <span className="inline-flex items-center px-1.5 h-4 rounded text-[9px] border border-border bg-surface text-text-muted">{p.category || (p.builtin ? '内置' : '自定义')}</span>
                          {p.stance && <span className="inline-flex items-center px-1.5 h-4 rounded text-[9px] border border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-400">{p.stance}</span>}
                          {p.isModerator && <span className="inline-flex items-center px-1.5 h-4 rounded text-[9px] border border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400">主持人</span>}
                          {p.builtin && <span className="inline-flex items-center px-1.5 h-4 rounded text-[9px] border border-cyan-500/20 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">内置</span>}
                        </div>
                      </div>
                      {!selectMode && <span className="material-symbols-outlined text-[14px] text-text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5">edit</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Editor modal */}
      <RoleEditorModal
        open={editorOpen}
        draft={draft}
        isNew={!activeId}
        isBuiltin={!!profiles.find(p => p.id === activeId)?.builtin}
        saving={saving}
        deleting={deleting}
        onDraftChange={setDraft}
        onSave={saveRole}
        onDelete={removeRole}
        onClose={() => setEditorOpen(false)}
        gatewayAgents={gatewayAgents}
        systemModels={systemModels}
        categories={categories}
      />
    </>
  );
};

export default CreateRoomWizard;
export type { CreateRequest };
