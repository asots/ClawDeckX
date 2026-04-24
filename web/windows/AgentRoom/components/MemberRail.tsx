// 右栏·成员列表
import React, { useState, useMemo, useEffect } from 'react';
import type { Member, GatewayAgentInfo } from '../types';
import type { SystemModel } from '../service';
import { MemberAvatar } from '../shared';
import CustomSelect from '../../../components/CustomSelect';
import { useOptimisticField } from '../hooks/useOptimisticField';

interface Props {
  members: Member[];
  meId: string;
  systemModels?: SystemModel[];
  // v0.4：OpenClaw agent 目录 —— 用于 agent 切换下拉。
  gatewayAgents?: GatewayAgentInfo[];
  // v0.8 语义激震：原“踢出”误导——用户以为是“退出房间”。主用 onKick，但 UI 文案包装为“离席”，
  // 配合 onInviteBack 形成双向操作：离席后变灰不消失，随时邀回。向后兼容原有工作流。
  onKick?: (id: string) => void | Promise<void>;
  onInviteBack?: (id: string) => void | Promise<void>;
  onToggleMute?: (id: string) => void | Promise<void>;
  onWhisper?: (id: string) => void;
  onRemove?: (id: string) => void;
  onInvite?: () => void;
  onOpenPersonaMemory?: (member: Member) => void;
  // v0.4：这三个回调应返回 Promise<void>；hook 会在 resolve 后等 WS/props 同步
  // 真值、reject 时立即回滚乐观值。也向下兼容同步 void 返回（按超时兜底清理）。
  onChangeModel?: (memberId: string, model: string) => Promise<void> | void;
  onChangeAgent?: (memberId: string, agentId: string) => Promise<void> | void;
  onChangeThinking?: (memberId: string, thinking: string) => Promise<void> | void;
  // v0.8：编辑成员角色系统提示词。空字符串 = 清空（后端回退默认）。
  onChangeSystemPrompt?: (memberId: string, systemPrompt: string) => Promise<void> | void;
}

