// AI 一句话建会 —— 两阶段生成：
//   Phase 1：团队蓝图（标题/目标/策略/成员骨架，~600 tokens）
//   Phase 2：逐角色丰富（每角色的 systemPrompt + stylePrompt，~200 tokens/角色）
//   角色库模糊匹配：Phase 1 完成后先匹配已有角色库，命中则跳过 Phase 2。
import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { RoleProfile, RoomPolicy } from '../types';
import {
  fetchSystemModels,
  listRoleProfiles, createRoleProfile,
  type CustomMemberSpec,
  type SystemModel,
} from '../service';
import { multiAgentApi } from '../../../services/api';
import CustomSelect from '../../../components/CustomSelect';
import { POLICY_META } from '../shared';

// ─── Types ───

type AiPhase = 'input' | 'phase1' | 'blueprint' | 'phase2' | 'review';

interface AiMember {
  role: string;
  emoji: string;
  brief: string;
  stance: string;
  thinking: string;
  isModerator: boolean;
  systemPrompt: string;
  stylePrompt: string;
  matchedProfileId?: string;
  enriched: boolean;
  enriching: boolean;
}

interface AiConfig {
  title: string;
  goal: string;
  policy: RoomPolicy;
  budget: number;
  conflictMode: '' | 'review' | 'debate';
  roundBudget: number;
  members: AiMember[];
}

type ConflictMode = '' | 'review' | 'debate';

type CreateRequest =
  | { kind: 'template'; templateId: string; title?: string; initialPrompt?: string; budgetCNY?: number }
  | { kind: 'custom'; title: string; goal?: string; members: CustomMemberSpec[]; policy: RoomPolicy; budgetCNY: number; initialPrompt?: string; conflictMode?: ConflictMode; roundBudget?: number; collaborationStyle?: string };

interface Props {
  onCreate: (req: CreateRequest) => void | Promise<void>;
  onCancel: () => void;
  onBack: () => void;
}

// ─── Prompts ───

const PHASE1_PROMPT = `Output ONLY valid JSON. No markdown fences, no explanation.

You are designing a multi-agent meeting room. The user will describe what they want.
Generate a complete meeting room blueprint.

Required JSON (all string values, escape newlines as \\n):
{
  "title": "<meeting room name, concise>",
  "goal": "<1-2 sentences describing the meeting goal>",
  "policy": "<one of: free, roundRobin, moderator, debate, reactive>",
  "budget": <number 5-30, CNY budget>,
  "conflictMode": "<one of: review, debate, or empty string>",
  "roundBudget": <number 8-20, max conversation rounds>,
  "members": [
    {
      "role": "<short role title, 2-6 chars>",
      "emoji": "<one emoji>",
      "brief": "<one sentence: what this role does in this meeting>",
      "stance": "<one of: pro, con, neutral, or empty string>",
      "thinking": "<one of: off, low, medium, high, or empty string>",
      "isModerator": <true or false, at most one moderator>
    }
  ]
}

Rules:
- Generate 3-6 members based on user's description and team size hint
- Each role must be unique and specific to the meeting scenario
- At most 1 moderator
- policy should match the scenario (roundRobin for structured, free for brainstorm, moderator for review, debate for debate)
- budget scales with team size (small=10, medium=15, large=25)`;

function buildPhase2Prompt(role: string, brief: string, meetingTitle: string, meetingGoal: string): string {
  return `Output ONLY valid JSON. No markdown fences, no explanation.

You are creating a REALISTIC HUMAN PERSONA for a meeting room member.
This person must feel like a real human being — not an AI assistant.

Meeting: "${meetingTitle}"
Goal: ${meetingGoal}
Role: ${role}
Brief: ${brief}

Required JSON:
{
  "systemPrompt": "<detailed persona prompt, 300-600 chars, see rules below>",
  "stylePrompt": "<speaking style constraint, 50-150 chars, see rules below>"
}

systemPrompt rules:
- Give this person a realistic Chinese name, age (25-55), and background
- Describe their personality traits (e.g. direct, cautious, passionate, skeptical)
- Mention their professional strengths and blind spots
- Include a personal quirk or habit that makes them feel human
- Specify what they care about most in THIS meeting and what frustrates them
- They should have opinions, biases, and emotional reactions — not be neutral analyzers
- Example: "你是张明远，38岁，做了12年后端架构，性格直爽有时候说话不留情面。你最烦那种花里胡哨但跑不动的设计，遇到性能问题会直接怼回去。这次评审你主要盯着数据库设计和API契约，你觉得前端团队总是低估后端复杂度。你说话喜欢举实际踩过的坑来论证。"

stylePrompt rules:
- Describe HOW this person talks, not what they say
- Use natural human speech patterns: conversational, sometimes incomplete sentences, with emotion
- AVOID: bullet points, numbered lists, "首先/其次/最后" structure, formal report tone
- GOOD examples: "说话直来直去，喜欢用反问句，偶尔会吐槽，生气了会用感叹号"
- GOOD examples: "语气温和但观点坚定，喜欢用比喻解释复杂问题，会关心别人的感受"
- BAD examples: "用专业术语回复" "以要点列表格式输出" "保持客观中立"

All content in Chinese. Make this person REAL — with flaws, preferences, and genuine emotion.`;
}

