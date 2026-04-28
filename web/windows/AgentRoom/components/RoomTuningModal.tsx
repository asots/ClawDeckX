// RoomTuningModal —— v0.7+ 房间调参向导
//
// 把后端 agentroom.PolicyOptions + PromptPack 的"全部调参"暴露为 4-tab 向导：
//   1. 预设风格 —— 一键应用 chat / deep / debate / brainstorm / planning
//   2. 发言策略 —— 阈值、连续上限、抢麦开关
//   3. 记忆压缩 —— tail 窗口、要点回顾、token 软/硬顶
//   4. 人设文案 —— 全部 prompt 模板的 textarea 编辑（分组折叠）
//
// 设计要点：
//   - 所有 tab 共享一份 `draft: PolicyOptions`。改动先落到 draft，最终 "保存" 时 PATCH 房间。
//   - 新手路径：只需进 Tab 1 选一张卡，点 "保存"。其它 tab 全是微调。
//   - 所有字段都有"恢复默认"语义：传 undefined / 空串。后端 accessor 自动回退。
//   - textarea 占位符 = 默认模板内容（从 /prompt-defaults 拉），用户一看就知道该写什么。
//   - 保存逻辑：浅合并 room.policyOptions + draft 后 PATCH。后端会整条 JSON 替换。

import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import type { Room, PolicyOptions, PolicyPresetMeta, PromptPack } from '../types';
import { listPresets, getPromptDefaults, updateRoom } from '../service';
import NumberStepper from '../../../components/NumberStepper';
import CustomSelect from '../../../components/CustomSelect';

interface Props {
  room: Room;
  open: boolean;
  onClose: () => void;
  onRoomUpdated?: (patch: Partial<Room>) => void;
}

type TabID = 'preset' | 'policy' | 'context' | 'prompts';

const TABS: { id: TabID; label: string; icon: string; hint: string }[] = [
  { id: 'preset',  label: '预设风格', icon: 'auto_awesome', hint: '一键应用推荐参数' },
  { id: 'policy',  label: '发言策略', icon: 'tune',         hint: '阈值 / 抢麦 / 连续上限' },
  { id: 'context', label: '记忆压缩', icon: 'memory',       hint: 'tail 窗口 / 要点回顾 / token 软顶' },
  { id: 'prompts', label: '人设文案', icon: 'edit_note',    hint: '全部 prompt 模板' },
];

