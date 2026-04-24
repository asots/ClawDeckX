// LiveControlsPanel —— 会议控制台（右栏"推进会议"组第一项）
//
// v0.9：把开会过程中最常调的房间级参数（目标 / 对抗烈度 / 发言策略 / 轮次 /
//          协作风格 / 预算 / 红线）聚合到一个面板。安全模式（只读 / 禁工具）使用频率低，
//          放在 RoomTuningModal 里。
//
// **draft + 显式保存** 模式，不是即点即存：
//   · 所有控件写入本地 draft
//   · 标题栏徽章显示"N 项未保存"
//   · 底部[保存][放弃]按钮 —— 一次性 PATCH updateRoom(diff)
//
// 为什么不即点即存？会议跑起来后连续调几个参数是常态，一次性保存让中间不会出现
// 半过渡状态（例如对抗拉满但 style 还是"温柔"）。

import React, { useEffect, useMemo, useState } from 'react';
import type { Room, RoomPolicy, PolicyOptions } from '../types';
import { updateRoom } from '../service';
import NumberStepper from '../../../components/NumberStepper';
// v0.9：POLICY_META 不再使用（发言策略 field 已下沉到 Composer）。

interface Props {
  room: Room;
  // v0.9：原 TopBar 的"经验库 / 设置"动作按钮下沉到 LiveControlsPanel 顶部——
  // 顶栏空间紧张，它们在 LiveControlsPanel 里与对抗烈度/预算等参数是同族关系
  // （都是"调整房间配置"），聚合后用户单点即可看到本房间所有可调开关。
  //
  // v0.9.1：投影按钮已临时下架——OpenClaw 当前没有"channels.deliver"类 RPC 可供直接
  // 向 IM 频道中继消息，而仅实现入站（IM → 房间）对用户价值有限。后端 Projector /
  // ProjectionInbound handler / RoomProjection / projection_in 消息类型保留，等待
  // 上游 OpenClaw 提供原生频道投递能力或产品决策后再打开。
  onOpenPlaybooks?: () => void;
  onOpenSettings?: () => void;
}

interface Draft {
  goal: string;
  policy: RoomPolicy;
  conflictMode: '' | 'review' | 'debate';
  roundBudget: number;
  collaborationStyle: string;
  budgetCNY: number;
  constitution: string;
  // v0.9.1：从 QualityPanel 合并进来。Agent 发言落盘前跑一次 rubric 复检的开关，
  // 属于"提升单轮质量的 opt-in 成本"类配置，和其它热调参数一样统一在此面板维护。
  selfCritique: boolean;
  deadlineAction: '' | 'remind' | 'pause' | 'summarize';
}

function snapshotFromRoom(r: Room): Draft {
  return {
    goal: r.goal ?? '',
    policy: r.policy,
    conflictMode: (r.policyOptions?.conflictMode ?? '') as Draft['conflictMode'],
    roundBudget: r.roundBudget ?? 0,
    collaborationStyle: r.collaborationStyle ?? '',
    // budgetCNY 在 Room 模型里嵌套在 budget.limitCNY（RoomBudget）；
    // 保存时需要 patch 整个 budget 对象（见 save() 里特殊处理）。
    budgetCNY: r.budget?.limitCNY ?? 0,
    constitution: r.constitution ?? '',
    selfCritique: !!r.selfCritique,
    deadlineAction: (r.policyOptions?.deadlineAction ?? '') as Draft['deadlineAction'],
  };
}

function computeDiff(initial: Draft, draft: Draft): Array<keyof Draft> {
  const keys: Array<keyof Draft> = [];
  (Object.keys(initial) as Array<keyof Draft>).forEach(k => {
    if (initial[k] !== draft[k]) keys.push(k);
  });
  return keys;
}

const CONFLICT_PILLS: Array<{ id: Draft['conflictMode']; label: string; icon: string }> = [
  { id: '',       label: '协作',   icon: 'handshake' },
  { id: 'review', label: '评审',   icon: 'search_check' },
  { id: 'debate', label: '硬对抗', icon: 'bolt' },
];

const STYLE_PRESETS: Array<{ label: string; text: string }> = [
  { label: '简洁', text: '发言简洁，中文为主，每条不超过 80 字。避免客套话。' },
  { label: '数据驱动', text: '重要判断必须带数据或引用来源，避免空泛主观断言。' },
  { label: '先结论后理由', text: '每条发言先给结论（一句话），再列支撑理由。' },
];