// ─── Helpers ───

function fuzzyMatchRole(roleName: string, profiles: RoleProfile[]): RoleProfile | null {
  const norm = roleName.trim().toLowerCase();
  if (!norm) return null;
  // Exact match on role or name
  for (const p of profiles) {
    if ((p.role || '').trim().toLowerCase() === norm || (p.name || '').trim().toLowerCase() === norm) return p;
  }
  // Substring match
  for (const p of profiles) {
    const pr = (p.role || '').trim().toLowerCase();
    const pn = (p.name || '').trim().toLowerCase();
    if (pr && norm.includes(pr)) return p;
    if (pn && norm.includes(pn)) return p;
    if (pr && pr.includes(norm)) return p;
    if (pn && pn.includes(norm)) return p;
  }
  return null;
}

const VALID_POLICIES: RoomPolicy[] = ['free', 'roundRobin', 'moderator', 'debate', 'reactive', 'parallel'];

function sanitizeConfig(raw: any): AiConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const members: AiMember[] = [];
  if (Array.isArray(raw.members)) {
    for (const m of raw.members.slice(0, 8)) {
      if (!m || typeof m !== 'object' || !m.role) continue;
      members.push({
        role: String(m.role || '').slice(0, 30),
        emoji: String(m.emoji || '🤖').slice(0, 4),
        brief: String(m.brief || ''),
        stance: ['pro', 'con', 'neutral', ''].includes(m.stance) ? m.stance : '',
        thinking: ['off', 'low', 'medium', 'high', ''].includes(m.thinking) ? m.thinking : '',
        isModerator: !!m.isModerator,
        systemPrompt: '',
        stylePrompt: '',
        enriched: false,
        enriching: false,
      });
    }
  }
  if (members.length === 0) return null;
  // Ensure at most 1 moderator
  let modCount = 0;
  for (const m of members) {
    if (m.isModerator) { modCount++; if (modCount > 1) m.isModerator = false; }
  }
  return {
    title: String(raw.title || '').slice(0, 60) || 'AI 会议',
    goal: String(raw.goal || ''),
    policy: VALID_POLICIES.includes(raw.policy) ? raw.policy : 'free',
    budget: Math.max(5, Math.min(50, Number(raw.budget) || 10)),
    conflictMode: ['review', 'debate', ''].includes(raw.conflictMode) ? raw.conflictMode : '',
    roundBudget: Math.max(4, Math.min(30, Number(raw.roundBudget) || 12)),
    members,
  };
}

const inp = 'w-full h-9 px-2.5 rounded-lg bg-surface-raised border border-border sci-input text-[12px]';
const ta = 'w-full px-2.5 py-2 rounded-lg bg-surface-raised border border-border sci-input text-[11.5px] resize-y';
const sel = 'h-9 px-2 rounded-lg text-[12px] bg-surface-raised border border-border';

// ─── Component ───