const RoomTuningModal: React.FC<Props> = ({ room, open, onClose, onRoomUpdated }) => {
  const [tab, setTab] = useState<TabID>('preset');
  const [presets, setPresets] = useState<PolicyPresetMeta[]>([]);
  const [defaults, setDefaults] = useState<PromptPack>({});
  const [draft, setDraft] = useState<PolicyOptions>(() => ({ ...(room.policyOptions || {}) }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时：拉 preset 列表 + 默认 prompt pack；重置 draft 到房间当前值。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTab('preset');
    setError(null);
    setDraft({ ...(room.policyOptions || {}) });
    Promise.all([listPresets(), getPromptDefaults()])
      .then(([ps, dp]) => {
        if (cancelled) return;
        setPresets(ps || []);
        setDefaults(dp || {});
      })
      .catch(() => { /* 静默；UI 退化成无 preset 卡 + 空占位符 */ });
    return () => { cancelled = true; };
  }, [open, room.id, room.policyOptions]);

  // draft 是否相对房间当前值有变化
  const dirty = useMemo(() => {
    return JSON.stringify(draft) !== JSON.stringify(room.policyOptions || {});
  }, [draft, room.policyOptions]);

  const applyPreset = useCallback((p: PolicyPresetMeta) => {
    // 应用 preview 字段（覆盖同名），保留用户已有的自定义 prompts / roundRobinOrder。
    setDraft(prev => ({
      ...prev,
      ...p.preview,
      prompts: prev.prompts, // 保留用户的 prompt 覆盖
      roundRobinOrder: prev.roundRobinOrder,
      presetId: p.id,
    }));
  }, []);

  const resetAll = useCallback(() => {
    // 全部恢复默认 = 传空对象；后端 accessor 自动回退。
    setDraft({});
  }, []);

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      // 清理：0 / 空字符串的字段删掉，保持 JSON 精简（便于后端 marshal 紧凑）。
      const clean = sanitize(draft);
      await updateRoom(room.id, { policyOptions: clean });
      onRoomUpdated?.({ policyOptions: clean });
      onClose();
    } catch (e: any) {
      setError(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, draft, room.id, onRoomUpdated, onClose]);

  // ── 导出 / 导入 ──
  const fileRef = useRef<HTMLInputElement>(null);
  const [importConfirm, setImportConfirm] = useState<PolicyOptions | null>(null);

  const exportDraft = useCallback(() => {
    const clean = sanitize(draft);
    const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const slug = room.title?.replace(/[^\w\u4e00-\u9fff]+/g, '_').slice(0, 30) || room.id.slice(0, 8);
    a.download = `policy-${slug}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [draft, room.id, room.title]);

  const handleImportFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setError('文件格式错误：不是有效的 PolicyOptions JSON');
          return;
        }
        setImportConfirm(parsed as PolicyOptions);
      } catch {
        setError('JSON 解析失败');
      }
    };
    reader.readAsText(file);
    // 清空 value 允许重复选同一文件
    e.target.value = '';
  }, []);

  const confirmImport = useCallback(() => {
    if (!importConfirm) return;
    setDraft(importConfirm);
    setImportConfirm(null);
    setError(null);
  }, [importConfirm]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="relative w-[min(92vw,980px)] h-[min(88vh,720px)] bg-surface-raised border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* ── 标题栏 ── */}
        <header className="flex items-center justify-between px-5 py-3 border-b border-border bg-surface">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-violet-500">settings_suggest</span>
            <div>
              <div className="text-[14px] font-bold text-text">房间调参向导</div>
              <div className="text-[11px] text-text-secondary">所有参数都可覆盖；留空 = 用默认值</div>
            </div>
          </div>
          <button
            type="button"
            className="w-7 h-7 rounded-md hover:bg-surface-sunken text-text-secondary hover:text-text transition-colors inline-flex items-center justify-center"
            onClick={onClose}
            aria-label="关闭"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </header>

        {/* ── Tab 栏 ── */}
        <nav className="flex items-center gap-1 px-3 py-2 border-b border-border bg-surface-sunken overflow-x-auto">
          {TABS.map(t => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={[
                  'inline-flex items-center gap-1.5 px-3 h-9 rounded-md text-[12px] font-semibold transition-all shrink-0',
                  active
                    ? 'bg-violet-500/15 text-violet-600 dark:text-violet-400 ring-1 ring-violet-500/40'
                    : 'text-text-secondary hover:text-text hover:bg-surface-raised',
                ].join(' ')}
                title={t.hint}
              >
                <span className="material-symbols-outlined text-[16px]">{t.icon}</span>
                {t.label}
              </button>
            );
          })}
          {draft.presetId && (
            <span className="ms-auto inline-flex items-center gap-1 px-2 h-7 rounded-md text-[11px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
              <span className="material-symbols-outlined text-[14px]">check_circle</span>
              当前 preset：{presets.find(p => p.id === draft.presetId)?.name || draft.presetId}
            </span>
          )}
        </nav>

        {/* ── 内容区 ── */}
        <main className="flex-1 overflow-y-auto neon-scrollbar">
          {tab === 'preset'  && <PresetTab  presets={presets} activeId={draft.presetId} onPick={applyPreset} />}
          {tab === 'policy'  && <PolicyTab  draft={draft} setDraft={setDraft} />}
          {tab === 'context' && <ContextTab draft={draft} setDraft={setDraft} />}
          {tab === 'prompts' && <PromptsTab draft={draft} setDraft={setDraft} defaults={defaults} />}
        </main>

        {/* ── 导入确认弹窗 ── */}
        {importConfirm && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 rounded-xl">
            <div className="w-[340px] bg-surface-raised border border-border rounded-xl shadow-2xl p-5 space-y-4">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[20px] text-amber-500">upload_file</span>
                <div className="text-[13px] font-bold text-text">确认导入？</div>
              </div>
              <div className="text-[12px] text-text-secondary leading-relaxed">
                导入将<strong>替换当前全部调参</strong>（包括发言策略、记忆压缩、人设文案等）。<br />
                如需保留当前配置，请先导出备份。
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setImportConfirm(null)}
                  className="h-8 px-3 rounded-lg text-[12px] bg-surface-raised hover:bg-surface-sunken border border-border text-text transition-colors"
                >取消</button>
                <button
                  type="button"
                  onClick={confirmImport}
                  className="h-8 px-3 rounded-lg text-[12px] font-semibold bg-violet-500 hover:bg-violet-600 text-white transition-colors"
                >确认导入</button>
              </div>
            </div>
          </div>
        )}

        {/* ── 底部工具栏 ── */}
        <footer className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border bg-surface">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={resetAll}
              disabled={saving}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[12px] text-text-secondary hover:text-danger hover:bg-danger/10 transition-colors disabled:opacity-50"
              title="清空所有自定义；全部回到后端默认"
            >
              <span className="material-symbols-outlined text-[16px]">restart_alt</span>
              恢复默认
            </button>
            <span className="w-px h-5 bg-border" />
            <button
              type="button"
              onClick={exportDraft}
              disabled={saving}
              className="inline-flex items-center gap-1 h-9 px-3 rounded-lg text-[12px] text-text-secondary hover:text-info hover:bg-info/10 transition-colors disabled:opacity-50"
              title="把当前调参导出为 JSON 文件"
            >
              <span className="material-symbols-outlined text-[16px]">download</span>
              导出
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={saving}
              className="inline-flex items-center gap-1 h-9 px-3 rounded-lg text-[12px] text-text-secondary hover:text-info hover:bg-info/10 transition-colors disabled:opacity-50"
              title="从 JSON 文件导入调参"
            >
              <span className="material-symbols-outlined text-[16px]">upload</span>
              导入
            </button>
            <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
          </div>
          <div className="flex items-center gap-2">
            {error && <span className="text-[11px] text-danger">{error}</span>}
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="h-9 px-4 rounded-lg text-[12px] font-medium bg-surface-raised hover:bg-surface-sunken border border-border text-text transition-colors disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving}
              className={[
                'h-9 px-4 rounded-lg text-[12px] font-semibold transition-all inline-flex items-center gap-1.5',
                dirty && !saving
                  ? 'bg-violet-500 hover:bg-violet-600 text-white shadow-[0_0_12px_var(--glow-violet)]'
                  : 'bg-surface-sunken text-text-disabled cursor-not-allowed',
              ].join(' ')}
            >
              {saving ? (
                <>
                  <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
                  保存中…
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-[16px]">save</span>
                  {dirty ? '保存到房间' : '已保存'}
                </>
              )}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};

// ── Tab 1：预设风格 ──

const PresetTab: React.FC<{
  presets: PolicyPresetMeta[];
  activeId?: string;
  onPick: (p: PolicyPresetMeta) => void;
}> = ({ presets, activeId, onPick }) => {
  if (presets.length === 0) {
    return <div className="p-6 text-center text-text-secondary text-[13px]">加载预设中…</div>;
  }
  return (
    <div className="p-5 space-y-4">
      <div className="sci-card p-4">
        <div className="text-[13px] font-semibold text-text mb-1">💡 新手从这里开始</div>
        <div className="text-[12px] text-text-secondary leading-relaxed">
          选一张最匹配你的会议场景的卡片，其它 3 个 tab 的参数会自动填好。之后想微调某项就去对应的 tab，
          不想动就直接保存。后端的默认参数是"通用场景"，任何时候可以点左下角「全部恢复默认」回到原点。
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {presets.map(p => {
          const active = activeId === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p)}
              className={[
                'text-start p-4 rounded-xl border transition-all group',
                active
                  ? 'bg-violet-500/10 border-violet-500/60 ring-2 ring-violet-500/40 shadow-[0_0_16px_var(--glow-violet)]'
                  : 'bg-surface-raised border-border hover:border-violet-500/40 hover:bg-surface-sunken',
              ].join(' ')}
            >
              <div className="flex items-start gap-3">
                <div className="text-3xl">{p.emoji}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-[14px] font-bold text-text">{p.name}</div>
                    {active && (
                      <span className="material-symbols-outlined text-[16px] text-violet-500">check_circle</span>
                    )}
                  </div>
                  <div className="text-[11px] text-text-secondary mt-1 leading-relaxed">{p.description}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {previewChips(p.preview).map((c, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[10px] bg-surface-sunken text-text-secondary border border-border font-mono"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

// ── Tab 2：发言策略 ──

const PolicyTab: React.FC<{
  draft: PolicyOptions;
  setDraft: React.Dispatch<React.SetStateAction<PolicyOptions>>;
}> = ({ draft, setDraft }) => {
  const patch = (partial: Partial<PolicyOptions>) =>
    setDraft(prev => ({ ...prev, ...partial }));
  return (
    <div className="p-5 space-y-5">
      <SectionTitle icon="tune" title="阈值 / 数值" hint="留空 = 用默认值；设为 0 也视作默认" />
      <NumberField
        label="bidding 抢麦阈值"
        hint="bidding 策略下得分高于此值才发言。默认 5.0。越低越吵。"
        placeholder="5.0"
        step={0.5} min={0} max={10}
        value={draft.biddingThreshold}
        onChange={v => patch({ biddingThreshold: v })}
      />
      <NumberField
        label="主动抢麦阈值 (interjection)"
        hint="free/moderator/reactive 叠加主动抢麦时的门槛。默认 6.0。建议比 bidding 高。"
        placeholder="6.0"
        step={0.5} min={0} max={10}
        value={draft.interjectionThreshold}
        onChange={v => patch({ interjectionThreshold: v })}
      />
      <NumberField
        label="一次触发最多连续 agent 发言数"
        hint="人类不插话时 agent 最多连续说几次。默认 8。防 agent↔agent 死循环烧钱。"
        placeholder="8"
        step={1} min={1} max={30}
        value={draft.maxConsecutive}
        onChange={v => patch({ maxConsecutive: v })}
      />
      <NumberField
        label="并行策略 fanout 数"
        hint="parallel 策略下一次同时发言的 agent 数。默认 min(3, 活跃数)。"
        placeholder="3"
        step={1} min={1} max={10}
        value={draft.parallelFanout}
        onChange={v => patch({ parallelFanout: v })}
      />
      <NumberField
        label="辩论轮数"
        hint="debate 策略下一次触发对抗几轮。默认 min(4, 活跃数)。"
        placeholder="4"
        step={1} min={1} max={12}
        value={draft.debateRounds}
        onChange={v => patch({ debateRounds: v })}
      />

      <SectionTitle icon="toggle_on" title="功能开关" />
      {/* v0.8 冲突驱动选择器：对抗"AI 礼貌点头型会议"。三档 radio，选项少直接平铺更直观。
          debate preset 默认 'debate'；deep preset 默认 'review'；chat/brainstorm 默认 ''。 */}
      <SelectField
        label="冲突驱动模式 (conflict mode)"
        hint="对抗'AI 礼貌点头型会议'：每轮注入推动词到 agent system prompt 尾部。辩论/评审强烈推荐开启。"
        value={draft.conflictMode ?? ''}
        options={[
          { value: '', label: '关 · 轻量场景' },
          { value: 'review', label: '评审挑战 · 允许部分同意但必带新视角/风险' },
          { value: 'debate', label: '硬对抗 · 必须带具体反驳+新论据' },
        ]}
        onChange={(v) => patch({ conflictMode: (v || '') as '' | 'review' | 'debate' })}
      />
      <ToggleField
        label="允许主动抢麦 (active interjection)"
        hint="free/moderator/reactive 上叠加：人类触发时 agent 先静默打分，超阈值者抢过默认选择。"
        value={!!draft.activeInterjection}
        onChange={v => patch({ activeInterjection: v })}
      />
      <ToggleField
        label="debate 时把 neutral 也轮进对抗"
        hint="默认 false = neutral 只做裁判 / 收尾，不参与 pro↔con 交替。"
        value={!!draft.includeNeutralInDebate}
        onChange={v => patch({ includeNeutralInDebate: v })}
      />
      <ToggleField
        label="reactive 严格模式"
        hint="true = 不被 @ 绝对不发言（连 bidding 后备都不走）。"
        value={!!draft.reactiveMentionOnly}
        onChange={v => patch({ reactiveMentionOnly: v })}
      />

      <SectionTitle icon="dynamic_feed" title="高级动态参数" hint="控制关系张力、惩罚项、响应风格与推进节奏" />
      <SelectField
        label="会议风格 (meeting style)"
        hint="给调度器和系统提示一个全局风格标签，适合后续做场景化微调。"
        value={draft.meetingStyle ?? ''}
        options={[
          { value: '', label: '默认 / 未指定' },
          { value: 'chat', label: 'chat · 轻松讨论' },
          { value: 'review', label: 'review · 评审推进' },
          { value: 'debate', label: 'debate · 对抗辩论' },
          { value: 'brainstorm', label: 'brainstorm · 发散创意' },
          { value: 'planning', label: 'planning · 收敛规划' },
        ]}
        onChange={(v) => patch({ meetingStyle: v || '' })}
      />
      <SelectField
        label="关系模式 (relationship mode)"
        hint="决定成员之间默认更偏协作、评审、指挥还是对抗。"
        value={draft.relationshipMode ?? ''}
        options={[
          { value: '', label: '默认 / 未指定' },
          { value: 'balanced', label: 'balanced · 平衡' },
          { value: 'collaborative', label: 'collaborative · 协作' },
          { value: 'adversarial', label: 'adversarial · 对抗' },
          { value: 'review', label: 'review · 评审' },
          { value: 'command', label: 'command · 指挥链' },
        ]}
        onChange={(v) => patch({ relationshipMode: (v || '') as PolicyOptions['relationshipMode'] })}
      />
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="关系张力"
          hint="越高越容易形成明确立场冲突与挑战。"
          placeholder="0.4"
          step={0.1} min={0} max={1}
          value={draft.relationshipTension}
          onChange={v => patch({ relationshipTension: v })}
        />
        <NumberField
          label="主持人干预强度"
          hint="越高越容易让 moderator 收束讨论。"
          placeholder="0.3"
          step={0.1} min={0} max={1}
          value={draft.moderatorIntervention}
          onChange={v => patch({ moderatorIntervention: v })}
        />
        <NumberField
          label="裁判 / neutral 干预强度"
          hint="越高越容易让 neutral 做总结、裁决、收尾。"
          placeholder="0.3"
          step={0.1} min={0} max={1}
          value={draft.judgeIntervention}
          onChange={v => patch({ judgeIntervention: v })}
        />
        <NumberField
          label="连续发言惩罚"
          hint="惩罚刚说过的人再次被选中，防止霸麦。"
          placeholder="0.8"
          step={0.1} min={0} max={3}
          value={draft.consecutivePenalty}
          onChange={v => patch({ consecutivePenalty: v })}
        />
        <NumberField
          label="重复观点惩罚"
          hint="越高越抑制重复说同一件事。"
          placeholder="0.6"
          step={0.1} min={0} max={3}
          value={draft.repetitionPenalty}
          onChange={v => patch({ repetitionPenalty: v })}
        />
        <NumberField
          label="话题停滞惩罚"
          hint="讨论原地打转时提高换人 / 换角度概率。"
          placeholder="0.7"
          step={0.1} min={0} max={3}
          value={draft.topicStallPenalty}
          onChange={v => patch({ topicStallPenalty: v })}
        />
        <NumberField
          label="话题疲劳阈值"
          hint="超过此阈值后，系统更倾向切换角度或收束。"
          placeholder="0.7"
          step={0.1} min={0} max={1}
          value={draft.topicFatigueThreshold}
          onChange={v => patch({ topicFatigueThreshold: v })}
        />
        <NumberField
          label="接棒偏置"
          hint="越高越倾向让下一位沿着当前话题继续。"
          placeholder="0.5"
          step={0.1} min={-2} max={2}
          value={draft.continuationBias}
          onChange={v => patch({ continuationBias: v })}
        />
        <NumberField
          label="打断偏置"
          hint="越高越容易切断当前链路，转给不同立场的人。"
          placeholder="0.2"
          step={0.1} min={-2} max={2}
          value={draft.interruptionBias}
          onChange={v => patch({ interruptionBias: v })}
        />
        <NumberField
          label="收束偏置"
          hint="越高越偏向结论、行动项、决议。"
          placeholder="0.4"
          step={0.1} min={-2} max={2}
          value={draft.closureBias}
          onChange={v => patch({ closureBias: v })}
        />
        <NumberField
          label="回答长度"
          hint="控制单轮回复篇幅；越高越长。"
          placeholder="0.5"
          step={0.1} min={0} max={1}
          value={draft.responseLength}
          onChange={v => patch({ responseLength: v })}
        />
        <NumberField
          label="直接度"
          hint="越高越少寒暄、越直接给判断。"
          placeholder="0.6"
          step={0.1} min={0} max={1}
          value={draft.directness}
          onChange={v => patch({ directness: v })}
        />
        <NumberField
          label="证据偏置"
          hint="越高越偏向引用事实、依据、数据。"
          placeholder="0.6"
          step={0.1} min={0} max={1}
          value={draft.evidenceBias}
          onChange={v => patch({ evidenceBias: v })}
        />
        <NumberField
          label="新颖度偏置"
          hint="越高越鼓励新观点、新切面。"
          placeholder="0.6"
          step={0.1} min={0} max={1}
          value={draft.noveltyBias}
          onChange={v => patch({ noveltyBias: v })}
        />
      </div>
    </div>
  );
};

// ── Tab 3：记忆压缩 ──

const ContextTab: React.FC<{
  draft: PolicyOptions;
  setDraft: React.Dispatch<React.SetStateAction<PolicyOptions>>;
}> = ({ draft, setDraft }) => {
  const patch = (partial: Partial<PolicyOptions>) =>
    setDraft(prev => ({ ...prev, ...partial }));
  return (
    <div className="p-5 space-y-5">
      <div className="sci-card p-4">
        <div className="text-[13px] font-semibold text-text mb-1">📐 工作原理</div>
        <div className="text-[12px] text-text-secondary leading-relaxed">
          每轮注入 prompt 时先取 <b>最近 tail 条</b> 作为"工作记忆"，再从更早消息里挑"决策 / @我 / 关键人类输入"
          组成 <b>要点回顾</b>。当 base token 较大时 tail 自动缩短。所有数字"0/空 = 用默认"。
        </div>
      </div>

      <SectionTitle icon="memory" title="Tail 窗口（工作记忆）" />
      <NumberField
        label="tail 基准窗口"
        hint="正常情况下 tail 保留几条最近消息。默认 20。"
        placeholder="20"
        step={2} min={4} max={60}
        value={draft.contextTailWindow}
        onChange={v => patch({ contextTailWindow: v })}
      />
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="自适应第一档（T1 token 阈值）"
          hint="base token 超过此值时 tail 缩到 medium。默认 1500。"
          placeholder="1500"
          step={100} min={500} max={5000}
          value={draft.contextBasePromoteT1}
          onChange={v => patch({ contextBasePromoteT1: v })}
        />
        <NumberField
          label="第一档降到"
          hint="第一档时 tail 窗口。默认 12。"
          placeholder="12"
          step={1} min={4} max={30}
          value={draft.contextTailMed}
          onChange={v => patch({ contextTailMed: v })}
        />
        <NumberField
          label="自适应第二档（T2 token 阈值）"
          hint="超过此值 tail 缩到 small。默认 2500。"
          placeholder="2500"
          step={100} min={1000} max={8000}
          value={draft.contextBasePromoteT2}
          onChange={v => patch({ contextBasePromoteT2: v })}
        />
        <NumberField
          label="第二档降到"
          hint="第二档时 tail 窗口。默认 8。"
          placeholder="8"
          step={1} min={4} max={30}
          value={draft.contextTailSmall}
          onChange={v => patch({ contextTailSmall: v })}
        />
      </div>

      <SectionTitle icon="fact_check" title="要点回顾（长程记忆）" />
      <NumberField
        label="要点回顾最大条数"
        hint="从 earlier 挑出的决策 / @我 / 人类关键消息上限。默认 8。"
        placeholder="8"
        step={1} min={0} max={30}
        value={draft.contextHighlightsCap}
        onChange={v => patch({ contextHighlightsCap: v })}
      />
      <NumberField
        label="人类消息「全保留」上限"
        hint="earlier 段人类消息 ≤ 此数时全部保留（早期指令很重要）。默认 3。"
        placeholder="3"
        step={1} min={0} max={20}
        value={draft.contextKeepHumanMaxN}
        onChange={v => patch({ contextKeepHumanMaxN: v })}
      />

      <SectionTitle icon="compress" title="总量硬顶（兜底）" />
      <NumberField
        label="token 软上限"
        hint="整体 prompt token 超过此值 + rune 过多时触发从头截。默认 6000。"
        placeholder="6000"
        step={500} min={2000} max={30000}
        value={draft.contextTokenSoftLimit}
        onChange={v => patch({ contextTokenSoftLimit: v })}
      />
      <NumberField
        label="rune 硬上限"
        hint="触发软顶后，若 rune 数超此值从头截 2000 runes。默认 14000。"
        placeholder="14000"
        step={1000} min={4000} max={60000}
        value={draft.contextRuneHardLimit}
        onChange={v => patch({ contextRuneHardLimit: v })}
      />
    </div>
  );
};

// ── Tab 4：人设文案 ──
//
// 后端 PromptPack 有 51 个字段，按功能分 12 组，常用组默认展开，高级组默认折叠。

type PromptField = { key: keyof PromptPack; label: string; hint: string; vars: string; rows?: number };
type PromptSection = { id: string; title: string; icon: string; collapsed: boolean; fields: PromptField[] };

const PROMPT_SECTIONS: PromptSection[] = [
  {
    id: 'stance', title: '辩论角色', icon: 'swords', collapsed: false,
    fields: [
      { key: 'stancePro',     label: '正方职责', hint: 'debate 策略下 stance=pro 成员的附加段', vars: '（无变量）' },
      { key: 'stanceCon',     label: '反方职责', hint: 'debate 策略下 stance=con 成员的附加段', vars: '（无变量）' },
      { key: 'stanceNeutral', label: '中立职责', hint: 'debate 策略下 stance=neutral 成员的附加段', vars: '（无变量）' },
    ],
  },
  {
    id: 'flow', title: '议程 / 接棒', icon: 'route', collapsed: false,
    fields: [
      { key: 'agendaProtocol',    label: '议程协议块', hint: '有 active 议项时注入的协议说明', vars: '{{.ActiveIdx}} {{.Total}} {{.AgendaTitle}} {{.TargetOutcome}} {{.HasBudget}} {{.RoundBudget}} {{.RoundsUsed}}' },
      { key: 'relayContinuation', label: 'Agent 接棒', hint: '上一 agent 发言后注入，避免"各说各的"', vars: '{{.PrevAgentName}} {{.PrevAgentSnippet}}' },
    ],
  },
  {
    id: 'scoring', title: '评分 / 通知', icon: 'scoreboard', collapsed: false,
    fields: [
      { key: 'biddingScorer',       label: 'Bidding 评分器', hint: '⚠️ 必须产出 JSON {"score":0-10,"reason":"..."}', vars: '{{.MemberName}} {{.MemberRole}}' },
      { key: 'interjectionNotice',  label: '抢麦通知',       hint: '主动抢麦触发时的系统通知', vars: '{{.Name}} {{.Reason}}', rows: 2 },
      { key: 'debateRoundNotice',   label: '辩论每轮提示',   hint: '每轮辩论开始的系统通知', vars: '{{.Round}} {{.TotalRounds}}', rows: 2 },
      { key: 'parallelStartNotice', label: '并行开始提示',   hint: 'parallel fanout 开始的系统通知', vars: '{{.Fanout}}', rows: 2 },
      { key: 'debateEndNotice',     label: '辩论结束提示',   hint: '辩论跑完最后一轮的系统通知', vars: '（无变量）', rows: 2 },
    ],
  },
  {
    id: 'conflict', title: '冲突驱动 (v0.8)', icon: 'flash_on', collapsed: true,
    fields: [
      { key: 'conflictDrive',   label: '硬对抗推动词', hint: 'ConflictMode=debate 时注入 extraSys 尾部', vars: '（无变量）' },
      { key: 'reviewChallenge', label: '评审挑战推动词', hint: 'ConflictMode=review 时注入 extraSys 尾部', vars: '（无变量）' },
    ],
  },
  {
    id: 'capture', title: '结构化捕获 / Soft-tag (v0.9-v1.0)', icon: 'label', collapsed: true,
    fields: [
      { key: 'structuredCapture',  label: '副产物诱导', hint: '让 agent 用 <open_question>/<risk> tag 标注', vars: '（无变量）' },
      { key: 'softTagInstruction', label: 'Soft-tag 指令', hint: '让 agent 在发言末输出 #stance/#novelty 等标签', vars: '（无变量）' },
    ],
  },
  {
    id: 'realism', title: '真实性增强 · 反 AI 味 (v1.0)', icon: 'psychology', collapsed: true,
    fields: [
      { key: 'uncertaintyEncouragement', label: '不确定性鼓励', hint: '鼓励说"我不确定"', vars: '（无变量）', rows: 3 },
      { key: 'partialAgreement',         label: '精细化回应',   hint: '部分同意部分反对', vars: '（无变量）', rows: 3 },
      { key: 'selfCorrection',           label: '自我修正',     hint: '允许中途修正观点', vars: '（无变量）', rows: 3 },
    ],
  },
  {
    id: 'phase', title: '会议节奏 · 阶段提示 (v1.0)', icon: 'timelapse', collapsed: true,
    fields: [
      { key: 'phaseOpening',     label: '开场阶段', hint: '会议前 25% 轮次', vars: '{{.RoundsUsed}} {{.RoundBudget}}', rows: 3 },
      { key: 'phaseDeepDive',    label: '深入阶段', hint: '会议 25-50% 轮次', vars: '{{.RoundsUsed}} {{.RoundBudget}}', rows: 3 },
      { key: 'phaseFatigue',     label: '疲劳阶段', hint: '会议 50-75% 轮次', vars: '{{.RoundsUsed}} {{.RoundBudget}}', rows: 3 },
      { key: 'phaseConvergence', label: '收束阶段', hint: '会议 75%+ 轮次', vars: '{{.RoundsUsed}} {{.RoundBudget}}', rows: 3 },
    ],
  },
  {
    id: 'emotion', title: '情绪连续性 / 沉默 / 盲区 (v1.0)', icon: 'mood', collapsed: true,
    fields: [
      { key: 'emotionSupported',  label: '被支持', hint: '情绪偏正面时的提示', vars: '{{.Supporters}} {{.Challengers}} {{.Label}}', rows: 3 },
      { key: 'emotionChallenged', label: '被挑战', hint: '情绪偏负面时的提示', vars: '{{.Supporters}} {{.Challengers}} {{.Label}}', rows: 3 },
      { key: 'emotionMixed',      label: '混合情绪', hint: '情绪复杂时的提示', vars: '{{.Supporters}} {{.Challengers}} {{.Label}}', rows: 3 },
      { key: 'silenceBuildup',    label: '沉默力学', hint: '沉默积累时鼓励发言', vars: '（无变量）', rows: 2 },
      { key: 'blindSpotSuffix',   label: '知识盲区后缀', hint: '角色知识边界全局后缀', vars: '（无变量）', rows: 2 },
    ],
  },
  {
    id: 'health', title: '会议健康 D1-D8 (v1.0)', icon: 'health_and_safety', collapsed: true,
    fields: [
      { key: 'deadlockIntervention', label: 'D1 僵局干预',   hint: '两人对立僵局时的调解', vars: '{{.NameA}} {{.NameB}}', rows: 3 },
      { key: 'humanForgotten',       label: 'D2 人类被遗忘', hint: '人类久未被回应', vars: '{{.HumanName}} {{.Rounds}}', rows: 3 },
      { key: 'monopolizerWarning',   label: 'D3 篇幅警告',   hint: '发言过长时提醒', vars: '（无变量）', rows: 2 },
      { key: 'escalationCooldown',   label: 'D4 情绪降温',   hint: '连续挑战后降温', vars: '{{.Rounds}}', rows: 3 },
      { key: 'consensusLock',        label: 'D5 共识锁定',   hint: '多人同意时锁定共识', vars: '{{.Count}} {{.Snippet}}', rows: 3 },
      { key: 'commitmentReminder',   label: 'D6 承诺提醒',   hint: '回顾已做承诺', vars: '{{.Names}}', rows: 2 },
      { key: 'metaReflection',       label: 'D7 元反思',     hint: '回顾会议进度', vars: '{{.RoundsUsed}}', rows: 3 },
      { key: 'proposalNotice',       label: 'D8 提议通知',   hint: '有人提出决策时通知', vars: '{{.ProposerName}}', rows: 2 },
    ],
  },
  {
    id: 'collab', title: '协作执行 C1-C7 (v1.0)', icon: 'handshake', collapsed: true,
    fields: [
      { key: 'handoffPrompt',     label: '步骤移交',   hint: 'planned 策略步骤交接', vars: '{{.Step}} {{.Total}} {{.NextName}} {{.PrevSummary}}' },
      { key: 'capabilityCheck',   label: '能力检查',   hint: 'agent 能力自检', vars: '（无变量）', rows: 2 },
      { key: 'collaborationTags', label: '协作标签',   hint: '协作标记提示', vars: '（无变量）', rows: 2 },
      { key: 'parallelSynthesis', label: '并行整合',   hint: 'parallel fanout 后整合指引', vars: '{{.AgentSummaries}}' },
    ],
  },
  {
    id: 'atmosphere', title: '氛围个性化 T1-T6 (v1.0)', icon: 'palette', collapsed: true,
    fields: [
      { key: 'toneDirective',  label: 'T1 语气指令',   hint: '全局语气基调（preset 自动配置）', vars: '（无变量）', rows: 3 },
      { key: 'lengthGuidance', label: 'T2 发言长度',   hint: '引导 agent 控制篇幅', vars: '{{.Phase}} {{.Policy}}', rows: 3 },
      { key: 'creativityBoost', label: 'T3 创意激发',  hint: '讨论保守时注入', vars: '（无变量）', rows: 3 },
      { key: 'groupthinkAlert', label: 'T4 群体思维',  hint: '连续同意时注入批判提醒', vars: '{{.Rounds}}', rows: 3 },
      { key: 'analogyCue',     label: 'T5 类比叙事',   hint: '纯抽象讨论时鼓励举例', vars: '（无变量）', rows: 2 },
      { key: 'topicAnchor',    label: 'T6 话题锚定',   hint: '跑题时拉回主线', vars: '{{.Goal}}', rows: 2 },
    ],
  },
  {
    id: 'realworld', title: '真实世界增强 R1-R6 (v1.0)', icon: 'public', collapsed: true,
    fields: [
      { key: 'breakthroughMomentum', label: 'R1 突破势能',   hint: '新角度出现时鼓励跟进', vars: '{{.AuthorName}} {{.Snippet}}', rows: 3 },
      { key: 'minorityVoice',        label: 'R2 少数派保护', hint: '1人反对多人时保护声音', vars: '{{.MinorityName}}', rows: 3 },
      { key: 'assumptionChallenge',   label: 'R3 假设追踪',  hint: '大量未验证假设时提醒', vars: '{{.Count}}', rows: 3 },
      { key: 'decisionGate',          label: 'R4 决策质量门', hint: '提议前缺少前置条件时', vars: '{{.MissingItems}}', rows: 3 },
      { key: 'urgencyMild',           label: 'R5 紧迫 · 中度', hint: '75%+ 预算消耗时', vars: '{{.RoundsUsed}} {{.RoundBudget}} {{.Remaining}}', rows: 3 },
      { key: 'urgencyCritical',       label: 'R5 紧迫 · 高度', hint: '90%+ 预算消耗时', vars: '{{.RoundsUsed}} {{.RoundBudget}} {{.Remaining}}', rows: 3 },
      { key: 'echoWarning',           label: 'R6 复读警告',   hint: '检测到复读他人时提醒', vars: '{{.SpeakerName}} {{.EchoedName}}', rows: 2 },
    ],
  },
];

const PromptsTab: React.FC<{
  draft: PolicyOptions;
  setDraft: React.Dispatch<React.SetStateAction<PolicyOptions>>;
  defaults: PromptPack;
}> = ({ draft, setDraft, defaults }) => {
  const prompts = draft.prompts || {};
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const s of PROMPT_SECTIONS) init[s.id] = s.collapsed;
    return init;
  });
  const toggle = (id: string) => setCollapsed(prev => ({ ...prev, [id]: !prev[id] }));

  const patchPrompt = (key: keyof PromptPack, value: string | undefined) => {
    setDraft(prev => {
      const nextPrompts: PromptPack = { ...(prev.prompts || {}) };
      if (value === undefined || value === '') {
        delete nextPrompts[key];
      } else {
        nextPrompts[key] = value;
      }
      const hasAny = Object.values(nextPrompts).some(v => typeof v === 'string' && v.length > 0);
      return { ...prev, prompts: hasAny ? nextPrompts : undefined };
    });
  };

  // 统计每个 section 有多少字段被覆盖
  const overrideCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of PROMPT_SECTIONS) {
      counts[s.id] = s.fields.filter(f => {
        const v = prompts[f.key];
        return typeof v === 'string' && v.length > 0;
      }).length;
    }
    return counts;
  }, [prompts]);

  return (
    <div className="p-5 space-y-4">
      <div className="sci-card p-4">
        <div className="text-[13px] font-semibold text-text mb-1">🧩 模板语法</div>
        <div className="text-[12px] text-text-secondary leading-relaxed">
          每段留空 = 用默认模板（占位符里能看到默认内容）。支持 Go <code className="font-mono bg-surface-sunken px-1 rounded">text/template</code> 语法，
          变量见每段标题下方的提示。模板语法错误时后端会静默回退到原模板，不会中断会议。
        </div>
      </div>
      {PROMPT_SECTIONS.map(section => {
        const isCollapsed = !!collapsed[section.id];
        const oc = overrideCounts[section.id] || 0;
        return (
          <div key={section.id} className="rounded-xl border border-border overflow-hidden">
            {/* Section header — 可点击折叠/展开 */}
            <button
              type="button"
              onClick={() => toggle(section.id)}
              className="w-full flex items-center gap-2 px-3 py-2.5 bg-surface-sunken/60 hover:bg-surface-sunken transition-colors text-start"
            >
              <span className="material-symbols-outlined text-[16px] text-violet-500">{section.icon}</span>
              <span className="text-[12px] font-bold text-text flex-1">{section.title}</span>
              {oc > 0 && (
                <span className="inline-flex items-center px-1.5 h-4 rounded text-[9px] bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold">
                  {oc} 已覆盖
                </span>
              )}
              <span className="text-[10px] text-text-muted">{section.fields.length} 段</span>
              <span className={`material-symbols-outlined text-[16px] text-text-muted transition-transform ${isCollapsed ? '' : 'rotate-180'}`}>
                expand_more
              </span>
            </button>
            {/* Section body */}
            {!isCollapsed && (
              <div className="p-3 space-y-3 bg-surface/40">
                {section.fields.map(f => {
                  const val = prompts[f.key];
                  const def = defaults[f.key] || '';
                  const overridden = typeof val === 'string' && val.length > 0;
                  return (
                    <div key={f.key} className="sci-card p-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="text-[12px] font-semibold text-text truncate">{f.label}</div>
                            {overridden && (
                              <span className="inline-flex items-center gap-0.5 px-1.5 h-4 rounded text-[9px] bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold">
                                已覆盖
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-text-secondary mt-0.5">{f.hint}</div>
                          <div className="text-[10px] text-text-muted mt-0.5 font-mono">变量：{f.vars}</div>
                        </div>
                        {overridden && (
                          <button
                            type="button"
                            onClick={() => patchPrompt(f.key, undefined)}
                            className="shrink-0 ms-2 text-[11px] text-text-secondary hover:text-danger inline-flex items-center gap-1 transition-colors"
                            title="删除此段覆盖，回到默认"
                          >
                            <span className="material-symbols-outlined text-[14px]">restart_alt</span>
                            恢复默认
                          </button>
                        )}
                      </div>
                      <textarea
                        value={val ?? ''}
                        onChange={e => patchPrompt(f.key, e.target.value)}
                        placeholder={def || '（默认值加载中）'}
                        rows={f.rows ?? 5}
                        className="sci-input w-full text-[12px] font-mono leading-relaxed resize-y"
                        spellCheck={false}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

// ── 通用小部件 ──

const SectionTitle: React.FC<{ icon: string; title: string; hint?: string }> = ({ icon, title, hint }) => (
  <div className="flex items-center gap-2 mt-2 first:mt-0 pb-1 border-b border-border/60">
    <span className="material-symbols-outlined text-[16px] text-violet-500">{icon}</span>
    <div className="text-[12px] font-bold text-text">{title}</div>
    {hint && <div className="text-[11px] text-text-muted ms-auto">{hint}</div>}
  </div>
);

const NumberField: React.FC<{
  label: string;
  hint: string;
  placeholder: string;
  step: number; min: number; max: number;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}> = ({ label, hint, placeholder, step, min, max, value, onChange }) => {
  // 统一 NumberStepper：带 +/- 按钮的受控输入。对外仍是 number|undefined，
  // 空串 → undefined（= 使用后端默认）；其它走 step/min/max 再落回 number。
  const strValue = value === undefined ? '' : String(value);
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3 items-center">
      <div className="min-w-0">
        <div className="text-[12px] font-semibold text-text">{label}</div>
        <div className="text-[11px] text-text-secondary">{hint}</div>
      </div>
      <div className="flex items-center gap-2">
        <NumberStepper
          value={strValue}
          onChange={(s) => {
            const trimmed = s.trim();
            if (trimmed === '') { onChange(undefined); return; }
            const n = Number(trimmed);
            if (Number.isFinite(n)) onChange(n);
          }}
          step={step}
          min={min}
          max={max}
          placeholder={placeholder}
          className="w-32 h-8"
        />
        {value !== undefined && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="w-7 h-7 rounded-md text-text-secondary hover:text-danger hover:bg-danger/10 inline-flex items-center justify-center transition-colors"
            title="恢复默认"
          >
            <span className="material-symbols-outlined text-[14px]">restart_alt</span>
          </button>
        )}
      </div>
    </div>
  );
};

// SelectField —— 三/多选枚举场景，语义比一串 ToggleField 更清楚。
// 改用统一的 CustomSelect（portal 弹层 + 不会触发原生下拉漂移）。
const SelectField: React.FC<{
  label: string;
  hint: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}> = ({ label, hint, value, options, onChange }) => (
  <label className="grid grid-cols-[1fr_auto] gap-3 items-center">
    <div className="min-w-0">
      <div className="text-[12px] font-semibold text-text">{label}</div>
      <div className="text-[11px] text-text-secondary">{hint}</div>
    </div>
    <div className="h-8 px-2 rounded-md bg-surface-sunken border border-border text-[12px] text-text focus-within:ring-2 focus-within:ring-violet-500/40 min-w-[180px] flex items-center">
      <CustomSelect value={value} onChange={onChange} options={options} className="w-full" />
    </div>
  </label>
);

const ToggleField: React.FC<{
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, hint, value, onChange }) => {
  return (
    <label className="grid grid-cols-[1fr_auto] gap-3 items-center cursor-pointer">
      <div className="min-w-0">
        <div className="text-[12px] font-semibold text-text">{label}</div>
        <div className="text-[11px] text-text-secondary">{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={[
          'relative inline-flex h-5 w-9 rounded-full transition-colors',
          value ? 'bg-violet-500 shadow-[0_0_8px_var(--glow-violet)]' : 'bg-surface-sunken border border-border',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-[2px] inline-block w-4 h-4 rounded-full bg-white shadow transition-transform',
            value ? 'start-[18px]' : 'start-[2px]',
          ].join(' ')}
        />
      </button>
    </label>
  );
};

// ── 辅助 ──

function sanitize(o: PolicyOptions): PolicyOptions {
  const out: PolicyOptions = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '' || (typeof v === 'number' && v === 0 && k !== 'biddingThreshold' && k !== 'interjectionThreshold')) {
      // 0 对阈值有意义（= 禁用门槛），所以阈值字段不按 0 过滤；其它数值字段 0 = 默认
      continue;
    }
    if (k === 'prompts') {
      const prompts = v as PromptPack;
      const cleanPrompts: PromptPack = {};
      let any = false;
      for (const [pk, pv] of Object.entries(prompts || {})) {
        if (typeof pv === 'string' && pv.length > 0) {
          (cleanPrompts as any)[pk] = pv;
          any = true;
        }
      }
      if (any) out.prompts = cleanPrompts;
      continue;
    }
    if (k === 'roundRobinOrder') {
      const arr = v as string[];
      if (Array.isArray(arr) && arr.length > 0) out.roundRobinOrder = arr;
      continue;
    }
    (out as any)[k] = v;
  }
  return out;
}

function previewChips(p: PolicyOptions): string[] {
  const chips: string[] = [];
  if (p.biddingThreshold != null)       chips.push(`bid≥${p.biddingThreshold}`);
  if (p.interjectionThreshold != null)  chips.push(`抢麦≥${p.interjectionThreshold}`);
  if (p.maxConsecutive != null)         chips.push(`连续≤${p.maxConsecutive}`);
  if (p.parallelFanout != null)         chips.push(`fanout=${p.parallelFanout}`);
  if (p.debateRounds != null)           chips.push(`辩论×${p.debateRounds}`);
  if (p.activeInterjection)             chips.push('主动抢麦');
  if (p.contextTailWindow != null)      chips.push(`tail=${p.contextTailWindow}`);
  if (p.contextHighlightsCap != null)   chips.push(`要点≤${p.contextHighlightsCap}`);
  if (p.contextTokenSoftLimit != null)  chips.push(`软顶${p.contextTokenSoftLimit}`);
  return chips.slice(0, 6);
}

export default RoomTuningModal;