const THINKING_OPTIONS = [
  { value: '', label: '默认' },
  { value: 'off', label: '关闭' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  idle: { label: '空闲', color: 'text-text-muted' },
  thinking: { label: '思考中', color: 'text-cyan-500' },
  speaking: { label: '发言中', color: 'text-green-500' },
  tool_call: { label: '准备工具', color: 'text-blue-500' },
  tool_running: { label: '工具运行', color: 'text-blue-500' },
  tool_waiting_approval: { label: '待审批', color: 'text-amber-500' },
  muted: { label: '已静音', color: 'text-slate-500' },
  error: { label: '错误', color: 'text-red-500' },
  offline: { label: '离线', color: 'text-slate-500' },
};

const MemberRail: React.FC<Props> = ({ members, meId, systemModels, gatewayAgents, onKick, onInviteBack, onToggleMute, onWhisper, onRemove, onInvite, onOpenPersonaMemory, onChangeModel, onChangeAgent, onChangeThinking, onChangeSystemPrompt }) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // v0.8 按钮 busy 状态——让“静音/离席/邀回”点击后即时展 spinner，
  // 避免用户怀疑没触发。WS 推回真值后从下次 render 自动交完。
  // key = memberId + 操作类型，同一成员两个按钮可并行（静音 + 离席）。
  type BusyKind = 'mute' | 'kick' | 'unkick';
  const [busy, setBusy] = useState<Record<string, BusyKind[]>>({});
  const markBusy = (id: string, k: BusyKind, on: boolean) => setBusy(prev => {
    const cur = prev[id] || [];
    const next = on ? [...new Set([...cur, k])] : cur.filter(x => x !== k);
    if (next.length === cur.length && next.every(x => cur.includes(x))) return prev;
    return { ...prev, [id]: next };
  });
  const isBusy = (id: string, k: BusyKind) => (busy[id] || []).includes(k);
  const runAction = async (id: string, k: BusyKind, op?: (id: string) => void | Promise<void>) => {
    if (!op) return;
    markBusy(id, k, true);
    try { await Promise.resolve(op(id)); } finally { markBusy(id, k, false); }
  };
  // 乐观 UI：三个字段（agent / model / thinking）× 每位成员，共用一个 hook 实例，
  // key 约定：`${memberId}:${field}`。
  const opt = useOptimisticField();

  // 当 members 推来新真值时，批量对齐所有 pending key（WS 事件最终会触发这里）。
  useEffect(() => {
    for (const m of members) {
      opt.syncActual(`${m.id}:agent`, m.agentId || '');
      opt.syncActual(`${m.id}:model`, m.model || '');
      opt.syncActual(`${m.id}:thinking`, m.thinking || '');
    }
  }, [members, opt]);

  const modelOptions = useMemo(() =>
    [
      { value: '', label: '继承 agent 默认' },
      ...((systemModels || []).map(m => ({ value: m.id, label: m.label || m.id }))),
    ],
    [systemModels],
  );
  const agentOptions = useMemo(() =>
    [
      { value: '', label: '默认 agent' },
      ...((gatewayAgents || []).map(a => ({
        value: a.id,
        label: (a.name || a.id) + (a.model ? `  (${a.model})` : ''),
      }))),
    ],
    [gatewayAgents],
  );

  return (
    <div className="space-y-1">
      {/* v0.8：离席（isKicked）成员不再过滤隐藏，而是灰显 + 邀回按钮，保留属于房间的历史贡献。
          排序：活跃成员在前、离席成员在后。 */}
      {[...members].sort((a, b) => Number(!!a.isKicked) - Number(!!b.isKicked)).map(m => {
        const st = STATUS_LABEL[m.status] || STATUS_LABEL.idle;
        const expanded = expandedId === m.id;
        const kicked = !!m.isKicked;
        const contextPressure = m.contextLimit && m.lastPromptTokens
          ? Math.min(100, Math.round((m.lastPromptTokens / m.contextLimit) * 100))
          : null;
        return (
          <div key={m.id} className={`group ${kicked ? 'opacity-60' : ''}`}>
            <button
              onClick={() => setExpandedId(expanded ? null : m.id)}
              className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg transition-all text-start ${expanded ? 'bg-surface-sunken' : 'hover:bg-surface-sunken'} ${kicked ? 'grayscale' : ''}`}
            >
              <MemberAvatar member={m} size="sm" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`text-[12px] font-semibold truncate ${kicked ? 'text-text-muted line-through' : 'text-text'}`}>{m.name}</span>
                  {m.id === meId && <span className="px-1 py-0 rounded bg-cyan-500/10 text-cyan-500 text-[9px] font-bold leading-[1.4]">你</span>}
                  {kicked && (
                    <span className="px-1 py-0 rounded bg-slate-500/15 text-slate-500 text-[9px] font-bold leading-[1.4]">已离席</span>
                  )}
                  {!kicked && m.isMuted && (
                    <span className="px-1 py-0 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[9px] font-bold leading-[1.4]">静音</span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] min-w-0">
                  <span className={`font-mono ${kicked ? 'text-text-muted' : st.color}`}>
                    {kicked ? '不再发言（可邀回）' : st.label}
                  </span>
                  {!kicked && m.model && <span className="text-text-muted font-mono truncate">{m.model.replace(/^claude-/, '').replace(/^gpt-/, '')}</span>}
                  {!kicked && m.status === 'tool_waiting_approval' && (
                    <span className="inline-flex items-center gap-1 px-1 py-0 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30 text-[9px] font-semibold leading-[1.4]">
                      <span className="material-symbols-outlined text-[10px]">approval</span>待审批
                    </span>
                  )}
                  {!kicked && (m.status === 'tool_call' || m.status === 'tool_running') && (
                    <span className="inline-flex items-center gap-1 px-1 py-0 rounded bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-500/30 text-[9px] font-semibold leading-[1.4]">
                      <span className="material-symbols-outlined text-[10px]">build_circle</span>工具
                    </span>
                  )}
                  {/* v0.9.2：状态文字已经显示了"思考中"，这里只在"设置了明确 thinking 强度"时才出徽章，
                      展示具体的 low/medium/high 级别，避免和状态文字重复显示"思考"两次。 */}
                  {!kicked && m.status === 'thinking' && m.thinking && m.thinking !== 'off' && (
                    <span className="inline-flex items-center gap-1 px-1 py-0 rounded bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30 text-[9px] font-semibold leading-[1.4]"
                      title={`思考强度：${m.thinking}`}>
                      <span className="material-symbols-outlined text-[10px]">neurology</span>
                      {({ low: '低', medium: '中', high: '高' } as Record<string, string>)[m.thinking] || m.thinking}
                    </span>
                  )}
                  {!kicked && contextPressure !== null && contextPressure >= 70 && (
                    <span className={`inline-flex items-center gap-1 px-1 py-0 rounded border text-[9px] font-semibold leading-[1.4] ${contextPressure >= 85
                      ? 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30'
                      : 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30'}`}>
                      <span className="material-symbols-outlined text-[10px]">memory</span>{contextPressure}%
                    </span>
                  )}
                </div>
              </div>
              {/* 离席状态下不展开面板，右侧直接放邀回按钮。 */}
              {kicked && onInviteBack ? (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={e => { e.stopPropagation(); void runAction(m.id, 'unkick', onInviteBack); }}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); void runAction(m.id, 'unkick', onInviteBack); } }}
                  className="inline-flex items-center gap-1 px-2 h-6 rounded-md text-[10.5px] font-semibold bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30 transition-all"
                  title="邀回此成员重新参与发言"
                >
                  {isBusy(m.id, 'unkick') ? (
                    <span className="w-3 h-3 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
                  ) : (
                    <span className="material-symbols-outlined text-[12px]">how_to_reg</span>
                  )}
                  邀回
                </span>
              ) : (
                <span className={`material-symbols-outlined text-[16px] text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}>expand_more</span>
              )}
            </button>
            {expanded && (
              <div className="mx-1 my-1 p-2 rounded-lg bg-surface-raised border border-border text-[11px] space-y-1.5 animate-card-enter">
                <Row label="角色" value={m.role} />
                {m.kind === 'agent' && (
                  <>
                    {(() => {
                      const agentKey = `${m.id}:agent`;
                      const modelKey = `${m.id}:model`;
                      const thinkingKey = `${m.id}:thinking`;
                      const agentPending = opt.pending(agentKey);
                      const modelPending = opt.pending(modelKey);
                      const thinkingPending = opt.pending(thinkingKey);
                      return (
                        <>
                          <div className="flex items-start gap-2">
                            <span className="text-text-muted w-16 shrink-0 text-[11px]">Agent</span>
                            <div className="flex-1 min-w-0 relative" onClick={e => e.stopPropagation()}>
                              <CustomSelect
                                value={opt.value(agentKey, m.agentId || '')}
                                onChange={(v) => { if (onChangeAgent) void opt.commit(agentKey, v, () => onChangeAgent(m.id, v)).catch(() => { /* 服务层已 toast */ }); }}
                                options={agentOptions}
                                placeholder="默认 agent"
                                disabled={agentPending}
                                className={`h-6 px-1.5 rounded-md text-[11px] font-mono bg-surface border border-border ${agentPending ? 'opacity-60' : ''}`}
                              />
                              {agentPending && <PendingDot />}
                            </div>
                          </div>
                          <div className="flex items-start gap-2">
                            <span className="text-text-muted w-16 shrink-0 text-[11px]">模型</span>
                            <div className="flex-1 min-w-0 relative" onClick={e => e.stopPropagation()}>
                              <CustomSelect
                                value={opt.value(modelKey, m.model || '')}
                                onChange={(v) => { if (onChangeModel) void opt.commit(modelKey, v, () => onChangeModel(m.id, v)).catch(() => {}); }}
                                options={modelOptions}
                                placeholder="继承 agent 默认"
                                disabled={modelPending}
                                className={`h-6 px-1.5 rounded-md text-[11px] font-mono bg-surface border border-border ${modelPending ? 'opacity-60' : ''}`}
                              />
                              {modelPending && <PendingDot />}
                            </div>
                          </div>
                          <div className="flex items-start gap-2">
                            <span className="text-text-muted w-16 shrink-0 text-[11px]">Thinking</span>
                            <div className="flex-1 min-w-0 relative" onClick={e => e.stopPropagation()}>
                              <CustomSelect
                                value={opt.value(thinkingKey, m.thinking || '')}
                                onChange={(v) => { if (onChangeThinking) void opt.commit(thinkingKey, v, () => onChangeThinking(m.id, v)).catch(() => {}); }}
                                options={THINKING_OPTIONS}
                                placeholder="默认"
                                disabled={thinkingPending}
                                className={`h-6 px-1.5 rounded-md text-[11px] bg-surface border border-border ${thinkingPending ? 'opacity-60' : ''}`}
                              />
                              {thinkingPending && <PendingDot />}
                            </div>
                          </div>
                        </>
                      );
                    })()}
                  </>
                )}
                {/* v0.8 角色提示词编辑。点击“编辑”展开 textarea → “保存”落后端 → 同步 OpenClaw
                    session。空值状态 = 没设置（用模板默认）。非 agent 成员（你/人类）不显示。 */}
                {m.kind === 'agent' && onChangeSystemPrompt && (
                  <SystemPromptEditor
                    value={m.systemPrompt || ''}
                    onSave={(v) => onChangeSystemPrompt(m.id, v)}
                  />
                )}
                <Row label="本室 tokens" value={m.tokenUsage.toLocaleString()} mono />
                <Row label="本室 ¥" value={`¥${m.costCNY.toFixed(2)}`} mono />
                {m.kind === 'agent' && !!m.contextLimit && !!m.lastPromptTokens && (() => {
                  const pct = Math.min(100, Math.round((m.lastPromptTokens! / m.contextLimit!) * 100));
                  const tone =
                    pct >= 85 ? 'bg-red-500' :
                    pct >= 60 ? 'bg-amber-500' :
                                'bg-emerald-500';
                  return (
                    <div className="pt-1 border-t border-border">
                      <div className="flex items-center justify-between text-[10px] text-text-muted mb-0.5">
                        <span>上下文压力</span>
                        <span className="font-mono tabular-nums">{m.lastPromptTokens!.toLocaleString()}/{m.contextLimit!.toLocaleString()} · {pct}%</span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-surface-sunken overflow-hidden">
                        <div className={`h-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })()}
                {m.kind === 'agent' && (
                  <div className="flex flex-wrap gap-1 pt-1 border-t border-border">
                    <button
                      onClick={e => { e.stopPropagation(); onWhisper?.(m.id); }}
                      className="inline-flex items-center gap-1 px-1.5 h-6 rounded-md text-[10px] font-semibold bg-surface hover:bg-surface-sunken border border-border"
                    >
                      <span className="material-symbols-outlined text-[12px]">lock</span>私聊
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); void runAction(m.id, 'mute', onToggleMute); }}
                      disabled={isBusy(m.id, 'mute')}
                      className={`inline-flex items-center gap-1 px-1.5 h-6 rounded-md text-[10px] font-semibold border transition-colors disabled:opacity-60 disabled:pointer-events-none ${m.isMuted
                        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40 hover:bg-amber-500/25'
                        : 'bg-surface hover:bg-surface-sunken border-border'}`}
                      title={m.isMuted ? '取消静音 · ta 将重新参与发言' : '静音 · ta 会被 scheduler 跳过，但仍在会议中'}
                    >
                      {isBusy(m.id, 'mute') ? (
                        <span className="w-2.5 h-2.5 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
                      ) : (
                        <span className="material-symbols-outlined text-[12px]">{m.isMuted ? 'volume_up' : 'volume_off'}</span>
                      )}
                      {m.isMuted ? '取消静音' : '静音'}
                    </button>
                    {onOpenPersonaMemory && (
                      <button
                        onClick={e => { e.stopPropagation(); onOpenPersonaMemory(m); }}
                        className="inline-flex items-center gap-1 px-1.5 h-6 rounded-md text-[10px] font-semibold bg-surface hover:bg-surface-sunken border border-border"
                        title="跨房间长期画像记忆"
                      >
                        <span className="material-symbols-outlined text-[12px]">psychology</span>长期记忆
                      </button>
                    )}
                    {/* v0.8 “踢出” → “离席”：旧文案 logout 误导用户（以为是退房间）。
                        真实语义是“这个 agent 不再参与发言”，且随时可邀回。图标换成 person_off，
                        颜色降级为灰（非危险）。 */}
                    <button
                      onClick={e => { e.stopPropagation(); void runAction(m.id, 'kick', onKick); }}
                      disabled={isBusy(m.id, 'kick')}
                      className="inline-flex items-center gap-1 px-1.5 h-6 rounded-md text-[10px] font-semibold bg-surface hover:bg-slate-500/10 hover:text-slate-600 dark:hover:text-slate-300 border border-border disabled:opacity-60 disabled:pointer-events-none"
                      title="离席 · ta 不再参与发言，随时可邀回。不会删除已说的话。"
                    >
                      {isBusy(m.id, 'kick') ? (
                        <span className="w-2.5 h-2.5 rounded-full border-2 border-slate-400 border-t-transparent animate-spin" />
                      ) : (
                        <span className="material-symbols-outlined text-[12px]">person_off</span>
                      )}
                      离席
                    </button>
                    {onRemove && (
                      <button
                        onClick={e => { e.stopPropagation(); onRemove(m.id); }}
                        className="inline-flex items-center gap-1 px-1.5 h-6 rounded-md text-[10px] font-semibold bg-surface hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 border border-border transition-colors"
                        title="永久删除此成员（可选择是否保留历史消息）"
                      >
                        <span className="material-symbols-outlined text-[12px]">person_remove</span>
                        删除
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {onInvite && (
        <button
          onClick={onInvite}
          className="w-full mt-1 h-8 rounded-lg border border-dashed border-border text-text-muted hover:border-cyan-500/40 hover:text-cyan-500 hover:bg-cyan-500/5 transition-all text-[11px] font-semibold flex items-center justify-center gap-1.5"
        >
          <span className="material-symbols-outlined text-[15px]">person_add</span>
          邀请成员
        </button>
      )}
    </div>
  );
};