const AiRoomPath: React.FC<Props> = ({ onCreate, onCancel, onBack }) => {
  const [phase, setPhase] = useState<AiPhase>('input');
  const [desc, setDesc] = useState('');
  const [teamSize, setTeamSize] = useState<'small' | 'medium' | 'large'>('medium');

  // AI streaming
  const [streaming, setStreaming] = useState('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bufRef = useRef('');
  const rafRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Generated config
  const [config, setConfig] = useState<AiConfig | null>(null);

  // Data
  const [roleProfiles, setRoleProfiles] = useState<RoleProfile[]>([]);
  const [systemModels, setSystemModels] = useState<SystemModel[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Phase 2 tracking
  const phase2Queue = useRef<number[]>([]);
  const phase2Running = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listRoleProfiles().catch(() => []),
      fetchSystemModels(false).catch(() => []),
    ]).then(([roles, models]) => {
      if (cancelled) return;
      setRoleProfiles(roles);
      setSystemModels(models);
    });
    return () => { cancelled = true; };
  }, []);

  // ── Phase 1: Generate team blueprint ──
  const startPhase1 = useCallback(() => {
    if (!desc.trim()) return;
    abortRef.current?.abort();
    bufRef.current = '';
    if (rafRef.current !== null) { clearTimeout(rafRef.current); rafRef.current = null; }
    setStreaming('');
    setError(null);
    setConfig(null);
    setPhase('phase1');

    const sizeHint = { small: '3-4', medium: '4-5', large: '5-7' }[teamSize];
    const fullPrompt = PHASE1_PROMPT +
      `\n\nUser request: ${desc.trim()}` +
      `\nTeam size: ${sizeHint} members` +
      '\nWrite all Chinese content (title, goal, role names, briefs).';

    abortRef.current = multiAgentApi.wizardStep2(
      {
        agentId: 'ai-room-gen',
        agentName: 'Room Generator',
        agentRole: 'meeting room designer',
        agentDesc: '',
        scenarioName: 'room-generation',
        language: 'Chinese',
        customPrompt: fullPrompt,
      },
      (token) => {
        bufRef.current += token;
        if (rafRef.current === null) {
          rafRef.current = setTimeout(() => {
            setStreaming(bufRef.current);
            rafRef.current = null;
          }, 30);
        }
      },
      () => {
        // Phase 1 done — parse
        const raw = bufRef.current.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        try {
          const parsed = JSON.parse(raw);
          const cfg = sanitizeConfig(parsed);
          if (!cfg) {
            setError('AI 返回的团队蓝图格式异常，请修改描述后重试');
            setPhase('input');
            return;
          }
          setConfig(cfg);
          // Show blueprint for user review before Phase 2
          setPhase('blueprint');
        } catch {
          setError('AI 返回内容解析失败，请修改描述后重试');
          setPhase('input');
        }
      },
      (_code, msg) => {
        setError(msg || '生成失败');
        setPhase('input');
      },
    );
  }, [desc, teamSize, roleProfiles]);

  // ── User confirms blueprint → match role library + start Phase 2 ──
  const startPhase2 = useCallback(() => {
    if (!config) return;
    const updated = { ...config, members: config.members.map(m => ({ ...m })) };
    const needEnrich: number[] = [];

    for (let i = 0; i < updated.members.length; i++) {
      const m = updated.members[i];
      const matched = fuzzyMatchRole(m.role, roleProfiles);
      if (matched && matched.systemPrompt) {
        m.systemPrompt = matched.systemPrompt;
        m.stylePrompt = matched.stylePrompt || '';
        m.matchedProfileId = matched.id;
        m.enriched = true;
        if (matched.emoji) m.emoji = matched.emoji;
        if (matched.thinking) m.thinking = matched.thinking;
        if (matched.stance) m.stance = matched.stance as any;
        if (matched.isModerator != null) m.isModerator = matched.isModerator;
      } else {
        needEnrich.push(i);
      }
    }
    setConfig(updated);

    if (needEnrich.length === 0) {
      setPhase('review');
      return;
    }

    setPhase('phase2');
    phase2Queue.current = needEnrich;
    phase2Running.current = false;
    runNextPhase2(updated, needEnrich, 0);
  }, [config, roleProfiles]);

  const runNextPhase2 = useCallback((cfg: AiConfig, queue: number[], idx: number) => {
    if (idx >= queue.length) {
      setPhase('review');
      return;
    }

    const memberIdx = queue[idx];
    const m = cfg.members[memberIdx];
    if (!m) { runNextPhase2(cfg, queue, idx + 1); return; }

    // Mark enriching
    setConfig(prev => {
      if (!prev) return prev;
      const next = { ...prev, members: prev.members.map((mm, i) => i === memberIdx ? { ...mm, enriching: true } : mm) };
      return next;
    });

    const prompt = buildPhase2Prompt(m.role, m.brief, cfg.title, cfg.goal);
    const p2Buf = { current: '' };

    multiAgentApi.wizardStep2(
      {
        agentId: `role-enrich-${memberIdx}`,
        agentName: m.role,
        agentRole: 'role enricher',
        agentDesc: '',
        scenarioName: 'role-enrichment',
        language: 'Chinese',
        customPrompt: prompt,
      },
      (token) => { p2Buf.current += token; },
      () => {
        const raw = p2Buf.current.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        let sp = m.brief; // fallback
        let sty = '';
        try {
          const parsed = JSON.parse(raw);
          if (parsed.systemPrompt) sp = parsed.systemPrompt;
          if (parsed.stylePrompt) sty = parsed.stylePrompt;
        } catch { /* use fallback */ }

        setConfig(prev => {
          if (!prev) return prev;
          const next = { ...prev, members: prev.members.map((mm, i) => i === memberIdx ? { ...mm, systemPrompt: sp, stylePrompt: sty, enriched: true, enriching: false } : mm) };
          // Check if this was the last — if so, auto-advance
          const allDone = next.members.every(mm => mm.enriched);
          if (allDone) setTimeout(() => setPhase('review'), 100);
          return next;
        });

        runNextPhase2(cfg, queue, idx + 1);
      },
      () => {
        // Error — use brief as fallback
        setConfig(prev => {
          if (!prev) return prev;
          return { ...prev, members: prev.members.map((mm, i) => i === memberIdx ? { ...mm, systemPrompt: mm.brief, enriched: true, enriching: false } : mm) };
        });
        runNextPhase2(cfg, queue, idx + 1);
      },
    );
  }, []);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    if (phase === 'phase2' && config) {
      // Phase 2 stopped midway — go to review with whatever we have
      setConfig(prev => {
        if (!prev) return prev;
        return { ...prev, members: prev.members.map(m => m.enriched ? m : { ...m, systemPrompt: m.systemPrompt || m.brief, enriched: true, enriching: false }) };
      });
      setPhase('review');
    } else {
      setPhase(config ? 'blueprint' : 'input');
    }
  }, [config, phase]);

  // ── Review: edit config ──
  const updateMember = useCallback((idx: number, patch: Partial<AiMember>) => {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, members: prev.members.map((m, i) => i === idx ? { ...m, ...patch } : m) };
    });
  }, []);

  const removeMember = useCallback((idx: number) => {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, members: prev.members.filter((_, i) => i !== idx) };
    });
  }, []);

  const addBlankMember = useCallback(() => {
    setConfig(prev => {
      if (!prev || prev.members.length >= 8) return prev;
      return { ...prev, members: [{
        role: '', emoji: '🤖', brief: '', stance: '', thinking: '',
        isModerator: false, systemPrompt: '', stylePrompt: '',
        enriched: false, enriching: false,
      }, ...prev.members] };
    });
  }, []);

  const addFromLibrary = useCallback((profileId: string) => {
    const profile = roleProfiles.find(p => p.id === profileId);
    if (!profile) return;
    setConfig(prev => {
      if (!prev || prev.members.length >= 8) return prev;
      return { ...prev, members: [{
        role: profile.role || profile.name || '',
        emoji: profile.emoji || '🤖',
        brief: profile.systemPrompt?.slice(0, 60) || '',
        stance: (profile.stance as string) || '',
        thinking: profile.thinking || '',
        isModerator: !!profile.isModerator,
        systemPrompt: profile.systemPrompt || '',
        stylePrompt: profile.stylePrompt || '',
        matchedProfileId: profile.id,
        enriched: true,
        enriching: false,
      }, ...prev.members] };
    });
  }, [roleProfiles]);

  // ── Save role to library ──
  const saveToLibrary = useCallback(async (idx: number) => {
    if (!config) return;
    const m = config.members[idx];
    if (!m) return;
    try {
      const saved = await createRoleProfile({
        name: m.role,
        role: m.role,
        emoji: m.emoji,
        systemPrompt: m.systemPrompt,
        stylePrompt: m.stylePrompt,
        stance: m.stance as any,
        thinking: m.thinking,
        isModerator: m.isModerator,
        visibility: 'private',
      });
      setRoleProfiles(prev => [saved, ...prev]);
      updateMember(idx, { matchedProfileId: saved.id });
    } catch { /* silent */ }
  }, [config, updateMember]);

  // ── Submit ──
  const submit = useCallback(async () => {
    if (!config || submitting) return;
    setSubmitting(true);
    try {
      await onCreate({
        kind: 'custom',
        title: config.title,
        goal: config.goal || undefined,
        members: config.members.map(m => ({
          role: m.role,
          roleProfileId: m.matchedProfileId,
          emoji: m.emoji,
          model: '',
          isModerator: m.isModerator,
          systemPrompt: m.systemPrompt,
          agentId: '',
          thinking: m.thinking,
        })),
        policy: config.policy,
        budgetCNY: config.budget,
        conflictMode: config.conflictMode || undefined,
        roundBudget: config.roundBudget > 0 ? config.roundBudget : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  }, [config, submitting, onCreate]);

  const enrichedCount = config?.members.filter(m => m.enriched).length ?? 0;
  const totalMembers = config?.members.length ?? 0;

  return (
    <>
      {/* Header */}
      <div className="shrink-0 px-5 py-4 border-b border-border flex items-center gap-3 bg-gradient-to-r from-violet-500/5 via-fuchsia-500/5 to-purple-500/5">
        <button onClick={onBack} className="w-8 h-8 rounded-md hover:bg-surface-sunken flex items-center justify-center text-text-secondary" title="返回">
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
        </button>
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-[0_4px_12px_rgba(139,92,246,0.3)]">
          <span className="material-symbols-outlined text-white text-[22px]">auto_awesome</span>
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-bold text-text truncate">AI 一句话建会</h2>
          <p className="text-[11px] text-text-secondary truncate">
            {phase === 'input' && '描述你的会议场景，AI 帮你搭团队'}
            {phase === 'phase1' && '正在生成团队蓝图…'}
            {phase === 'blueprint' && '团队蓝图已就绪 · 确认后生成角色人设'}
            {phase === 'phase2' && `正在生成角色人设 (${enrichedCount}/${totalMembers})`}
            {phase === 'review' && '检查与微调 · 确认后启动'}
          </p>
        </div>
        {(phase === 'phase1' || phase === 'phase2') && config && (
          <button onClick={stopGeneration} className="shrink-0 inline-flex items-center gap-1 px-2.5 h-7 rounded-lg text-[10.5px] font-semibold bg-danger/10 hover:bg-danger/15 text-danger border border-danger/20 transition-all">
            <span className="material-symbols-outlined text-[13px]">stop</span>停止
          </button>
        )}
        <button onClick={onCancel} className="w-8 h-8 rounded-md hover:bg-surface-sunken flex items-center justify-center text-text-secondary" title="关闭">
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto neon-scrollbar p-5">

        {/* ── Input phase ── */}
        {phase === 'input' && (
          <div className="max-w-2xl mx-auto space-y-5">
            <div className="text-center mb-2">
              <div className="inline-flex w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 items-center justify-center shadow-[0_8px_24px_rgba(139,92,246,0.3)] mb-3">
                <span className="material-symbols-outlined text-white text-[28px]">magic_button</span>
              </div>
              <h3 className="text-[15px] font-bold text-text">描述你的会议场景</h3>
              <p className="text-[12px] text-text-secondary mt-1">AI 会自动生成标题、目标、成员阵容和发言策略</p>
            </div>
            <div className="space-y-1">
              <span className="text-[11.5px] font-semibold text-text">场景描述</span>
              <textarea
                value={desc}
                onChange={e => setDesc(e.target.value)}
                placeholder="例如：帮我做一次代码架构评审，需要前端、后端、安全三个视角，重点关注性能和可扩展性"
                rows={4}
                className={`${ta} min-h-[80px]`}
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <span className="text-[11.5px] font-semibold text-text">团队规模</span>
              <div className="flex gap-2">
                {([['small', '小 (3-4人)', 'group'], ['medium', '中 (4-5人)', 'groups'], ['large', '大 (5-7人)', 'groups_3']] as const).map(([size, label, icon]) => (
                  <button
                    key={size}
                    onClick={() => setTeamSize(size)}
                    className={`flex-1 h-10 rounded-lg border text-[12px] font-semibold flex items-center justify-center gap-1.5 transition-all ${
                      teamSize === size
                        ? 'border-violet-400 bg-violet-500/10 text-violet-600 dark:text-violet-400'
                        : 'border-border bg-surface hover:bg-surface-raised text-text-secondary'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[16px]">{icon}</span>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {error && (
              <div className="rounded-lg bg-danger/10 border border-danger/20 p-3 text-[11.5px] text-danger flex items-start gap-2">
                <span className="material-symbols-outlined text-[16px] mt-0.5 shrink-0">error</span>
                <span>{error}</span>
              </div>
            )}
          </div>
        )}

        {/* ── Phase 1: streaming ── */}
        {phase === 'phase1' && (
          <div className="max-w-2xl mx-auto space-y-4">
            <div className="text-center">
              <span className="material-symbols-outlined text-[36px] text-violet-500 animate-spin">progress_activity</span>
              <h3 className="text-[14px] font-bold text-text mt-2">正在生成团队蓝图</h3>
              <p className="text-[11.5px] text-text-muted mt-1">AI 正在分析你的场景并设计最佳团队组合…</p>
            </div>
            {streaming && (
              <div className="max-h-48 overflow-y-auto rounded-xl bg-surface-sunken/60 border border-border p-3 text-[10.5px] text-text-secondary font-mono whitespace-pre-wrap neon-scrollbar">
                {streaming}
              </div>
            )}
          </div>
        )}

        {/* ── Blueprint: preview & edit team structure ── */}
        {phase === 'blueprint' && config && (
          <div className="max-w-2xl mx-auto space-y-4">
            <div className="text-center mb-2">
              <div className="inline-flex w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-500 items-center justify-center shadow-[0_6px_20px_rgba(16,185,129,0.3)] mb-3">
                <span className="material-symbols-outlined text-white text-[24px]">checklist</span>
              </div>
              <h3 className="text-[15px] font-bold text-text">团队蓝图已就绪</h3>
              <p className="text-[12px] text-text-secondary mt-1">所有内容均可修改，确认后生成角色人设</p>
            </div>

            {/* ─ Room meta (editable) ─ */}
            <div className="rounded-xl border border-border bg-surface-sunken/30 p-3.5 space-y-3">
              <div className="flex items-center gap-2 text-[12px] font-bold text-text">
                <span className="material-symbols-outlined text-[16px] text-violet-500">meeting_room</span>会议概要
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <span className="text-[10.5px] font-semibold text-text-secondary">房间名称</span>
                  <input
                    value={config.title}
                    onChange={e => setConfig(prev => prev ? { ...prev, title: e.target.value } : prev)}
                    className={inp}
                    placeholder="会议名称"
                  />
                </div>
                <div className="space-y-1">
                  <span className="text-[10.5px] font-semibold text-text-secondary">发言策略</span>
                  <CustomSelect
                    value={config.policy}
                    onChange={v => setConfig(prev => prev ? { ...prev, policy: (v || 'free') as RoomPolicy } : prev)}
                    options={VALID_POLICIES.map(p => ({ value: p, label: POLICY_META[p]?.label || p }))}
                    className={sel}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-[10.5px] font-semibold text-text-secondary">目标</span>
                <textarea
                  value={config.goal}
                  onChange={e => setConfig(prev => prev ? { ...prev, goal: e.target.value } : prev)}
                  rows={2}
                  className={`${ta} min-h-[48px]`}
                  placeholder="本次会议要达成的目标"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <span className="text-[10.5px] font-semibold text-text-secondary">预算 (¥)</span>
                  <input
                    value={config.budget}
                    onChange={e => {
                      const v = e.target.value.replace(/[^0-9]/g, '');
                      setConfig(prev => prev ? { ...prev, budget: Math.max(1, Number(v) || 1) } : prev);
                    }}
                    inputMode="numeric"
                    className={inp}
                  />
                </div>
                <div className="space-y-1">
                  <span className="text-[10.5px] font-semibold text-text-secondary">轮次上限</span>
                  <input
                    value={config.roundBudget}
                    onChange={e => {
                      const v = e.target.value.replace(/[^0-9]/g, '');
                      setConfig(prev => prev ? { ...prev, roundBudget: Math.max(4, Number(v) || 4) } : prev);
                    }}
                    inputMode="numeric"
                    className={inp}
                  />
                </div>
                <div className="space-y-1">
                  <span className="text-[10.5px] font-semibold text-text-secondary">冲突模式</span>
                  <CustomSelect
                    value={config.conflictMode}
                    onChange={v => setConfig(prev => prev ? { ...prev, conflictMode: (v || '') as '' | 'review' | 'debate' } : prev)}
                    options={[{ value: '', label: '无' }, { value: 'review', label: '评审' }, { value: 'debate', label: '辩论' }]}
                    className={sel}
                  />
                </div>
              </div>
            </div>

            {/* ─ Members (fully editable) ─ */}
            <div className="rounded-xl border border-border bg-surface-sunken/30 p-3.5 space-y-3">
              <div className="flex items-center gap-2 text-[12px] font-bold text-text">
                <span className="material-symbols-outlined text-[16px] text-fuchsia-500">groups</span>成员阵容
                <span className="ms-auto text-[10.5px] text-text-muted font-normal">{config.members.length} / 8 人</span>
              </div>

              {/* Add from role library */}
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <CustomSelect
                    value=""
                    onChange={v => { if (v) addFromLibrary(v); }}
                    options={[
                      { value: '', label: roleProfiles.length > 0 ? '从角色库快速加人…' : '暂无角色库角色' },
                      ...roleProfiles.map(p => ({
                        value: p.id,
                        label: `${p.emoji || '🤖'} ${p.role || p.name}${p.category ? ` · ${p.category}` : ''}`,
                      })),
                    ]}
                    className="h-8 w-full px-2 rounded-lg bg-surface border border-border text-[11.5px]"
                  />
                </div>
                <button
                  onClick={addBlankMember}
                  disabled={config.members.length >= 8}
                  className="shrink-0 h-8 px-2.5 rounded-lg border border-border bg-surface hover:bg-violet-500/10 hover:border-violet-400/50 hover:text-violet-500 text-text-secondary text-[11px] font-semibold inline-flex items-center gap-1 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span className="material-symbols-outlined text-[14px]">person_add</span>
                  新增
                </button>
              </div>

              {/* Member cards */}
              <div className="space-y-2.5">
                {config.members.map((m, i) => (
                  <div key={i} className="rounded-xl border border-border bg-surface p-3 space-y-2">
                    {/* Row 1: emoji + role name + tags + delete */}
                    <div className="flex items-center gap-2">
                      <input
                        value={m.emoji}
                        onChange={e => updateMember(i, { emoji: e.target.value })}
                        className="w-9 h-8 text-center rounded bg-surface-raised border border-border text-[16px]"
                      />
                      <input
                        value={m.role}
                        onChange={e => updateMember(i, { role: e.target.value })}
                        className="flex-1 h-8 px-2 rounded bg-surface-raised border border-border text-[12px] font-bold"
                        placeholder="角色名"
                      />
                      {/* Moderator toggle */}
                      <button
                        onClick={() => {
                          if (m.isModerator) {
                            updateMember(i, { isModerator: false });
                          } else {
                            // Only allow 1 moderator
                            setConfig(prev => {
                              if (!prev) return prev;
                              return { ...prev, members: prev.members.map((mm, j) => ({
                                ...mm, isModerator: j === i,
                              })) };
                            });
                          }
                        }}
                        className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-semibold transition-colors ${
                          m.isModerator
                            ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400 ring-1 ring-amber-400/40'
                            : 'bg-surface-raised text-text-muted hover:bg-amber-500/10 hover:text-amber-600'
                        }`}
                        title={m.isModerator ? '取消主持人' : '设为主持人'}
                      >
                        ★ 主持
                      </button>
                      {/* Stance selector */}
                      <CustomSelect
                        value={m.stance}
                        onChange={v => updateMember(i, { stance: v })}
                        options={[
                          { value: '', label: '无立场' },
                          { value: 'pro', label: '支持方' },
                          { value: 'con', label: '反对方' },
                          { value: 'neutral', label: '中立' },
                        ]}
                        className={`shrink-0 h-7 px-1 rounded-md text-[10px] font-semibold border ${
                          m.stance === 'pro' ? 'bg-success/10 text-success border-success/30'
                          : m.stance === 'con' ? 'bg-danger/10 text-danger border-danger/30'
                          : m.stance === 'neutral' ? 'bg-info/10 text-info border-info/30'
                          : 'bg-surface-raised text-text-muted border-border'
                        }`}
                      />
                      {/* Thinking selector */}
                      <CustomSelect
                        value={m.thinking}
                        onChange={v => updateMember(i, { thinking: v })}
                        options={[
                          { value: '', label: '思考:默认' },
                          { value: 'off', label: '思考:关' },
                          { value: 'low', label: '思考:低' },
                          { value: 'medium', label: '思考:中' },
                          { value: 'high', label: '思考:高' },
                        ]}
                        className="shrink-0 h-7 px-1 rounded-md text-[10px] font-semibold bg-surface-raised border border-border text-text-secondary"
                      />
                      <button
                        onClick={() => removeMember(i)}
                        disabled={config.members.length <= 1}
                        className="w-7 h-7 rounded flex items-center justify-center hover:bg-danger/10 text-text-muted hover:text-danger transition-colors disabled:opacity-30"
                      >
                        <span className="material-symbols-outlined text-[14px]">close</span>
                      </button>
                    </div>
                    {/* Row 2: brief (editable) */}
                    <textarea
                      value={m.brief}
                      onChange={e => updateMember(i, { brief: e.target.value })}
                      rows={1}
                      placeholder="角色职责简述（用于生成人设时的参考）"
                      className="w-full px-2 py-1.5 rounded bg-surface-raised border border-border text-[11px] text-text-secondary resize-y min-h-[28px]"
                    />
                    {m.matchedProfileId && (
                      <span className="inline-flex text-[10px] px-1.5 py-0.5 rounded-full bg-info/15 text-info font-semibold">已匹配角色库</span>
                    )}
                  </div>
                ))}
              </div>

              {config.members.length === 0 && (
                <div className="text-center text-[12px] text-text-muted py-6 rounded-xl border-2 border-dashed border-border">
                  <span className="material-symbols-outlined text-[24px] opacity-40 block mb-1">group_add</span>
                  从上方角色库选择角色，或新增一个空白角色
                </div>
              )}
            </div>

            {/* Tip */}
            <div className="rounded-lg bg-info/5 border border-info/20 p-2.5 text-[10.5px] text-info flex items-start gap-2">
              <span className="material-symbols-outlined text-[14px] mt-0.5 shrink-0">info</span>
              <span>下一步将为每个角色生成详细的人物设定（年龄、性格、专长、说话风格等），让角色像真实的人类一样思考和发言。已匹配角色库的角色将直接复用现有设定。</span>
            </div>
          </div>
        )}

        {/* ── Phase 2: enriching roles ── */}
        {phase === 'phase2' && config && (
          <div className="max-w-2xl mx-auto space-y-4">
            <div className="text-center mb-2">
              <h3 className="text-[14px] font-bold text-text">正在生成角色人设</h3>
              <p className="text-[11.5px] text-text-muted mt-1">
                为每个角色赋予真实人类的个性与风格 · {enrichedCount} / {totalMembers}
              </p>
              <div className="mt-3 mx-auto w-48 h-1.5 rounded-full bg-surface-sunken overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-500"
                  style={{ width: `${totalMembers > 0 ? (enrichedCount / totalMembers) * 100 : 0}%` }}
                />
              </div>
            </div>
            <div className="space-y-2">
              {config.members.map((m, i) => (
                <div key={i} className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all ${
                  m.enriched ? 'border-success/30 bg-success/5' : m.enriching ? 'border-violet-400/40 bg-violet-500/5' : 'border-border bg-surface-sunken/30'
                }`}>
                  <span className="text-[18px]">{m.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-semibold text-text">{m.role}</div>
                    <div className="text-[10.5px] text-text-muted truncate">{m.brief}</div>
                  </div>
                  {m.matchedProfileId && (
                    <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-info/15 text-info font-semibold">已匹配角色库</span>
                  )}
                  {m.enriching && <span className="material-symbols-outlined text-[16px] text-violet-500 animate-spin shrink-0">progress_activity</span>}
                  {m.enriched && !m.matchedProfileId && <span className="material-symbols-outlined text-[16px] text-success shrink-0">check_circle</span>}
                  {!m.enriched && !m.enriching && <span className="material-symbols-outlined text-[16px] text-text-disabled shrink-0">hourglass_empty</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Review phase ── */}
        {phase === 'review' && config && (
          <div className="max-w-2xl mx-auto space-y-4">
            {/* Room meta */}
            <div className="rounded-xl border border-border bg-surface-sunken/30 p-3.5 space-y-3">
              <div className="flex items-center gap-2 text-[12px] font-bold text-text">
                <span className="material-symbols-outlined text-[16px] text-violet-500">meeting_room</span>会议概要
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <span className="text-[10.5px] font-semibold text-text-secondary">房间名称</span>
                  <input
                    value={config.title}
                    onChange={e => setConfig(prev => prev ? { ...prev, title: e.target.value } : prev)}
                    className={inp}
                  />
                </div>
                <div className="space-y-1">
                  <span className="text-[10.5px] font-semibold text-text-secondary">发言策略</span>
                  <CustomSelect
                    value={config.policy}
                    onChange={v => setConfig(prev => prev ? { ...prev, policy: (v || 'free') as RoomPolicy } : prev)}
                    options={VALID_POLICIES.map(p => ({ value: p, label: POLICY_META[p]?.label || p }))}
                    className={sel}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-[10.5px] font-semibold text-text-secondary">目标</span>
                <textarea
                  value={config.goal}
                  onChange={e => setConfig(prev => prev ? { ...prev, goal: e.target.value } : prev)}
                  rows={2}
                  className={`${ta} min-h-[48px]`}
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <span className="text-[10.5px] font-semibold text-text-secondary">预算 (¥)</span>
                  <input
                    value={config.budget}
                    onChange={e => {
                      const v = e.target.value.replace(/[^0-9]/g, '');
                      setConfig(prev => prev ? { ...prev, budget: Math.max(1, Number(v) || 1) } : prev);
                    }}
                    inputMode="numeric"
                    className={inp}
                  />
                </div>
                <div className="space-y-1">
                  <span className="text-[10.5px] font-semibold text-text-secondary">轮次上限</span>
                  <input
                    value={config.roundBudget}
                    onChange={e => {
                      const v = e.target.value.replace(/[^0-9]/g, '');
                      setConfig(prev => prev ? { ...prev, roundBudget: Math.max(4, Number(v) || 4) } : prev);
                    }}
                    inputMode="numeric"
                    className={inp}
                  />
                </div>
                <div className="space-y-1">
                  <span className="text-[10.5px] font-semibold text-text-secondary">冲突模式</span>
                  <CustomSelect
                    value={config.conflictMode}
                    onChange={v => setConfig(prev => prev ? { ...prev, conflictMode: (v || '') as '' | 'review' | 'debate' } : prev)}
                    options={[{ value: '', label: '无' }, { value: 'review', label: '评审' }, { value: 'debate', label: '辩论' }]}
                    className={sel}
                  />
                </div>
              </div>
            </div>

            {/* Members */}
            <div className="rounded-xl border border-border bg-surface-sunken/30 p-3.5 space-y-3">
              <div className="flex items-center gap-2 text-[12px] font-bold text-text">
                <span className="material-symbols-outlined text-[16px] text-fuchsia-500">groups</span>成员阵容
                <span className="ms-auto text-[10.5px] text-text-muted font-normal">{config.members.length} 人</span>
              </div>
              <div className="space-y-2.5">
                {config.members.map((m, i) => (
                  <div key={i} className="rounded-lg border border-border bg-surface p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        value={m.emoji}
                        onChange={e => updateMember(i, { emoji: e.target.value })}
                        className="w-10 h-8 text-center rounded bg-surface-raised border border-border text-[14px]"
                      />
                      <input
                        value={m.role}
                        onChange={e => updateMember(i, { role: e.target.value })}
                        className="flex-1 h-8 px-2 rounded bg-surface-raised border border-border text-[12px] font-semibold"
                        placeholder="角色名"
                      />
                      {m.isModerator && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold">主持</span>}
                      {m.matchedProfileId ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-info/15 text-info font-semibold">已匹配角色库</span>
                      ) : (
                        <button
                          onClick={() => saveToLibrary(i)}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 hover:bg-violet-500/20 text-violet-600 dark:text-violet-400 font-semibold transition-colors"
                          title="保存到角色库"
                        >
                          保存到角色库
                        </button>
                      )}
                      <button
                        onClick={() => removeMember(i)}
                        disabled={config.members.length <= 1}
                        className="w-7 h-7 rounded flex items-center justify-center hover:bg-danger/10 text-text-muted hover:text-danger transition-colors disabled:opacity-30"
                      >
                        <span className="material-symbols-outlined text-[14px]">close</span>
                      </button>
                    </div>
                    <textarea
                      value={m.systemPrompt}
                      onChange={e => updateMember(i, { systemPrompt: e.target.value })}
                      rows={2}
                      placeholder="系统提示词"
                      className="w-full px-2 py-1.5 rounded bg-surface-raised border border-border text-[11px] resize-y min-h-[40px]"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 flex items-center gap-2 px-5 py-3 border-t border-border bg-surface-sunken/40">
        <button
          onClick={() => {
            abortRef.current?.abort();
            if (phase === 'review') setPhase('blueprint');
            else if (phase === 'blueprint') setPhase('input');
            else if (phase === 'phase2') { stopGeneration(); }
            else onBack();
          }}
          className="inline-flex items-center gap-1 px-3 h-9 rounded-lg text-[12px] font-semibold bg-surface hover:bg-surface-raised border border-border"
        >
          <span className="material-symbols-outlined text-[15px]">arrow_back</span>
          {phase === 'input' ? '返回' : phase === 'blueprint' ? '重新描述' : phase === 'review' ? '返回蓝图' : '停止'}
        </button>
        <div className="flex-1" />
        {phase === 'input' && (
          <button
            onClick={startPhase1}
            disabled={!desc.trim()}
            className={`inline-flex items-center gap-1.5 px-4 h-9 rounded-lg text-[12px] font-bold transition-all ${
              !desc.trim()
                ? 'bg-surface-sunken text-text-muted cursor-not-allowed'
                : 'bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-[0_2px_8px_rgba(139,92,246,0.3)] hover:shadow-[0_4px_16px_rgba(139,92,246,0.5)]'
            }`}
          >
            <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
            生成团队
          </button>
        )}
        {phase === 'blueprint' && (
          <button
            onClick={startPhase2}
            disabled={!config || config.members.length === 0 || !config.title.trim()}
            className={`inline-flex items-center gap-1.5 px-4 h-9 rounded-lg text-[12px] font-bold transition-all ${
              !config || config.members.length === 0 || !config.title.trim()
                ? 'bg-surface-sunken text-text-muted cursor-not-allowed'
                : 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-[0_2px_8px_rgba(16,185,129,0.3)] hover:shadow-[0_4px_16px_rgba(16,185,129,0.5)]'
            }`}
          >
            <span className="material-symbols-outlined text-[16px]">person_search</span>
            生成角色人设
          </button>
        )}
        {phase === 'review' && (
          <button
            onClick={submit}
            disabled={submitting || !config || config.members.length === 0}
            className={`inline-flex items-center gap-1.5 px-4 h-9 rounded-lg text-[12px] font-bold transition-all ${
              submitting || !config || config.members.length === 0
                ? 'bg-surface-sunken text-text-muted cursor-not-allowed'
                : 'bg-gradient-to-r from-cyan-500 to-blue-500 text-white shadow-[0_2px_8px_rgba(0,200,255,0.3)] hover:shadow-[0_4px_16px_rgba(0,200,255,0.5)]'
            }`}
          >
            {submitting ? '创建中…' : '启动房间'}
            {submitting ? (
              <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
            ) : (
              <span className="material-symbols-outlined text-[16px]">rocket_launch</span>
            )}
          </button>
        )}
      </div>
    </>
  );
};

export default AiRoomPath;