const DEADLINE_PILLS: Array<{ id: Draft['deadlineAction']; label: string }> = [
  { id: 'remind',    label: '仅提醒' },
  { id: 'pause',     label: '强制暂停' },
  { id: 'summarize', label: '自动总结' },
];

const LiveControlsPanel: React.FC<Props> = ({ room, onOpenPlaybooks, onOpenSettings }) => {
  const initial = useMemo(() => snapshotFromRoom(room), [room]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);

  // room prop 变化（WebSocket 推新值）时重置 baseline + draft。
  // 无条件重置：若用户有未保存改动，server 推来的新值意味着"外部已变更"，
  // 保留 dirty 会让 diff 基于旧值，易出错。
  useEffect(() => {
    setDraft(snapshotFromRoom(room));
  }, [room]);

  const diffKeys = useMemo(() => computeDiff(initial, draft), [initial, draft]);
  const dirty = diffKeys.length > 0;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft(prev => ({ ...prev, [k]: v }));
  };

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const patch: Partial<Room> = {};
      for (const k of diffKeys) {
        if (k === 'conflictMode' || k === 'deadlineAction') {
          // 合并到完整 policyOptions，避免清空其它 tuning 字段。
          patch.policyOptions = {
            ...(room.policyOptions || {}),
            ...(patch.policyOptions || {}),
            conflictMode: draft.conflictMode || undefined,
            deadlineAction: draft.deadlineAction || undefined,
          } as PolicyOptions;
        } else if (k === 'budgetCNY') {
          // budget 在后端以 RoomBudget 整个对象 patch（UpdateRoom handler 只接受 body.budget，
          // 无须级字段 budgetCNY）；保持 usedCNY / tokensUsed / warnAt 不动。
          patch.budget = {
            ...(room.budget || { limitCNY: 0, usedCNY: 0, tokensUsed: 0, warnAt: 0.7, hardStopAt: 1.0 }),
            limitCNY: draft.budgetCNY,
          };
        } else {
          // 其它字段一对一映射到 Room 的同名字段。
          (patch as Record<string, unknown>)[k] = draft[k];
        }
      }
      await updateRoom(room.id, patch);
      // 成功后 WebSocket 会推新 room，effect 同步 baseline。
    } finally {
      setSaving(false);
    }
  };

  const discard = () => setDraft(initial);

  const hasRoomActions = !!(onOpenPlaybooks || onOpenSettings);

  return (
    <div className="space-y-3 text-[11.5px]">
      {/* v0.9：房间级动作按钮从 TopBar 下沉到此处：经验库（Playbooks）/ AI 会议设置。
          放最顶 —— 用户打开 LiveControls 折叠区后第一眼可见；顶栏就此空出三格。
          v0.9.1：投影按钮已下架（见文件顶部注释）。 */}
      {hasRoomActions && (
        <div className="flex items-center gap-1.5 pb-2 border-b border-border/60">
          {onOpenPlaybooks && (
            <button
              onClick={onOpenPlaybooks}
              title="经验库 · Playbooks"
              className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-semibold bg-surface hover:bg-surface-sunken border border-border text-text-secondary transition-all"
            >
              <span className="material-symbols-outlined text-[13px]">menu_book</span>
              <span>经验库</span>
            </button>
          )}
          {onOpenSettings && (
            <button
              onClick={onOpenSettings}
              title="AI 会议设置（辅助模型 / 全局默认）"
              className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-semibold bg-surface hover:bg-surface-sunken border border-border text-text-secondary transition-all"
              aria-label="AI 会议设置"
            >
              <span className="material-symbols-outlined text-[13px]">settings</span>
              <span>设置</span>
            </button>
          )}
        </div>
      )}

      <Field label="目标" icon="flag" hint="一句话注入每轮 system prompt">
        <textarea
          value={draft.goal}
          onChange={e => set('goal', e.target.value)}
          rows={2}
          placeholder="例如：产出 3 个候选方案，每个都有可行性 / 风险 / 工期"
          className="w-full px-2 py-1.5 rounded-md bg-surface border border-border sci-input text-[11.5px] resize-none"
        />
      </Field>

      <Field label="对抗烈度" icon="bolt" hint="决定 AI 是否敢挑战">
        <div className="grid grid-cols-3 gap-1">
          {CONFLICT_PILLS.map(p => {
            const on = draft.conflictMode === p.id;
            return (
              <button
                key={p.id || 'off'}
                onClick={() => set('conflictMode', p.id)}
                className={`inline-flex items-center justify-center gap-1 h-7 rounded-md text-[11px] font-semibold transition ${on
                  ? 'bg-purple-500/15 text-purple-600 dark:text-purple-300 ring-1 ring-purple-400/60'
                  : 'bg-surface hover:bg-surface-sunken border border-border text-text-secondary'}`}
              >
                <span className="material-symbols-outlined text-[13px]">{p.icon}</span>
                {p.label}
              </button>
            );
          })}
        </div>
      </Field>

      {/* v0.9：发言策略 field 已移除 —— 底部 Composer 已有发言策略上拉列表，
          同一参数两处入口容易互相覆盖，留下单一权威来源（Composer）更清晰。
          调参面板只保留"调参"而非"切策略"。 */}

      <Field label="会议节奏" icon="timer" hint={`已用 ${room.roundsUsed ?? 0} 轮 · 上限 ${draft.roundBudget || '∞'}`}>
        <div className="flex items-center gap-1 flex-wrap">
          {/* v0.9.1：数字增减换用 NumberStepper，与 QualityPanel "预期 agent 轮次" 统一样式；
              原 <input type="number"> 的浏览器原生 spinner 视觉不协调。 */}
          <NumberStepper
            value={draft.roundBudget}
            onChange={v => set('roundBudget', Math.max(0, Math.min(200, parseInt(v) || 0)))}
            min={0}
            max={200}
            step={1}
            className="w-24 h-7"
          />
          <span className="text-[10.5px] text-text-muted me-1">轮，0=不限</span>
          <button onClick={() => set('roundBudget', (draft.roundBudget || 0) + 6)} className="h-7 px-2 rounded-md text-[11px] font-semibold bg-surface hover:bg-surface-sunken border border-border text-text-secondary">+6</button>
          <button onClick={() => set('roundBudget', (draft.roundBudget || 0) + 12)} className="h-7 px-2 rounded-md text-[11px] font-semibold bg-surface hover:bg-surface-sunken border border-border text-text-secondary">+12</button>
          <button onClick={() => set('roundBudget', 0)} className="h-7 px-2 rounded-md text-[11px] font-semibold bg-surface hover:bg-surface-sunken border border-border text-text-secondary">∞</button>
        </div>
        {draft.roundBudget > 0 && (
          <div className="flex items-center gap-1 mt-1">
            <span className="text-[10.5px] text-text-muted me-1">到期：</span>
            {DEADLINE_PILLS.map(p => (
              <button
                key={p.id}
                onClick={() => set('deadlineAction', p.id)}
                className={`h-6 px-2 rounded-md text-[10.5px] font-semibold border transition-all inline-flex items-center gap-0.5 ${
                  (draft.deadlineAction || 'remind') === p.id
                    ? 'bg-cyan-500/15 border-cyan-400/40 text-cyan-600 dark:text-cyan-300'
                    : 'bg-surface hover:bg-surface-sunken border-border text-text-secondary'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
      </Field>

      {/* v0.9：预算上移至协作风格之上 —— 用户决策先看"能花多少钱"再调"怎么说话"，
          视觉上也让预算和会议节奏两个"数值型约束"相邻，协作风格/红线两个"文字约束"相邻。 */}
      <Field label="预算 (¥)" icon="payments" hint={`当前上限 ¥${draft.budgetCNY.toFixed(2)}`}>
        <div className="flex items-center gap-1 flex-wrap">
          {/* v0.9.1：同样改用 NumberStepper。step=0.5 保留小数调节能力。 */}
          <NumberStepper
            value={draft.budgetCNY}
            onChange={v => {
              const n = Number(v);
              set('budgetCNY', Number.isFinite(n) && n >= 0 ? n : 0);
            }}
            min={0}
            step={0.5}
            className="w-28 h-7"
          />
          <button onClick={() => set('budgetCNY', draft.budgetCNY + 5)} className="h-7 px-2 rounded-md text-[11px] font-semibold bg-surface hover:bg-surface-sunken border border-border text-text-secondary">+¥5</button>
          <button onClick={() => set('budgetCNY', draft.budgetCNY + 10)} className="h-7 px-2 rounded-md text-[11px] font-semibold bg-surface hover:bg-surface-sunken border border-border text-text-secondary">+¥10</button>
        </div>
      </Field>

      <Field label="协作风格" icon="edit_note" hint="一句话注入每轮 system prompt">
        <textarea
          value={draft.collaborationStyle}
          onChange={e => set('collaborationStyle', e.target.value)}
          rows={2}
          placeholder="例：发言简洁，中文为主，每条不超过 80 字"
          className="w-full px-2 py-1.5 rounded-md bg-surface border border-border sci-input text-[11.5px] resize-none"
        />
        <div className="mt-1 flex flex-wrap gap-1">
          {STYLE_PRESETS.map(p => (
            <button key={p.label} onClick={() => set('collaborationStyle', p.text)} className="h-6 px-1.5 rounded-md text-[10.5px] font-semibold bg-surface hover:bg-purple-500/10 hover:text-purple-600 dark:hover:text-purple-300 border border-border text-text-secondary">{p.label}</button>
          ))}
          {draft.collaborationStyle && (
            <button onClick={() => set('collaborationStyle', '')} className="h-6 px-1.5 rounded-md text-[10.5px] font-semibold bg-surface hover:bg-danger/10 hover:text-danger border border-border text-text-muted">清空</button>
          )}
        </div>
      </Field>

      {/* v0.9：原“安全模式”（只读 / 禁工具）移除 — 话题使用频率低，让
          会议控制台更聚焦在日常热调项。需要时仍可在 RoomTuningModal 里设定。 */}

      <Field label="红线（一行一条）" icon="gavel" hint="硬性约束，AI 必须遵守">
        <textarea
          value={draft.constitution}
          onChange={e => set('constitution', e.target.value)}
          rows={3}
          placeholder={'例：\n不泄露内部预算\n不做医疗 / 法律建议\n代码必须带注释'}
          className="w-full px-2 py-1.5 rounded-md bg-surface border border-border sci-input text-[11.5px] resize-none font-mono"
        />
      </Field>

      {/* v0.9.1：自我批判回合 —— 原 QualityPanel 独立项，现统一到本面板。
          用 Field 容器让视觉与其它 field 对齐；开关放右侧，说明文字作 hint。 */}
      <Field label="自我批判回合" icon="rule" hint="发言前 rubric 复检 · 约 +15% tokens">
        <label className="flex items-start gap-2 px-2 py-1.5 rounded-md border border-border bg-surface cursor-pointer hover:bg-surface-sunken">
          <input
            type="checkbox"
            checked={draft.selfCritique}
            onChange={e => set('selfCritique', e.target.checked)}
            className="mt-0.5 accent-primary"
          />
          <div className="flex-1 min-w-0 text-[10.5px] text-text-muted leading-snug">
            Agent 发言落盘前跑一次轻量 rubric：低质量回合会被重写一次，换来更低胡说八道率。
          </div>
        </label>
      </Field>

      {/* 保存 / 放弃 —— sticky 吸附在 section 底部 */}
      <div className={`sticky bottom-0 -mx-3 px-3 py-2 border-t backdrop-blur-md flex items-center gap-2 transition ${dirty ? 'bg-amber-500/[0.08] border-amber-500/30' : 'bg-surface-overlay/80 border-border'}`}>
        <span className="text-[11px] text-text-secondary flex-1">
          {dirty ? (
            <><span className="font-bold text-amber-600 dark:text-amber-400">{diffKeys.length}</span> 项未保存</>
          ) : (
            <span className="text-text-muted">没有未保存改动</span>
          )}
        </span>
        <button
          onClick={discard}
          disabled={!dirty || saving}
          className="h-7 px-2 rounded-md text-[11px] font-semibold bg-surface hover:bg-surface-sunken border border-border text-text-secondary disabled:opacity-40 disabled:cursor-not-allowed"
        >
          放弃
        </button>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="inline-flex items-center gap-1 h-7 px-3 rounded-md text-[11px] font-bold transition disabled:opacity-40 disabled:cursor-not-allowed bg-gradient-to-r from-cyan-500 to-blue-500 text-white shadow-[0_2px_8px_rgba(0,200,255,0.25)] hover:shadow-[0_4px_12px_rgba(0,200,255,0.4)]"
        >
          {saving ? (
            <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
          ) : (
            <span className="material-symbols-outlined text-[14px]">save</span>
          )}
          保存
        </button>
      </div>
    </div>
  );
};

// ── 小组件 ──

const Field: React.FC<{ label: string; icon: string; hint?: string; children: React.ReactNode }> = ({ label, icon, hint, children }) => (
  <div>
    <div className="flex items-baseline gap-1.5 mb-1">
      <span className="material-symbols-outlined text-[13px] text-cyan-500/80">{icon}</span>
      <span className="text-[11px] font-bold text-text">{label}</span>
      {hint && <span className="text-[10.5px] text-text-muted truncate">· {hint}</span>}
    </div>
    {children}
  </div>
);

export default LiveControlsPanel;
