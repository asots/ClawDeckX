import React, { useMemo, useState, useRef, useCallback } from 'react';
import type { RoleProfile, GatewayAgentInfo } from '../types';
import type { SystemModel } from '../service';
import CustomSelect from '../../../components/CustomSelect';
import { multiAgentApi } from '../../../services/api';

const EF: React.FC<{ label: string; hint?: string; required?: boolean; children: React.ReactNode }> = ({ label, hint, required, children }) => (
  <div className="space-y-1">
    <div className="flex items-baseline gap-1.5">
      <span className="text-[11.5px] font-semibold text-text">{label}</span>
      {required && <span className="text-[10px] text-danger">*</span>}
      {hint && <span className="text-[10px] text-text-muted">— {hint}</span>}
    </div>
    {children}
  </div>
);

const THINKING_LEVELS = [
  { value: '', label: '默认' },
  { value: 'off', label: '关闭' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

const inp = 'w-full h-9 px-2.5 rounded-lg bg-surface-raised border border-border sci-input text-[12px]';
const ta = 'w-full px-2.5 py-2 rounded-lg bg-surface-raised border border-border sci-input text-[11.5px] resize-y';
const sel = 'h-9 px-2 rounded-lg text-[12px] bg-surface-raised border border-border';

interface Props {
  open: boolean;
  draft: Partial<RoleProfile>;
  isNew: boolean;
  isBuiltin: boolean;
  saving: boolean;
  deleting: boolean;
  onDraftChange: (fn: (p: Partial<RoleProfile>) => Partial<RoleProfile>) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
  /** 网关 Agent 列表，供“绑定 Agent”下拉 */
  gatewayAgents?: GatewayAgentInfo[];
  /** 系统模型列表，供“默认模型”下拉 */
  systemModels?: SystemModel[];
  /** 已有分类列表，供“分类”下拉 */
  categories?: string[];
}

const AI_ROLE_SYSTEM_PROMPT = `Output ONLY valid JSON. No markdown fences, no explanation, no extra text.
You are generating a role profile for a multi-agent meeting room system.
The user will describe what kind of role they want. Generate a complete role profile JSON.

Required JSON keys (all string values, escape newlines as \n):
{
  "name": "<display name for the card>",
  "role": "<short identity shown next to avatar>",
  "emoji": "<one emoji>",
  "category": "<one of: ops, research, fun, debate, creative, or a custom short category>",
  "description": "<one sentence describing this role>",
  "systemPrompt": "<detailed system prompt: who this role is, what they do, how they behave, constraints>",
  "stylePrompt": "<optional output style constraint, empty string if none>",
  "stance": "<one of: pro, con, neutral, or empty string>",
  "thinking": "<one of: off, low, medium, high, or empty string for default>",
  "isModerator": false
}`;

const RoleEditorModal: React.FC<Props> = ({ open, draft, isNew, isBuiltin, saving, deleting, onDraftChange, onSave, onDelete, onClose, gatewayAgents = [], systemModels = [], categories = [] }) => {
  const categoryOptions = useMemo(() => {
    const opts = [{ value: '', label: '未分类' }];
    for (const c of categories) {
      if (c) opts.push({ value: c, label: c });
    }
    return opts;
  }, [categories]);

  const agentOptions = useMemo(() => [
    { value: '', label: '默认 agent' },
    ...gatewayAgents.map(a => ({
      value: a.id,
      label: (a.name || a.id) + (a.model ? ` · ${a.model}` : ''),
    })),
  ], [gatewayAgents]);

  const modelOptions = useMemo(() => [
    { value: '', label: '（未选模型）' },
    ...systemModels.map(m => ({ value: m.id, label: m.label || m.id })),
  ], [systemModels]);

  // ── AI 生成角色 ──
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiRunning, setAiRunning] = useState(false);
  const [aiStream, setAiStream] = useState('');
  const [aiError, setAiError] = useState<string | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);
  const aiBufRef = useRef('');
  const aiRafRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleAiGenerate = useCallback(() => {
    if (!aiPrompt.trim() || aiRunning) return;
    aiAbortRef.current?.abort();
    aiBufRef.current = '';
    if (aiRafRef.current !== null) { clearTimeout(aiRafRef.current); aiRafRef.current = null; }
    setAiStream('');
    setAiError(null);
    setAiRunning(true);

    const fullPrompt = AI_ROLE_SYSTEM_PROMPT + '\n\nUser request: ' + aiPrompt.trim() + '\n\nWrite all content in Chinese unless the user specifies otherwise.';

    aiAbortRef.current = multiAgentApi.wizardStep2(
      {
        agentId: 'role-gen',
        agentName: 'Role Generator',
        agentRole: 'role profile generator',
        agentDesc: '',
        scenarioName: 'role-generation',
        language: 'Chinese',
        customPrompt: fullPrompt,
      },
      (token) => {
        aiBufRef.current += token;
        if (aiRafRef.current === null) {
          aiRafRef.current = setTimeout(() => {
            setAiStream(aiBufRef.current);
            aiRafRef.current = null;
          }, 30);
        }
      },
      () => {
        setAiRunning(false);
        // 解析 JSON 并填充 draft
        const raw = aiBufRef.current.trim();
        // 去掉可能的 markdown fences
        const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        try {
          const parsed = JSON.parse(cleaned);
          onDraftChange(() => ({
            ...draft,
            name: parsed.name || draft.name || '',
            role: parsed.role || draft.role || '',
            emoji: parsed.emoji || draft.emoji || '',
            category: parsed.category || draft.category || '',
            description: parsed.description || draft.description || '',
            systemPrompt: parsed.systemPrompt || draft.systemPrompt || '',
            stylePrompt: parsed.stylePrompt || draft.stylePrompt || '',
            stance: parsed.stance || draft.stance || '',
            thinking: parsed.thinking || draft.thinking || '',
            isModerator: typeof parsed.isModerator === 'boolean' ? parsed.isModerator : draft.isModerator,
          }));
          setAiOpen(false);
          setAiStream('');
          setAiPrompt('');
        } catch {
          setAiError('AI 返回内容解析失败，请调整描述后重试');
        }
      },
      (_code, msg) => {
        setAiRunning(false);
        setAiError(msg || '生成失败');
      },
    );
  }, [aiPrompt, aiRunning, draft, onDraftChange]);

  const handleAiStop = useCallback(() => {
    aiAbortRef.current?.abort();
    setAiRunning(false);
  }, []);

  if (!open) return null;
  const canSave = !!String(draft.name || '').trim() && !!String(draft.role || '').trim();
  return (
    <div className="fixed inset-0 z-[10001] flex items-center justify-center p-4 animate-fade-in" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative w-full max-w-xl max-h-[85vh] flex flex-col rounded-2xl border border-border bg-surface-overlay shadow-2xl animate-card-enter" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="shrink-0 px-5 py-3.5 border-b border-border flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-fuchsia-500 to-violet-500 flex items-center justify-center">
            <span className="material-symbols-outlined text-white text-[20px]">{isNew ? 'person_add' : 'edit'}</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-bold text-text truncate">{isNew ? '新建角色' : `编辑 · ${draft.role || draft.name || '角色'}`}</div>
            <div className="text-[10.5px] text-text-muted">{isNew ? '创建可复用的角色模板，组建团队时可一键选用' : '修改后点保存，下次创建房间时自动生效'}</div>
          </div>
          <button
            onClick={() => setAiOpen(o => !o)}
            className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-[11px] font-semibold transition-all border ${
              aiOpen
                ? 'border-violet-400 bg-violet-500/15 text-violet-500'
                : 'border-border bg-surface hover:bg-violet-500/10 hover:border-violet-400/50 hover:text-violet-500 text-text-secondary'
            }`}
            title="AI 智能生成角色"
          >
            <span className="material-symbols-outlined text-[15px]">auto_awesome</span>
            AI 生成
          </button>
          {isBuiltin && <span className="inline-flex items-center px-2 h-5 rounded text-[9px] font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-400 shrink-0">内置</span>}
          <button onClick={onClose} className="w-8 h-8 rounded-md hover:bg-surface-sunken flex items-center justify-center text-text-secondary shrink-0">
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto neon-scrollbar px-5 py-4 space-y-4">

          {/* AI 生成面板 */}
          {aiOpen && (
            <div className="rounded-xl border border-violet-400/40 bg-violet-500/5 p-3.5 space-y-3 animate-card-enter">
              <div className="flex items-center gap-2 text-[12px] font-bold text-violet-500">
                <span className="material-symbols-outlined text-[16px]">auto_awesome</span>AI 智能生成角色
                <button onClick={() => { setAiOpen(false); handleAiStop(); }} className="ms-auto w-6 h-6 rounded flex items-center justify-center hover:bg-surface-sunken text-text-muted">
                  <span className="material-symbols-outlined text-[14px]">close</span>
                </button>
              </div>
              <div className="text-[10.5px] text-text-muted">描述你想要的角色，AI 会自动生成完整的角色配置并填充表单</div>
              <textarea
                value={aiPrompt}
                onChange={e => setAiPrompt(e.target.value)}
                placeholder="例如：创建一个资深前端架构师角色，擅长 React/TypeScript，关注性能优化和代码质量，说话直接但有建设性"
                rows={3}
                className={`${ta} min-h-[60px] border-violet-400/30 focus:border-violet-400`}
                disabled={aiRunning}
              />
              {aiStream && (
                <div className="max-h-32 overflow-y-auto rounded-lg bg-surface-sunken/60 p-2.5 text-[10.5px] text-text-secondary font-mono whitespace-pre-wrap neon-scrollbar">
                  {aiStream}
                </div>
              )}
              {aiError && (
                <div className="text-[11px] text-danger flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[14px]">error</span>{aiError}
                </div>
              )}
              <div className="flex items-center gap-2">
                {!aiRunning ? (
                  <button
                    onClick={handleAiGenerate}
                    disabled={!aiPrompt.trim()}
                    className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-[11px] font-semibold bg-violet-500 hover:bg-violet-600 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <span className="material-symbols-outlined text-[14px]">play_arrow</span>
                    生成
                  </button>
                ) : (
                  <button
                    onClick={handleAiStop}
                    className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-[11px] font-semibold bg-danger/15 hover:bg-danger/25 text-danger transition-all"
                  >
                    <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                    停止
                  </button>
                )}
                <span className="text-[10px] text-text-muted">生成完成后自动填充下方表单</span>
              </div>
            </div>
          )}

          {/* 基本信息 */}
          <div className="rounded-xl border border-border bg-surface-sunken/30 p-3.5 space-y-3">
            <div className="flex items-center gap-2 text-[12px] font-bold text-text">
              <span className="material-symbols-outlined text-[16px] text-violet-500">id_card</span>基本信息
            </div>
            <div className="grid grid-cols-2 gap-3">
              <EF label="卡片名" hint="角色列表中显示的名称" required>
                <input value={String(draft.name || '')} onChange={e => onDraftChange(p => ({ ...p, name: e.target.value }))} placeholder="如：产品经理" className={inp} />
              </EF>
              <EF label="角色身份" hint="会议中头像旁的身份" required>
                <input value={String(draft.role || '')} onChange={e => onDraftChange(p => ({ ...p, role: e.target.value }))} placeholder="如：PM" className={inp} />
              </EF>
            </div>
            <div className="grid grid-cols-[72px_minmax(0,1fr)_120px] gap-3">
              <EF label="头像">
                <input value={String(draft.emoji || '')} onChange={e => onDraftChange(p => ({ ...p, emoji: e.target.value }))} placeholder="🤖" className={`${inp} text-center`} />
              </EF>
              <EF label="分类" hint="方便筛选">
                <input
                  list="role-category-list"
                  value={String(draft.category || '')}
                  onChange={e => onDraftChange(p => ({ ...p, category: e.target.value }))}
                  placeholder="选择或输入分类"
                  className={inp}
                />
                <datalist id="role-category-list">
                  {categories.filter(Boolean).map(c => <option key={c} value={c} />)}
                </datalist>
              </EF>
              <EF label="可见性">
                <CustomSelect value={String(draft.visibility || 'private')} onChange={v => onDraftChange(p => ({ ...p, visibility: v || 'private' }))} options={[{ value: 'private', label: '仅自己' }, { value: 'shared', label: '共享' }]} className={sel} />
              </EF>
            </div>
          </div>

          {/* 提示词与行为 */}
          <div className="rounded-xl border border-border bg-surface-sunken/30 p-3.5 space-y-3">
            <div className="flex items-center gap-2 text-[12px] font-bold text-text">
              <span className="material-symbols-outlined text-[16px] text-cyan-500">psychology</span>提示词与行为
            </div>
            <EF label="系统提示词" hint="定义角色的人设、说话风格、关注领域">
              <textarea value={String(draft.systemPrompt || '')} onChange={e => onDraftChange(p => ({ ...p, systemPrompt: e.target.value }))} rows={4} placeholder="你是一位资深产品经理，擅长从用户视角思考问题..." className={`${ta} min-h-[80px]`} />
            </EF>
            <EF label="风格提示词" hint="约束输出风格（简洁/详细/列表/报告体）">
              <textarea value={String(draft.stylePrompt || '')} onChange={e => onDraftChange(p => ({ ...p, stylePrompt: e.target.value }))} rows={2} placeholder="请用简洁的要点回复" className={`${ta} min-h-[48px]`} />
            </EF>
            <div className="grid grid-cols-2 gap-3">
              <EF label="立场" hint="讨论中偏向的方向">
                <CustomSelect value={String(draft.stance || '')} onChange={v => onDraftChange(p => ({ ...p, stance: (v || '') as RoleProfile['stance'] }))} options={[{ value: '', label: '无立场' }, { value: 'pro', label: '支持方 (pro)' }, { value: 'con', label: '反对方 (con)' }, { value: 'neutral', label: '中立 (neutral)' }]} className={sel} />
              </EF>
              <EF label="思考强度" hint="Thinking 级别">
                <CustomSelect
                  value={String(draft.thinking || '')}
                  onChange={v => onDraftChange(p => ({ ...p, thinking: v }))}
                  options={THINKING_LEVELS}
                  className={sel}
                />
              </EF>
            </div>
            <label className="inline-flex items-center gap-2 text-[11.5px] text-text-secondary cursor-pointer select-none">
              <input type="checkbox" checked={!!draft.isModerator} onChange={e => onDraftChange(p => ({ ...p, isModerator: e.target.checked }))} className="rounded border-border accent-violet-500" />
              设为<span className="font-semibold text-text">主持人候选</span>— 可控制发言顺序、总结讨论
            </label>
          </div>

          {/* 运行时绑定 */}
          <div className="rounded-xl border border-border bg-surface-sunken/30 p-3.5 space-y-3">
            <div className="flex items-center gap-2 text-[12px] font-bold text-text">
              <span className="material-symbols-outlined text-[16px] text-amber-500">link</span>运行时绑定
              <span className="text-[10px] text-text-muted font-normal">（可选）</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <EF label="绑定 Agent" hint="OpenClaw Agent ID">
                <CustomSelect
                  value={String(draft.agentId || '')}
                  onChange={v => onDraftChange(p => ({ ...p, agentId: v }))}
                  options={agentOptions}
                  placeholder={gatewayAgents.length === 0 ? '网关未就绪' : '选择 Agent'}
                  className={`${sel} font-mono`}
                />
              </EF>
              <EF label="默认模型" hint="该角色优先使用的模型">
                <CustomSelect
                  value={String(draft.model || '')}
                  onChange={v => onDraftChange(p => ({ ...p, model: v }))}
                  options={modelOptions}
                  placeholder={systemModels.length === 0 ? '无可用模型' : '选择模型'}
                  className={`${sel} font-mono`}
                />
              </EF>
            </div>
            <EF label="记忆键" hint="memoryKey — 跨房间共享该角色的持久记忆">
              <input value={String(draft.memoryKey || '')} onChange={e => onDraftChange(p => ({ ...p, memoryKey: e.target.value }))} placeholder="留空则记忆按房间隔离" className={`${inp} font-mono`} />
            </EF>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 px-5 py-3 border-t border-border flex items-center justify-between gap-3">
          {!isNew ? (
            <button onClick={onDelete} disabled={isBuiltin || deleting} className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-[11px] font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-danger/10 hover:bg-danger/15 text-danger">
              <span className="material-symbols-outlined text-[14px]">delete</span>{deleting ? '删除中…' : '删除角色'}
            </button>
          ) : <div />}
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 h-8 rounded-lg text-[11px] font-semibold text-text-secondary hover:bg-surface-sunken transition-colors">取消</button>
            <button onClick={onSave} disabled={saving || !canSave} className="inline-flex items-center gap-1.5 px-4 h-8 rounded-lg text-[11px] font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-violet-500 hover:bg-violet-600 text-white">
              <span className="material-symbols-outlined text-[14px]">save</span>{saving ? '保存中…' : (isNew ? '创建角色' : '保存修改')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RoleEditorModal;