const Row: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="flex items-start gap-2">
    <span className="text-text-muted w-16 shrink-0">{label}</span>
    <span className={`flex-1 min-w-0 break-words ${mono ? 'font-mono tabular-nums' : ''} text-text`}>{value}</span>
  </div>
);

// SystemPromptEditor —— 成员角色提示词的展开式编辑器。
//
// 默认只显示 “角色提示词·编辑 保存” 一行 + 内容截留；展开后才见完整 textarea。
// 这样的好处：面板在未编辑时保持紧凑；反正默认用户不改的情况更多。
const SystemPromptEditor: React.FC<{
  value: string;
  onSave: (v: string) => Promise<void> | void;
}> = ({ value, onSave }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  // 外部值变化时同步到 draft（WS 推新值 / 切换成员）。
  useEffect(() => {
    if (!open) setDraft(value);
  }, [value, open]);
  const dirty = draft !== value;
  const preview = (value || '— 没设置，将用模板默认提示词').slice(0, 80);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(draft.trim());
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="pt-1 border-t border-border">
      {!open ? (
        <button
          onClick={(e) => { e.stopPropagation(); setOpen(true); }}
          className="w-full flex items-start gap-2 text-start hover:bg-surface-sunken/60 rounded px-1 py-1 -mx-1"
          title="编辑角色系统提示词"
        >
          <span className="text-text-muted w-16 shrink-0 text-[11px]">提示词</span>
          <span className="flex-1 min-w-0 text-[11px] text-text-secondary line-clamp-2 break-words">{preview}</span>
          <span className="material-symbols-outlined text-[13px] text-text-muted">edit</span>
        </button>
      ) : (
        <div className="space-y-1.5" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between">
            <span className="text-text-muted text-[11px]">角色系统提示词</span>
            <span className="text-text-muted text-[10px]">{draft.length}/2000</span>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, 2000))}
            rows={4}
            placeholder="例如：你是资深架构师，关注落地性大于完美性。语气简洁、只挑关键风险。留空则回退模板默认。"
            className="w-full px-2 py-1.5 rounded-md bg-surface border border-border sci-input text-[11px] resize-none font-sans"
            disabled={saving}
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              onClick={() => { setDraft(value); setOpen(false); }}
              disabled={saving}
              className="px-2 h-6 rounded-md text-[10.5px] font-semibold bg-surface hover:bg-surface-sunken border border-border text-text-secondary disabled:opacity-50"
            >取消</button>
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="px-2.5 h-6 rounded-md text-[10.5px] font-semibold bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30 disabled:opacity-40 disabled:pointer-events-none inline-flex items-center gap-1"
            >
              {saving && <span className="w-2.5 h-2.5 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />}
              保存
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// PendingDot 是叠加在下拉右上角的旋转指示器，提示 "已选中、正在写回"。
// 走 absolute 叠加而不是改 CustomSelect —— 避免给共享组件加专用 prop。
// pointer-events-none 保证不吃点击事件（下拉自身的禁用态已经由 disabled 保证）。
const PendingDot: React.FC = () => (
  <span
    className="pointer-events-none absolute top-1/2 right-6 -translate-y-1/2 w-2.5 h-2.5 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin"
    aria-label="saving"
  />
);

export default MemberRail;
