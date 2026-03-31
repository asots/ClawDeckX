import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Language } from '../../types';
import { getTranslation } from '../../locales';
import {
  multiAgentApi,
  MultiAgentGenerateResult,
  MultiAgentDeployRequest,
  gwApi,
} from '../../services/api';
import { useToast } from '../Toast';
import { resolveTemplateColor } from '../../utils/templateColors';
import { subscribeManagerWS } from '../../services/manager-ws';

interface ScenarioTeamBuilderProps {
  language: Language;
  onClose: () => void;
  onReadyToDeploy: (deployRequest: MultiAgentDeployRequest, reasoning: string) => void;
}

type BuilderStep = 'input' | 'prompt-review' | 'generating' | 'preview' | 'edit-agent';

interface AgentEdit {
  id: string;
  name: string;
  role: string;
  description: string;
  soul: string;
  agentsMd: string;
  userMd: string;
  identityMd: string;
  heartbeat: string;
  icon: string;
  color: string;
}

interface ScenarioTemplate {
  icon: string;
  color: string;
  nameKey: string;
  descKey: string;
  workflowType: 'collaborative' | 'sequential' | 'parallel' | 'routing';
  teamSize: 'small' | 'medium' | 'large';
  name: string;
  desc: string;
}

const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  { icon: 'code', color: 'from-blue-500 to-cyan-500', nameKey: 'tpl_softdev_name', descKey: 'tpl_softdev_desc', workflowType: 'collaborative', teamSize: 'medium', name: 'Software Dev Team', desc: 'Full-stack software development team with PM, architects, frontend/backend devs and QA. Responsible for requirement analysis, system design, coding, code review, testing, and delivery management.' },
  { icon: 'campaign', color: 'from-pink-500 to-rose-500', nameKey: 'tpl_marketing_name', descKey: 'tpl_marketing_desc', workflowType: 'parallel', teamSize: 'medium', name: 'Content Marketing', desc: 'Content creation and marketing team producing SEO articles, social media posts, email newsletters, and marketing copy. Handles content strategy, writing, editing, distribution, and analytics.' },
  { icon: 'support_agent', color: 'from-green-500 to-emerald-500', nameKey: 'tpl_support_name', descKey: 'tpl_support_desc', workflowType: 'routing', teamSize: 'medium', name: 'Customer Support', desc: 'Multi-tier customer support team handling inbound requests through triage, L1/L2/L3 specialists, and escalation management. Focus on fast resolution, knowledge base maintenance, and CSAT improvement.' },
  { icon: 'science', color: 'from-violet-500 to-purple-500', nameKey: 'tpl_research_name', descKey: 'tpl_research_desc', workflowType: 'sequential', teamSize: 'medium', name: 'Research Team', desc: 'Academic or market research team with lead researcher, domain experts, data analysts, and critical reviewers. Conducts literature review, data collection, analysis, and report writing.' },
  { icon: 'storefront', color: 'from-orange-500 to-amber-500', nameKey: 'tpl_ecommerce_name', descKey: 'tpl_ecommerce_desc', workflowType: 'collaborative', teamSize: 'large', name: 'E-Commerce Operations', desc: 'E-commerce operations team managing product listings, pricing strategy, inventory, customer service, promotions, and analytics. Covers the full order-to-fulfillment workflow.' },
  { icon: 'school', color: 'from-teal-500 to-cyan-500', nameKey: 'tpl_education_name', descKey: 'tpl_education_desc', workflowType: 'sequential', teamSize: 'small', name: 'Education Content', desc: 'Online education content team creating courses, quizzes, video scripts, and learning materials. Roles include instructional designer, subject matter expert, writer, and quality reviewer.' },
  { icon: 'account_balance', color: 'from-slate-500 to-gray-600', nameKey: 'tpl_finance_name', descKey: 'tpl_finance_desc', workflowType: 'sequential', teamSize: 'medium', name: 'Financial Analysis', desc: 'Financial analysis team covering market research, financial modeling, risk assessment, portfolio analysis, and investment reporting. Produces detailed research reports and recommendations.' },
  { icon: 'build', color: 'from-indigo-500 to-blue-600', nameKey: 'tpl_devops_name', descKey: 'tpl_devops_desc', workflowType: 'collaborative', teamSize: 'small', name: 'DevOps Team', desc: 'DevOps and SRE team managing CI/CD pipelines, infrastructure as code, monitoring, incident response, and deployment automation. Ensures system reliability, security, and scalability.' },
];

const WORKFLOW_TYPES = [
  { value: 'collaborative', icon: 'hub', labelKey: 'workflowCollaborative' },
  { value: 'sequential', icon: 'linear_scale', labelKey: 'workflowSequential' },
  { value: 'parallel', icon: 'call_split', labelKey: 'workflowParallel' },
  { value: 'routing', icon: 'route', labelKey: 'workflowRouting' },
] as const;

const TEAM_SIZES = [
  { value: 'small', range: '3-4', icon: 'group' },
  { value: 'medium', range: '5-7', icon: 'groups' },
  { value: 'large', range: '8-10', icon: 'diversity_3' },
] as const;

const ScenarioTeamBuilder: React.FC<ScenarioTeamBuilderProps> = ({
  language,
  onClose,
  onReadyToDeploy,
}) => {
  const t = useMemo(() => getTranslation(language) as any, [language]);
  const ma = (t.multiAgent || {}) as any;
  const stb = (t.scenarioTeamBuilder || {}) as any;
  const { toast } = useToast();

  const [step, setStep] = useState<BuilderStep>('input');
  const [scenarioName, setScenarioName] = useState('');
  const [description, setDescription] = useState('');
  const [teamSize, setTeamSize] = useState<'small' | 'medium' | 'large'>('medium');
  const [workflowType, setWorkflowType] = useState<'sequential' | 'parallel' | 'collaborative' | 'event-driven' | 'routing'>('collaborative');
  const [generateResult, setGenerateResult] = useState<MultiAgentGenerateResult | null>(null);
  const [editingAgent, setEditingAgent] = useState<AgentEdit | null>(null);
  const [editedAgents, setEditedAgents] = useState<Record<string, AgentEdit>>({});
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'agents' | 'workflow' | 'reasoning'>('agents');
  const [editablePrompt, setEditablePrompt] = useState('');

  // Generation progress phases
  type GenPhase = 'connecting' | 'sending' | 'thinking' | 'parsing' | 'done';
  const [genPhase, setGenPhase] = useState<GenPhase>('connecting');
  const genTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Server-confirmed elapsed seconds (from gen_progress WS events)
  const [genServerElapsed, setGenServerElapsed] = useState(0);
  // Client-side fallback elapsed ticker
  const [genClientElapsed, setGenClientElapsed] = useState(0);
  const genStartRef = useRef<number>(0);
  // True once we've received at least one server-side gen_progress event
  const genServerActiveRef = useRef(false);
  // SessionKey received from backend gen_progress — used to subscribe to chat deltas
  const genSessionKeyRef = useRef<string>('');
  // Live streaming token preview text
  const [genStreamText, setGenStreamText] = useState('');
  const genStreamBufRef = useRef('');
  const genStreamRafRef = useRef<number | null>(null);
  // WS-pushed error during generating (errorCode + errorMsg from gen_progress phase=error)
  const [genWsError, setGenWsError] = useState<{ code: string; msg: string } | null>(null);

  // Client-side elapsed ticker — always running during generating, as fallback
  useEffect(() => {
    if (step !== 'generating') {
      setGenClientElapsed(0);
      genStartRef.current = 0;
      genServerActiveRef.current = false;
      genSessionKeyRef.current = '';
      genStreamBufRef.current = '';
      if (genStreamRafRef.current !== null) { clearTimeout(genStreamRafRef.current); genStreamRafRef.current = null; }
      setGenStreamText('');
      setGenWsError(null);
      return;
    }
    genStartRef.current = Date.now();
    setGenClientElapsed(0);
    const iv = setInterval(() => {
      setGenClientElapsed(Math.floor((Date.now() - genStartRef.current) / 1000));
    }, 1000);
    return () => clearInterval(iv);
  }, [step]);

  // Subscribe to gen_progress + chat delta WS events from backend
  useEffect(() => {
    if (step !== 'generating') return;
    const unsub = subscribeManagerWS((msg: any) => {
      if (msg?.type === 'gen_progress') {
        const { elapsed, phase, sessionKey: sk, errorCode, errorMsg } = msg.data ?? {};
        if (typeof sk === 'string' && sk) genSessionKeyRef.current = sk;
        if (typeof elapsed === 'number') {
          setGenServerElapsed(elapsed);
          genServerActiveRef.current = true;
        }
        if (phase === 'thinking') setGenPhase('thinking');
        if (phase === 'parsing') setGenPhase('parsing');
        if (phase === 'error' && errorCode) {
          // Backend pushed error via WS — show immediately without waiting for HTTP response
          setGenWsError({ code: errorCode, msg: errorMsg || errorCode });
        }
        return;
      }
      // Live token streaming: chat delta events for our generation session
      if (msg?.type === 'chat' && msg.data?.state === 'delta') {
        const sk = msg.data?.sessionKey || msg.data?.key || '';
        // Accept if: (a) sessionKey already confirmed via gen_progress, or
        // (b) session key matches the generation label pattern (__gen_team_)
        // This handles the race where deltas arrive before the first gen_progress event.
        const isOurSession = genSessionKeyRef.current
          ? sk === genSessionKeyRef.current
          : typeof sk === 'string' && sk.includes('__gen_team_');
        if (!isOurSession) return;
        // Latch the sessionKey if not yet set
        if (!genSessionKeyRef.current && sk) genSessionKeyRef.current = sk;
        const text = (() => {
          const content = msg.data?.message?.content ?? msg.data?.message;
          if (typeof content === 'string') return content;
          if (Array.isArray(content)) {
            return content
              .filter((b: any) => b?.type === 'text')
              .map((b: any) => b.text || '')
              .join('');
          }
          return '';
        })();
        if (text) {
          genStreamBufRef.current += text;
          // Throttle setState to ~60fps
          if (genStreamRafRef.current === null) {
            genStreamRafRef.current = window.setTimeout(() => {
              setGenStreamText(genStreamBufRef.current);
              genStreamRafRef.current = null;
            }, 16);
          }
          setGenPhase('thinking');
        }
      }
    });
    return unsub;
  }, [step]);

  // Displayed elapsed = server value if we've heard from server, else client fallback
  const genElapsed = genServerActiveRef.current ? genServerElapsed : genClientElapsed;

  // Dropdowns for team size / workflow
  const [teamSizeOpen, setTeamSizeOpen] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const teamSizeRef = useRef<HTMLDivElement>(null);
  const workflowRef = useRef<HTMLDivElement>(null);

  // Template picker
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const templatePickerRef = useRef<HTMLDivElement>(null);

  // Model selector
  const [selectedModel, setSelectedModel] = useState('');
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  // Load configured models on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const gwCfg = await gwApi.configGet().catch(() => null);
        if (cancelled) return;
        const cfg = gwCfg as any;
        const providers = cfg?.models?.providers || cfg?.parsed?.models?.providers || cfg?.config?.models?.providers || {};
        const opts: { value: string; label: string }[] = [];
        const seen = new Set<string>();
        for (const [pName, pCfg] of Object.entries(providers) as [string, any][]) {
          const pModels = Array.isArray(pCfg?.models) ? pCfg.models : [];
          for (const m of pModels) {
            const id = typeof m === 'string' ? m : m?.id;
            if (!id) continue;
            const path = `${pName}/${id}`;
            if (seen.has(path)) continue;
            seen.add(path);
            const name = typeof m === 'object' && m?.name ? m.name : id;
            opts.push({ value: path, label: `${pName} / ${name}` });
          }
        }
        setModelOptions(opts);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (templatePickerRef.current && !templatePickerRef.current.contains(e.target as Node)) setTemplatePickerOpen(false);
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) setModelPickerOpen(false);
      if (teamSizeRef.current && !teamSizeRef.current.contains(e.target as Node)) setTeamSizeOpen(false);
      if (workflowRef.current && !workflowRef.current.contains(e.target as Node)) setWorkflowOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleApplyTemplate = useCallback((tpl: ScenarioTemplate) => {
    setScenarioName(stb[tpl.nameKey] || tpl.name);
    setDescription(stb[tpl.descKey] || tpl.desc);
    setWorkflowType(tpl.workflowType);
    setTeamSize(tpl.teamSize);
    setTemplatePickerOpen(false);
  }, [stb]);

  const buildPrompt = useCallback(() => {
    const agentCountHint = teamSize === 'small' ? '3 to 4' : teamSize === 'large' ? '8 to 10' : '5 to 7';
    const langHint = language === 'zh' || language === 'zh-TW' ? 'Chinese' : language === 'ja' ? 'Japanese' : language === 'ko' ? 'Korean' : 'English';
    return `You are an AI system architect. Analyze the following scenario and generate a multi-agent team configuration in strict JSON format.

Scenario Name: ${scenarioName.trim()}
Scenario Description: ${description.trim()}
Team Size: ${agentCountHint} agents
Workflow Type: ${workflowType}
Output Language for agent names/roles/descriptions: ${langHint}

Requirements:
1. Generate ${agentCountHint} specialized AI agents appropriate for this scenario
2. Each agent should have a distinct role with clear responsibilities
3. Design a workflow that shows how agents collaborate
4. Generate detailed SOUL.md content for each agent (their persona, responsibilities, working style)
5. Generate AGENTS.md content for each agent (workspace startup instructions: which files to read, memory rules, red lines, group chat rules, heartbeat behavior — tailored to this agent's role)
6. Generate USER.md content for each agent (profile of the human/team member this agent primarily serves — name placeholder, context about what this role needs from the user, preferences)
7. Generate IDENTITY.md content for each agent (Name, Creature, Vibe, Emoji fields — fit the agent's personality)
8. Generate HEARTBEAT.md checklist items for each agent
9. Use lowercase kebab-case for agent IDs (e.g., "project-manager", "backend-dev")
10. Choose appropriate Material Symbols icon names for each agent
11. Choose appropriate Tailwind color classes (e.g., "from-blue-500 to-cyan-500")

Respond ONLY with a JSON object in this exact structure (no markdown, no explanation outside JSON):
{
  "reasoning": "Brief explanation of why you chose these agents and this workflow",
  "template": {
    "id": "kebab-case-id-based-on-scenario-name",
    "name": "Human-readable team name",
    "description": "Team purpose description",
    "agents": [
      {
        "id": "agent-id",
        "name": "Agent Display Name",
        "role": "One-line role description",
        "description": "Detailed description of agent responsibilities",
        "icon": "material_symbol_name",
        "color": "from-blue-500 to-cyan-500",
        "soul": "Full SOUL.md content in markdown — persona, responsibilities, working style",
        "agentsMd": "Full AGENTS.md content — workspace startup instructions tailored to this agent",
        "userMd": "Full USER.md content — profile template for the human this agent serves",
        "identityMd": "Full IDENTITY.md content — Name/Creature/Vibe/Emoji for this agent",
        "heartbeat": "- [ ] Task 1\n- [ ] Task 2"
      }
    ],
    "workflow": {
      "type": "${workflowType}",
      "description": "How agents collaborate",
      "steps": [
        {
          "agent": "agent-id",
          "action": "What this agent does in this step"
        }
      ]
    }
  }
}`;
  }, [scenarioName, description, teamSize, workflowType, language]);

  const handlePreparePrompt = useCallback(() => {
    if (!scenarioName.trim() || !description.trim()) return;
    setEditablePrompt(buildPrompt());
    setError(null);
    setStep('prompt-review');
  }, [scenarioName, description, buildPrompt]);

  const handleConfirmGenerate = useCallback(async () => {
    setStep('generating');
    setGenPhase('connecting');
    setError(null);

    // Clear any previous timers
    genTimersRef.current.forEach(t => clearTimeout(t));
    genTimersRef.current = [];

    // Drive phase transitions by realistic time milestones:
    // connecting (~0-3s): sessions.create round-trip
    // sending   (~3s):    sessions.send dispatch
    // thinking  (~5s+):   LLM processing (bulk of the wait)
    // parsing   (late):   JSON parse — we flip this just before done
    const schedule = (phase: GenPhase, ms: number) => {
      const t = setTimeout(() => setGenPhase(phase), ms);
      genTimersRef.current.push(t);
    };
    schedule('sending', 3000);
    schedule('thinking', 5500);

    try {
      const result = await multiAgentApi.generate({
        scenarioName: scenarioName.trim(),
        description: description.trim(),
        teamSize,
        workflowType,
        language,
        ...(selectedModel ? { modelId: selectedModel } : {}),
        prompt: editablePrompt || undefined,
      } as any);
      // Clear scheduled timers and flip to parsing briefly before preview
      genTimersRef.current.forEach(t => clearTimeout(t));
      genTimersRef.current = [];
      setGenPhase('parsing');
      await new Promise(r => setTimeout(r, 600));
      setGenerateResult(result);
      setEditedAgents({});
      setStep('preview');
    } catch (err: any) {
      genTimersRef.current.forEach(t => clearTimeout(t));
      genTimersRef.current = [];
      const errMsg = typeof err?.message === 'string' ? err.message : '';
      const errCode = typeof err?.error_code === 'string' ? err.error_code : '';
      const isGatewayDisconnected =
        errCode === 'GATEWAY_DISCONNECTED' ||
        errMsg.includes('GATEWAY_DISCONNECTED') ||
        errMsg.includes('not connected') ||
        errMsg.includes('gateway is not connected');
      const isTimeout =
        !isGatewayDisconnected && (
          err?.name === 'AbortError' ||
          errMsg.includes('请求超时') ||
          errMsg.includes('timeout') ||
          errMsg.includes('sessions.send')
        );
      if (isGatewayDisconnected) {
        setError('__gateway__');
      } else if (isTimeout) {
        setError('__timeout__');
      } else {
        setError(errMsg || stb.generateFailed || 'Generation failed');
      }
      setStep('prompt-review');
    }
  }, [scenarioName, description, teamSize, workflowType, language, selectedModel, editablePrompt, stb]);

  const getEffectiveAgent = useCallback(
    (agentId: string) => editedAgents[agentId] ?? null,
    [editedAgents]
  );

  const handleOpenAgentEdit = useCallback(
    (agent: MultiAgentGenerateResult['template']['agents'][0]) => {
      const existing = editedAgents[agent.id];
      setEditingAgent(existing ?? {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        description: agent.description ?? '',
        soul: agent.soul ?? '',
        agentsMd: (agent as any).agentsMd ?? '',
        userMd: (agent as any).userMd ?? '',
        identityMd: (agent as any).identityMd ?? '',
        heartbeat: agent.heartbeat ?? '',
        icon: agent.icon ?? 'person',
        color: agent.color ?? 'from-blue-500 to-cyan-500',
      });
      setStep('edit-agent');
    },
    [editedAgents]
  );

  const handleSaveAgentEdit = useCallback(() => {
    if (!editingAgent) return;
    setEditedAgents(prev => ({ ...prev, [editingAgent.id]: editingAgent }));
    setEditingAgent(null);
    setStep('preview');
  }, [editingAgent]);

  const handleConfirmDeploy = useCallback(() => {
    if (!generateResult) return;
    const template = generateResult.template;
    const agents = template.agents.map(agent => {
      const edited = editedAgents[agent.id];
      return {
        id: agent.id,
        name: edited?.name ?? agent.name,
        role: edited?.role ?? agent.role,
        description: edited?.description ?? agent.description,
        icon: edited?.icon ?? agent.icon,
        color: edited?.color ?? agent.color,
        soul: edited?.soul ?? agent.soul ?? `# ${agent.name}\n\n**Role:** ${agent.role}\n\n${agent.description ?? ''}`,
        agentsMd: edited?.agentsMd ?? (agent as any).agentsMd ?? '',
        userMd: edited?.userMd ?? (agent as any).userMd ?? '',
        identityMd: edited?.identityMd ?? (agent as any).identityMd ?? '',
        heartbeat: edited?.heartbeat ?? agent.heartbeat,
      };
    });
    const deployRequest: MultiAgentDeployRequest = {
      template: {
        id: template.id,
        name: template.name,
        description: template.description,
        agents,
        workflow: template.workflow,
        bindings: [],
      },
      prefix: template.id,
      skipExisting: true,
      dryRun: false,
    };
    onReadyToDeploy(deployRequest, generateResult.reasoning);
  }, [generateResult, editedAgents, onReadyToDeploy]);

  const getWorkflowTypeColor = (type: string) => {
    const colors: Record<string, string> = {
      sequential: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
      parallel: 'bg-green-500/10 text-green-500 border-green-500/20',
      collaborative: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
      'event-driven': 'bg-orange-500/10 text-orange-500 border-orange-500/20',
      routing: 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20',
    };
    return colors[type] || 'bg-slate-500/10 text-slate-500 border-slate-500/20';
  };

  const selectedModelLabel = modelOptions.find(o => o.value === selectedModel)?.label;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-2xl mx-4 rounded-2xl bg-white dark:bg-[#1a1a2e] border border-slate-200 dark:border-white/10 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">

        {/* ── Header ── */}
        <div className="px-5 py-4 border-b border-slate-100 dark:border-white/5 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-gradient-to-br from-violet-500 to-purple-600 shrink-0">
              <span className="material-symbols-outlined text-white text-[18px]">auto_awesome</span>
            </div>
            <div>
              <h2 className="text-[13px] font-bold text-slate-800 dark:text-white leading-tight">
                {stb.title || 'AI Team Builder'}
              </h2>
              <p className="text-[10px] text-slate-500 dark:text-white/40 mt-0.5">
                {stb.subtitle || 'Describe a scenario, AI generates your team'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Step indicator */}
            {(step === 'input' || step === 'prompt-review') && (
              <div className="hidden sm:flex items-center gap-1">
                {(['input', 'prompt-review', 'preview'] as const).map((s, i) => {
                  const order: BuilderStep[] = ['input', 'prompt-review', 'generating', 'preview', 'edit-agent'];
                  const done = order.indexOf(step) > order.indexOf(s);
                  const active = step === s;
                  return (
                    <React.Fragment key={s}>
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold transition-all ${
                        active ? 'bg-violet-500 text-white' : done ? 'bg-violet-500/30 text-violet-400' : 'bg-slate-200 dark:bg-white/10 text-slate-400 dark:text-white/30'
                      }`}>{i + 1}</div>
                      {i < 2 && <div className="w-3 h-px bg-slate-200 dark:bg-white/10" />}
                    </React.Fragment>
                  );
                })}
              </div>
            )}
            <button
              onClick={step === 'edit-agent' ? () => setStep('preview') : step === 'prompt-review' ? () => setStep('input') : onClose}
              className="w-8 h-8 rounded-lg hover:bg-slate-100 dark:hover:bg-white/5 flex items-center justify-center transition-colors"
            >
              <span className="material-symbols-outlined text-[18px] text-slate-400">
                {step === 'edit-agent' || step === 'prompt-review' ? 'arrow_back' : 'close'}
              </span>
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto min-h-0">

          {/* ══ Step: Input ══ */}
          {step === 'input' && (
            <div className="p-5 space-y-4">

              {error && (
                <div className="px-3 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-[11px] text-red-600 dark:text-red-400 flex items-start gap-2">
                  <span className="material-symbols-outlined text-[15px] shrink-0 mt-0.5">error</span>
                  {error}
                </div>
              )}

              {/* ── Template Picker + Name row ── */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-wider">
                    {stb.scenarioNameLabel || 'Scenario Name'} <span className="text-red-400">*</span>
                  </label>
                  {/* Template button — like SOUL.md template picker */}
                  <div ref={templatePickerRef} className="relative">
                    <button
                      onClick={() => setTemplatePickerOpen(v => !v)}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[10px] font-bold transition-all ${templatePickerOpen ? 'border-violet-500/50 bg-violet-500/10 text-violet-600 dark:text-violet-400' : 'border-slate-200 dark:border-white/10 text-slate-500 dark:text-white/40 hover:border-violet-400/40 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/5'}`}
                    >
                      <span className="material-symbols-outlined text-[14px]">auto_fix_high</span>
                      {stb.templateBtn || 'Templates'}
                      <span className={`material-symbols-outlined text-[12px] transition-transform ${templatePickerOpen ? 'rotate-180' : ''}`}>expand_more</span>
                    </button>

                    {templatePickerOpen && (
                      <div className="absolute end-0 top-full mt-1.5 w-72 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#1e2028] shadow-2xl shadow-black/20 z-50 overflow-hidden">
                        <div className="px-3 py-2 border-b border-slate-100 dark:border-white/5">
                          <p className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-wider">
                            {stb.templatePickerTitle || 'Professional Scenario Templates'}
                          </p>
                        </div>
                        <div className="max-h-72 overflow-y-auto">
                          {SCENARIO_TEMPLATES.map((tpl, i) => (
                            <button
                              key={i}
                              onClick={() => handleApplyTemplate(tpl)}
                              className="w-full text-start px-3 py-2.5 flex items-start gap-3 hover:bg-slate-50 dark:hover:bg-white/[0.06] transition-colors border-b border-slate-100 dark:border-white/[0.04] last:border-b-0 group"
                            >
                              <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-gradient-to-br ${tpl.color} mt-0.5`}>
                                <span className="material-symbols-outlined text-white text-[15px]">{tpl.icon}</span>
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-[11px] font-bold text-slate-700 dark:text-white/80 group-hover:text-violet-600 dark:group-hover:text-violet-400 transition-colors">
                                  {stb[tpl.nameKey] || tpl.name}
                                </p>
                                <p className="text-[10px] text-slate-400 dark:text-white/30 mt-0.5 line-clamp-2 leading-relaxed">
                                  {stb[tpl.descKey] || tpl.desc}
                                </p>
                                <div className="flex items-center gap-1.5 mt-1">
                                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/10 text-slate-500 dark:text-white/40 font-medium">
                                    {ma[`workflow${tpl.workflowType.charAt(0).toUpperCase() + tpl.workflowType.slice(1)}`] || tpl.workflowType}
                                  </span>
                                  <span className="text-[9px] text-slate-400 dark:text-white/30">
                                    {TEAM_SIZES.find(s => s.value === tpl.teamSize)?.range} {stb.agents || 'agents'}
                                  </span>
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <input
                  type="text"
                  value={scenarioName}
                  onChange={e => setScenarioName(e.target.value)}
                  placeholder={stb.scenarioNamePlaceholder || 'e.g. Software Development Team'}
                  className="w-full px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[13px] text-slate-800 dark:text-white/80 placeholder-slate-400 dark:placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/50 transition-all"
                />
              </div>

              {/* ── Description ── */}
              <div>
                <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-wider block mb-1.5">
                  {stb.descriptionLabel || 'Scenario Description'} <span className="text-red-400">*</span>
                </label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={5}
                  placeholder={stb.descriptionPlaceholder || 'Describe what this team needs to do, their goals, and key responsibilities. The more detail you provide, the better the AI can design the team roles.'}
                  className="w-full px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[12px] text-slate-800 dark:text-white/80 placeholder-slate-400 dark:placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/50 resize-none leading-relaxed transition-all"
                />
                <p className="text-[10px] text-slate-400 dark:text-white/25 mt-1.5 flex items-center gap-1">
                  <span className="material-symbols-outlined text-[12px]">lightbulb</span>
                  {stb.descriptionHint || 'Tip: Mention domain, tools, or communication style for better results'}
                </p>
              </div>

              {/* ── Team Size + Workflow compact dropdowns ── */}
              <div className="grid grid-cols-2 gap-3">
                {/* Team Size dropdown */}
                <div>
                  <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-wider block mb-1.5">
                    {stb.teamSizeLabel || 'Team Size'}
                  </label>
                  <div ref={teamSizeRef} className="relative">
                    <button
                      onClick={() => { setTeamSizeOpen(v => !v); setWorkflowOpen(false); }}
                      className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border text-start transition-all ${
                        teamSizeOpen ? 'border-violet-500/50 ring-1 ring-violet-500/20 bg-violet-500/5' : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20 bg-slate-50 dark:bg-white/[0.03]'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px] text-violet-500 shrink-0">
                        {TEAM_SIZES.find(s => s.value === teamSize)?.icon || 'groups'}
                      </span>
                      <span className="flex-1 text-[12px] font-medium text-slate-800 dark:text-white/80 truncate">
                        {stb[`teamSize_${teamSize}`] || teamSize.charAt(0).toUpperCase() + teamSize.slice(1)}
                        <span className="ms-1.5 text-[11px] font-normal text-slate-400 dark:text-white/30">
                          ({TEAM_SIZES.find(s => s.value === teamSize)?.range} {stb.agents || 'agents'})
                        </span>
                      </span>
                      <span className={`material-symbols-outlined text-[14px] text-slate-400 dark:text-white/30 shrink-0 transition-transform ${teamSizeOpen ? 'rotate-180' : ''}`}>expand_more</span>
                    </button>
                    {teamSizeOpen && (
                      <div className="absolute start-0 end-0 top-full mt-1 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#1e2028] shadow-xl shadow-black/10 dark:shadow-black/40 z-50 py-1 overflow-hidden">
                        {TEAM_SIZES.map(size => (
                          <button
                            key={size.value}
                            onClick={() => { setTeamSize(size.value); setTeamSizeOpen(false); }}
                            className={`w-full text-start px-3 py-2 flex items-center gap-2.5 transition-colors ${
                              size.value === teamSize ? 'bg-violet-500/5 text-violet-600 dark:text-violet-400' : 'text-slate-600 dark:text-white/70 hover:bg-slate-50 dark:hover:bg-white/[0.06]'
                            }`}
                          >
                            <span className={`material-symbols-outlined text-[16px] ${size.value === teamSize ? 'text-violet-500' : 'text-slate-400 dark:text-white/30'}`}>{size.icon}</span>
                            <span className="text-[11px] font-medium">
                              {stb[`teamSize_${size.value}`] || size.value.charAt(0).toUpperCase() + size.value.slice(1)}
                            </span>
                            <span className="ms-auto text-[10px] text-slate-400 dark:text-white/30">{size.range}</span>
                            {size.value === teamSize && <span className="material-symbols-outlined text-[13px] text-violet-500">check</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Workflow Type dropdown */}
                <div>
                  <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-wider block mb-1.5">
                    {stb.workflowTypeLabel || 'Workflow Style'}
                  </label>
                  <div ref={workflowRef} className="relative">
                    <button
                      onClick={() => { setWorkflowOpen(v => !v); setTeamSizeOpen(false); }}
                      className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border text-start transition-all ${
                        workflowOpen ? 'border-violet-500/50 ring-1 ring-violet-500/20 bg-violet-500/5' : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20 bg-slate-50 dark:bg-white/[0.03]'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px] text-violet-500 shrink-0">
                        {WORKFLOW_TYPES.find(w => w.value === workflowType)?.icon || 'hub'}
                      </span>
                      <span className="flex-1 text-[12px] font-medium text-slate-800 dark:text-white/80 truncate">
                        {ma[WORKFLOW_TYPES.find(w => w.value === workflowType)?.labelKey || 'workflowCollaborative'] || workflowType}
                      </span>
                      <span className={`material-symbols-outlined text-[14px] text-slate-400 dark:text-white/30 shrink-0 transition-transform ${workflowOpen ? 'rotate-180' : ''}`}>expand_more</span>
                    </button>
                    {workflowOpen && (
                      <div className="absolute start-0 end-0 top-full mt-1 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#1e2028] shadow-xl shadow-black/10 dark:shadow-black/40 z-50 py-1 overflow-hidden">
                        {WORKFLOW_TYPES.map(wf => (
                          <button
                            key={wf.value}
                            onClick={() => { setWorkflowType(wf.value); setWorkflowOpen(false); }}
                            className={`w-full text-start px-3 py-2 flex items-center gap-2.5 transition-colors ${
                              wf.value === workflowType ? 'bg-violet-500/5 text-violet-600 dark:text-violet-400' : 'text-slate-600 dark:text-white/70 hover:bg-slate-50 dark:hover:bg-white/[0.06]'
                            }`}
                          >
                            <span className={`material-symbols-outlined text-[16px] ${wf.value === workflowType ? 'text-violet-500' : 'text-slate-400 dark:text-white/30'}`}>{wf.icon}</span>
                            <span className="text-[11px] font-medium">{ma[wf.labelKey] || wf.value}</span>
                            {wf.value === workflowType && <span className="material-symbols-outlined text-[13px] text-violet-500 ms-auto">check</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ── Model Selector ── */}
              {modelOptions.length > 0 && (
                <div>
                  <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-wider block mb-1.5">
                    {stb.modelLabel || 'Generation Model'}
                    <span className="ms-1.5 normal-case font-normal text-slate-400 dark:text-white/25">{stb.modelHint || '(optional)'}</span>
                  </label>
                  <div ref={modelPickerRef} className="relative">
                    <button
                      onClick={() => setModelPickerOpen(v => !v)}
                      className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border text-start transition-all ${modelPickerOpen ? 'border-violet-500/50 ring-1 ring-violet-500/20 bg-violet-500/5' : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20 bg-slate-50 dark:bg-white/[0.03]'}`}
                    >
                      <span className="material-symbols-outlined text-[16px] text-slate-400 dark:text-white/30 shrink-0">memory</span>
                      <span className={`flex-1 text-[12px] truncate ${selectedModel ? 'text-slate-800 dark:text-white/80 font-medium' : 'text-slate-400 dark:text-white/30'}`}>
                        {selectedModelLabel || stb.modelAuto || 'Auto (default model)'}
                      </span>
                      {selectedModel && (
                        <button
                          onClick={e => { e.stopPropagation(); setSelectedModel(''); }}
                          className="w-4 h-4 rounded flex items-center justify-center hover:bg-slate-200 dark:hover:bg-white/10 shrink-0"
                        >
                          <span className="material-symbols-outlined text-[12px] text-slate-400">close</span>
                        </button>
                      )}
                      <span className={`material-symbols-outlined text-[14px] text-slate-400 dark:text-white/30 shrink-0 transition-transform ${modelPickerOpen ? 'rotate-180' : ''}`}>expand_more</span>
                    </button>

                    {modelPickerOpen && (
                      <div className="absolute start-0 end-0 top-full mt-1 max-h-52 overflow-y-auto rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-[#1e2028] shadow-xl shadow-black/10 dark:shadow-black/40 z-50 py-1">
                        <button
                          onClick={() => { setSelectedModel(''); setModelPickerOpen(false); }}
                          className={`w-full text-start px-3 py-2 text-[11px] transition-colors border-b border-slate-100 dark:border-white/[0.06] ${!selectedModel ? 'bg-violet-500/5 text-violet-600 dark:text-violet-400 font-bold' : 'text-slate-500 dark:text-white/40 hover:bg-slate-50 dark:hover:bg-white/[0.06]'}`}
                        >
                          <span className="material-symbols-outlined text-[12px] me-1.5 align-middle">auto_awesome</span>
                          {stb.modelAuto || 'Auto (default model)'}
                        </button>
                        {modelOptions.map(o => (
                          <button
                            key={o.value}
                            onClick={() => { setSelectedModel(o.value); setModelPickerOpen(false); }}
                            className={`w-full text-start px-3 py-2 text-[11px] transition-colors font-mono truncate ${o.value === selectedModel ? 'bg-violet-500/5 text-violet-600 dark:text-violet-400 font-bold' : 'text-slate-600 dark:text-white/70 hover:bg-slate-50 dark:hover:bg-white/[0.06]'}`}
                          >
                            {o.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ══ Step: Prompt Review ══ */}
          {step === 'prompt-review' && (
            <div className="p-5 space-y-3">
              {error && (error === '__gateway__' ? (
                <div className="rounded-xl bg-red-500/10 border border-red-500/25 p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <span className="material-symbols-outlined text-[16px] shrink-0 mt-0.5 text-red-500">wifi_off</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-bold text-red-600 dark:text-red-400">
                        {stb.genErrGateway || 'Gateway disconnected'}
                      </p>
                      <p className="text-[11px] text-red-500/80 dark:text-red-400/70 mt-0.5">
                        {stb.genErrGatewayDesc || 'The gateway connection was lost. Check gateway status and retry.'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 pt-0.5">
                    <button
                      onClick={handleConfirmGenerate}
                      className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-red-500/20 hover:bg-red-500/30 text-red-600 dark:text-red-400 transition-colors flex items-center gap-1.5"
                    >
                      <span className="material-symbols-outlined text-[13px]">refresh</span>
                      {stb.retryGenerate || 'Retry'}
                    </button>
                    <span className="text-[10px] text-red-500/60">
                      {stb.genErrGatewayTip || 'Check that the gateway is running and reconnect'}
                    </span>
                  </div>
                </div>
              ) : error === '__timeout__' ? (
                <div className="rounded-xl bg-amber-500/10 border border-amber-500/25 p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <span className="material-symbols-outlined text-[16px] shrink-0 mt-0.5 text-amber-500">schedule</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-bold text-amber-600 dark:text-amber-400">
                        {stb.timeoutTitle || 'AI is taking longer than expected'}
                      </p>
                      <p className="text-[11px] text-amber-600/80 dark:text-amber-400/70 mt-0.5">
                        {stb.timeoutDesc || 'The AI may still be generating. Try again — a faster model or a shorter description may help.'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 pt-0.5">
                    <button
                      onClick={handleConfirmGenerate}
                      className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-amber-500/20 hover:bg-amber-500/30 text-amber-600 dark:text-amber-400 transition-colors flex items-center gap-1.5"
                    >
                      <span className="material-symbols-outlined text-[13px]">refresh</span>
                      {stb.retryGenerate || 'Retry'}
                    </button>
                    <span className="text-[10px] text-amber-500/60">
                      {stb.timeoutTip || 'Tip: Try switching to a faster model above'}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="px-3 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-[11px] text-red-600 dark:text-red-400 flex items-start gap-2">
                  <span className="material-symbols-outlined text-[15px] shrink-0 mt-0.5">error</span>
                  <span className="flex-1 min-w-0 break-words">{error}</span>
                </div>
              ))}
              {/* Summary chips */}
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-white/[0.06] border border-slate-200 dark:border-white/10">
                  <span className="material-symbols-outlined text-[13px] text-violet-500">edit_note</span>
                  <span className="text-[11px] font-bold text-slate-700 dark:text-white/70 max-w-[140px] truncate">{scenarioName}</span>
                </div>
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-white/[0.06] border border-slate-200 dark:border-white/10">
                  <span className="material-symbols-outlined text-[13px] text-violet-500">{TEAM_SIZES.find(s => s.value === teamSize)?.icon || 'groups'}</span>
                  <span className="text-[11px] text-slate-600 dark:text-white/60">{stb[`teamSize_${teamSize}`] || teamSize} · {TEAM_SIZES.find(s => s.value === teamSize)?.range}</span>
                </div>
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-white/[0.06] border border-slate-200 dark:border-white/10">
                  <span className="material-symbols-outlined text-[13px] text-violet-500">{WORKFLOW_TYPES.find(w => w.value === workflowType)?.icon || 'hub'}</span>
                  <span className="text-[11px] text-slate-600 dark:text-white/60">{ma[WORKFLOW_TYPES.find(w => w.value === workflowType)?.labelKey || ''] || workflowType}</span>
                </div>
                {selectedModelLabel && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-white/[0.06] border border-slate-200 dark:border-white/10">
                    <span className="material-symbols-outlined text-[13px] text-violet-500">memory</span>
                    <span className="text-[11px] text-slate-600 dark:text-white/60 max-w-[120px] truncate">{selectedModelLabel}</span>
                  </div>
                )}
              </div>

              {/* Editable prompt */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-wider">
                    {stb.promptLabel || 'AI Prompt'}
                  </label>
                  <button
                    onClick={() => setEditablePrompt(buildPrompt())}
                    className="flex items-center gap-1 text-[10px] text-slate-400 dark:text-white/30 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
                  >
                    <span className="material-symbols-outlined text-[12px]">restart_alt</span>
                    {stb.promptReset || 'Reset'}
                  </button>
                </div>
                <textarea
                  value={editablePrompt}
                  onChange={e => setEditablePrompt(e.target.value)}
                  rows={14}
                  className="w-full px-3 py-3 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[11px] text-slate-700 dark:text-white/70 font-mono focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/50 resize-none leading-relaxed transition-all"
                />
                <p className="text-[10px] text-slate-400 dark:text-white/25 mt-1.5 flex items-center gap-1">
                  <span className="material-symbols-outlined text-[12px]">info</span>
                  {stb.promptHint || 'You can freely edit this prompt before sending it to the AI.'}
                </p>
              </div>
            </div>
          )}

          {/* ══ Step: Generating ══ */}
          {step === 'generating' && (() => {
            const phases: { key: typeof genPhase; icon: string; labelKey: string; fallback: string }[] = [
              { key: 'connecting', icon: 'electrical_services', labelKey: 'genPhaseConnecting', fallback: 'Connecting to AI gateway...' },
              { key: 'sending',    icon: 'send',                labelKey: 'genPhaseSending',    fallback: 'Sending prompt to AI...' },
              { key: 'thinking',   icon: 'psychology',          labelKey: 'genPhaseThinking',   fallback: 'AI is generating your team...' },
              { key: 'parsing',    icon: 'data_object',         labelKey: 'genPhaseParsing',    fallback: 'Processing AI response...' },
            ];
            const phaseOrder: (typeof genPhase)[] = ['connecting', 'sending', 'thinking', 'parsing', 'done'];
            const currentIdx = phaseOrder.indexOf(genPhase);
            const currentPhase = phases.find(p => p.key === genPhase) ?? phases[2];
            return (
              <div className="p-6 flex flex-col items-center justify-center py-12 gap-5">
                {/* WS-pushed error banner — shown immediately when backend reports failure */}
                {genWsError && (
                  <div className="w-full max-w-xs rounded-xl border p-3 space-y-1.5 flex items-start gap-2.5
                    bg-red-500/10 border-red-500/25">
                    <span className="material-symbols-outlined text-[18px] shrink-0 mt-0.5 text-red-500">
                      {genWsError.code === 'GATEWAY_DISCONNECTED' ? 'wifi_off' : 'error'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-bold text-red-600 dark:text-red-400">
                        {genWsError.code === 'GATEWAY_DISCONNECTED'
                          ? (stb.genErrGateway || 'Gateway disconnected')
                          : genWsError.code === 'TIMEOUT'
                            ? (stb.timeoutTitle || 'AI is taking longer than expected')
                            : (stb.generateFailed || 'Generation failed')}
                      </p>
                      <p className="text-[11px] text-red-500/80 dark:text-red-400/70 mt-0.5 break-words">
                        {genWsError.code === 'GATEWAY_DISCONNECTED'
                          ? (stb.genErrGatewayDesc || 'The gateway connection was lost. Check gateway status and retry.')
                          : genWsError.msg}
                      </p>
                    </div>
                  </div>
                )}

                {/* Spinner — hidden while WS error is shown */}
                {!genWsError && (
                <div className="relative w-20 h-20">
                  <div className="absolute inset-0 rounded-full bg-gradient-to-br from-violet-500/20 to-purple-600/20 animate-pulse" />
                  <div className="absolute inset-2 rounded-full bg-gradient-to-br from-violet-500/30 to-purple-600/30 flex items-center justify-center">
                    <span className="material-symbols-outlined text-[32px] text-violet-500 animate-spin" style={{ animationDuration: '2s' }}>
                      progress_activity
                    </span>
                  </div>
                </div>
                )}

                {/* Current phase label */}
                <div className="text-center">
                  <p className="text-[14px] font-bold text-slate-800 dark:text-white">
                    {genWsError
                      ? (stb.genErrWaiting || 'Waiting for result...')
                      : (stb[currentPhase.labelKey] || currentPhase.fallback)}
                  </p>
                  {selectedModelLabel && (
                    <p className="text-[10px] text-violet-500/70 mt-2 flex items-center justify-center gap-1">
                      <span className="material-symbols-outlined text-[12px]">memory</span>
                      {selectedModelLabel}
                    </p>
                  )}
                </div>

                {/* Phase step list */}
                <div className="flex flex-col gap-2 w-full max-w-xs">
                  {phases.map((phase, i) => {
                    const phaseIdx = phaseOrder.indexOf(phase.key);
                    const isDone = phaseIdx < currentIdx;
                    const isActive = phase.key === genPhase;
                    return (
                      <div key={phase.key} className={`flex items-center gap-2.5 text-[11px] transition-all duration-500 ${
                        isActive ? 'text-violet-500 dark:text-violet-400' :
                        isDone   ? 'text-slate-400 dark:text-white/30' :
                                   'text-slate-300 dark:text-white/15'
                      }`}>
                        <span className={`material-symbols-outlined text-[15px] shrink-0 ${
                          isDone   ? 'text-violet-400/60' :
                          isActive ? 'animate-pulse' : 'opacity-30'
                        }`}>
                          {isDone ? 'check_circle' : phase.icon}
                        </span>
                        <span className={isActive ? 'font-semibold' : ''}>
                          {stb[phase.labelKey] || phase.fallback}
                        </span>
                        {isActive && (
                          <span className="ml-auto flex gap-0.5">
                            {[0,1,2].map(d => (
                              <span key={d} className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: `${d * 0.15}s` }} />
                            ))}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Live elapsed counter — visible from thinking phase onward */}
                {(genPhase === 'thinking' || genPhase === 'parsing') && (
                  <div className="flex flex-col items-center gap-2 w-full max-w-xs">
                    {/* Elapsed time pill */}
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-violet-500/10 border border-violet-500/20">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-60" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-violet-500" />
                      </span>
                      <span className="text-[12px] font-mono font-bold text-violet-500 dark:text-violet-400 tabular-nums">
                        {String(Math.floor(genElapsed / 60)).padStart(2, '0')}:{String(genElapsed % 60).padStart(2, '0')}
                      </span>
                      <span className="text-[10px] text-violet-500/60">
                        {genStreamText
                          ? (stb.genAliveStreaming || 'tokens arriving')
                          : genServerActiveRef.current
                            ? (stb.genAliveServer || 'AI responding')
                            : (stb.genAliveClient || 'AI working...')}
                      </span>
                    </div>

                    {/* Live token stream preview */}
                    {genStreamText && (
                      <div className="w-full rounded-xl bg-slate-900/60 dark:bg-black/40 border border-violet-500/15 overflow-hidden">
                        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-violet-500/10">
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
                          </span>
                          <span className="text-[9px] font-bold text-green-400/70 uppercase tracking-wider">
                            {stb.genLivePreview || 'Live output'}
                          </span>
                        </div>
                        <div className="px-2.5 py-2 max-h-[90px] overflow-hidden relative">
                          <p className="text-[10px] font-mono text-slate-300/70 dark:text-white/40 leading-relaxed whitespace-pre-wrap break-all line-clamp-5">
                            {genStreamText}
                          </p>
                          {/* Fade-out at the bottom */}
                          <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-slate-900/60 dark:from-black/40 to-transparent pointer-events-none" />
                        </div>
                      </div>
                    )}

                    {/* Hint only if waiting a while without stream */}
                    {genElapsed >= 20 && !genStreamText && (
                      <p className="text-[10px] text-slate-400 dark:text-white/25 text-center max-w-[220px]">
                        {stb.genThinkingHint || 'This may take 30–90 seconds depending on team size and model.'}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })()}


          {/* ══ Step: Preview ══ */}
          {step === 'preview' && generateResult && (
            <div className="p-5 space-y-4">
              {/* Team summary card */}
              <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-white text-[18px]">groups</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-[13px] font-bold text-slate-800 dark:text-white">{generateResult.template.name}</h3>
                    <p className="text-[11px] text-slate-500 dark:text-white/40 mt-0.5">{generateResult.template.description}</p>
                  </div>
                  <span className={`px-2 py-1 rounded text-[9px] font-bold border shrink-0 ${getWorkflowTypeColor(generateResult.template.workflow.type)}`}>
                    {ma[`workflow${generateResult.template.workflow.type.charAt(0).toUpperCase() + generateResult.template.workflow.type.slice(1)}`] || generateResult.template.workflow.type}
                  </span>
                </div>
              </div>

              {/* Tabs */}
              <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-white/5">
                {(['agents', 'workflow', 'reasoning'] as const).map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-all ${
                      activeTab === tab
                        ? 'bg-white dark:bg-white/10 text-slate-800 dark:text-white shadow-sm'
                        : 'text-slate-500 dark:text-white/40 hover:text-slate-700 dark:hover:text-white/60'
                    }`}
                  >
                    {tab === 'agents' && `${stb.tabAgents || 'Agents'} (${generateResult.template.agents.length})`}
                    {tab === 'workflow' && (stb.tabWorkflow || 'Workflow')}
                    {tab === 'reasoning' && (stb.tabReasoning || 'AI Reasoning')}
                  </button>
                ))}
              </div>

              {/* Tab: Agents */}
              {activeTab === 'agents' && (
                <div className="space-y-2">
                  {generateResult.template.agents.map(agent => {
                    const edited = getEffectiveAgent(agent.id);
                    const displayName = edited?.name ?? agent.name;
                    const displayRole = edited?.role ?? agent.role;
                    const displayColor = edited?.color ?? agent.color ?? 'from-blue-500 to-cyan-500';
                    const displayIcon = edited?.icon ?? agent.icon ?? 'person';
                    const isEdited = !!edited;
                    return (
                      <div key={agent.id} className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-white/[0.02] overflow-hidden">
                        <div className="p-3 flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={resolveTemplateColor(displayColor)}>
                            <span className="material-symbols-outlined text-white text-[17px]">{displayIcon}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="text-[12px] font-bold text-slate-700 dark:text-white/80 truncate">{displayName}</p>
                              {isEdited && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0">{stb.edited || 'Edited'}</span>}
                            </div>
                            <p className="text-[10px] text-slate-500 dark:text-white/40 truncate">{displayRole}</p>
                            <p className="text-[9px] text-slate-400 dark:text-white/25 font-mono mt-0.5">{agent.id}</p>
                          </div>
                          <button
                            onClick={() => handleOpenAgentEdit(agent)}
                            className="px-2.5 py-1.5 rounded-lg text-[10px] font-bold text-slate-500 dark:text-white/40 hover:bg-slate-100 dark:hover:bg-white/5 hover:text-slate-700 dark:hover:text-white/70 flex items-center gap-1 transition-all shrink-0"
                          >
                            <span className="material-symbols-outlined text-[13px]">edit</span>
                            {stb.editAgent || 'Edit'}
                          </button>
                        </div>
                        {(edited?.soul ?? agent.soul) && (
                          <div className="px-3 pb-3 border-t border-slate-100 dark:border-white/5 pt-2">
                            <p className="text-[10px] text-slate-400 dark:text-white/30 font-mono line-clamp-2 leading-relaxed">
                              {(edited?.soul ?? agent.soul)?.substring(0, 180)}...
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Tab: Workflow */}
              {activeTab === 'workflow' && (
                <div className="space-y-2">
                  <p className="text-[11px] text-slate-500 dark:text-white/40">{generateResult.template.workflow.description}</p>
                  <div className="relative">
                    <div className="absolute start-4 top-0 bottom-0 w-0.5 bg-slate-200 dark:bg-white/10" />
                    <div className="space-y-2">
                      {generateResult.template.workflow.steps.map((wfStep, idx) => {
                        const agentId = wfStep.agent ?? (wfStep.agents?.[0] ?? '');
                        const agent = generateResult.template.agents.find(a => a.id === agentId);
                        const edited = agent ? getEffectiveAgent(agent.id) : null;
                        const displayColor = edited?.color ?? agent?.color ?? 'from-slate-400 to-slate-500';
                        const displayIcon = edited?.icon ?? agent?.icon ?? 'person';
                        return (
                          <div key={idx} className="relative flex items-start gap-3 ps-8">
                            <div className="absolute start-2 top-1.5 w-4 h-4 rounded-full flex items-center justify-center border-2 border-white dark:border-[#1a1a2e]" style={resolveTemplateColor(displayColor)}>
                              <span className="material-symbols-outlined text-white text-[10px]">{displayIcon}</span>
                            </div>
                            <div className="flex-1 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.02] p-2.5">
                              <div className="flex items-center gap-1.5 mb-1">
                                <span className="text-[9px] font-bold text-slate-400 dark:text-white/30">#{idx + 1}</span>
                                <span className="text-[10px] font-bold text-slate-600 dark:text-white/60">{edited?.name ?? agent?.name ?? agentId}</span>
                                {wfStep.parallel && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-green-500/10 text-green-500">{ma.parallel || 'Parallel'}</span>}
                              </div>
                              <p className="text-[11px] text-slate-700 dark:text-white/70">{wfStep.action}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Tab: AI Reasoning */}
              {activeTab === 'reasoning' && (
                <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.02] p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="material-symbols-outlined text-[18px] text-violet-500">psychology</span>
                    <p className="text-[11px] font-bold text-slate-600 dark:text-white/60">{stb.reasoningTitle || 'Why this team design?'}</p>
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-white/60 leading-relaxed whitespace-pre-wrap">{generateResult.reasoning}</p>
                </div>
              )}

              {/* Regenerate */}
              <button
                onClick={() => setStep('input')}
                className="w-full py-2 rounded-xl border border-dashed border-slate-300 dark:border-white/10 text-[11px] text-slate-500 dark:text-white/40 hover:border-violet-500/40 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/5 flex items-center justify-center gap-1.5 transition-all"
              >
                <span className="material-symbols-outlined text-[14px]">refresh</span>
                {stb.regenerate || 'Regenerate with different settings'}
              </button>
            </div>
          )}

          {/* ══ Step: Edit Agent ══ */}
          {step === 'edit-agent' && editingAgent && (
            <div className="p-5 space-y-3">
              {/* Agent header + basic fields */}
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={resolveTemplateColor(editingAgent.color)}>
                  <span className="material-symbols-outlined text-white text-[18px]">{editingAgent.icon}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-bold text-slate-700 dark:text-white/80">{stb.editAgentTitle || 'Edit Agent'}</p>
                  <p className="text-[10px] text-slate-400 dark:text-white/30 font-mono">{editingAgent.id}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase block mb-1">{stb.agentName || 'Name'}</label>
                  <input type="text" value={editingAgent.name} onChange={e => setEditingAgent(prev => prev ? { ...prev, name: e.target.value } : prev)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[12px] text-slate-800 dark:text-white/80 focus:outline-none focus:ring-1 focus:ring-violet-500/30" />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase block mb-1">{stb.agentIcon || 'Icon'}</label>
                  <input type="text" value={editingAgent.icon} onChange={e => setEditingAgent(prev => prev ? { ...prev, icon: e.target.value } : prev)} placeholder="person"
                    className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[12px] text-slate-800 dark:text-white/80 font-mono focus:outline-none focus:ring-1 focus:ring-violet-500/30" />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase block mb-1">{stb.agentRole || 'Role'}</label>
                <input type="text" value={editingAgent.role} onChange={e => setEditingAgent(prev => prev ? { ...prev, role: e.target.value } : prev)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[12px] text-slate-800 dark:text-white/80 focus:outline-none focus:ring-1 focus:ring-violet-500/30" />
              </div>

              {/* File tabs */}
              <div>
                <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100 dark:bg-white/5 mb-2">
                  {([
                    { key: 'soul', label: 'SOUL.md', icon: 'psychology' },
                    { key: 'agentsMd', label: 'AGENTS.md', icon: 'home' },
                    { key: 'identityMd', label: 'IDENTITY.md', icon: 'badge' },
                    { key: 'userMd', label: 'USER.md', icon: 'person' },
                    { key: 'heartbeat', label: 'HEARTBEAT.md', icon: 'favorite' },
                  ] as const).map(tab => (
                    <button
                      key={tab.key}
                      onClick={() => setEditingAgent(prev => prev ? { ...prev, _activeTab: tab.key } as any : prev)}
                      className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md text-[9px] font-bold transition-all ${
                        ((editingAgent as any)._activeTab ?? 'soul') === tab.key
                          ? 'bg-white dark:bg-white/10 text-slate-800 dark:text-white shadow-sm'
                          : 'text-slate-500 dark:text-white/40 hover:text-slate-700 dark:hover:text-white/60'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[12px]">{tab.icon}</span>
                      <span className="hidden sm:inline">{tab.label}</span>
                    </button>
                  ))}
                </div>

                {/* SOUL.md */}
                {((editingAgent as any)._activeTab ?? 'soul') === 'soul' && (
                  <textarea value={editingAgent.soul} onChange={e => setEditingAgent(prev => prev ? { ...prev, soul: e.target.value } : prev)} rows={10}
                    placeholder="# Agent Name&#10;&#10;**Role:** ...&#10;&#10;Describe persona, responsibilities, working style..."
                    className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[11px] text-slate-800 dark:text-white/80 font-mono focus:outline-none focus:ring-1 focus:ring-violet-500/30 resize-none leading-relaxed" />
                )}

                {/* AGENTS.md */}
                {(editingAgent as any)._activeTab === 'agentsMd' && (
                  <textarea value={editingAgent.agentsMd} onChange={e => setEditingAgent(prev => prev ? { ...prev, agentsMd: e.target.value } : prev)} rows={10}
                    placeholder="# AGENTS.md - Workspace&#10;&#10;## Session Startup&#10;1. Read SOUL.md&#10;2. Read USER.md&#10;..."
                    className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[11px] text-slate-800 dark:text-white/80 font-mono focus:outline-none focus:ring-1 focus:ring-violet-500/30 resize-none leading-relaxed" />
                )}

                {/* IDENTITY.md */}
                {(editingAgent as any)._activeTab === 'identityMd' && (
                  <textarea value={editingAgent.identityMd} onChange={e => setEditingAgent(prev => prev ? { ...prev, identityMd: e.target.value } : prev)} rows={10}
                    placeholder="# IDENTITY.md&#10;&#10;- **Name:**&#10;- **Creature:**&#10;- **Vibe:**&#10;- **Emoji:**"
                    className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[11px] text-slate-800 dark:text-white/80 font-mono focus:outline-none focus:ring-1 focus:ring-violet-500/30 resize-none leading-relaxed" />
                )}

                {/* USER.md */}
                {(editingAgent as any)._activeTab === 'userMd' && (
                  <textarea value={editingAgent.userMd} onChange={e => setEditingAgent(prev => prev ? { ...prev, userMd: e.target.value } : prev)} rows={10}
                    placeholder="# USER.md - About Your Human&#10;&#10;- **Name:**&#10;- **What to call them:**&#10;- **Timezone:**&#10;- **Notes:**"
                    className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[11px] text-slate-800 dark:text-white/80 font-mono focus:outline-none focus:ring-1 focus:ring-violet-500/30 resize-none leading-relaxed" />
                )}

                {/* HEARTBEAT.md */}
                {(editingAgent as any)._activeTab === 'heartbeat' && (
                  <textarea value={editingAgent.heartbeat} onChange={e => setEditingAgent(prev => prev ? { ...prev, heartbeat: e.target.value } : prev)} rows={10}
                    placeholder="- [ ] Check incoming requests&#10;- [ ] Review pending tasks&#10;- [ ] Update status"
                    className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[11px] text-slate-800 dark:text-white/80 font-mono focus:outline-none focus:ring-1 focus:ring-violet-500/30 resize-none leading-relaxed" />
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="px-5 py-3.5 border-t border-slate-100 dark:border-white/5 flex items-center justify-between shrink-0">
          <button
            onClick={step === 'edit-agent' ? () => setStep('preview') : step === 'prompt-review' ? () => setStep('input') : onClose}
            className="px-4 py-2 rounded-lg text-[11px] font-bold text-slate-600 dark:text-white/60 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
          >
            {step === 'edit-agent' ? (stb.backToPreview || 'Back') : step === 'prompt-review' ? (stb.back || 'Back') : (stb.cancel || 'Cancel')}
          </button>

          <div className="flex items-center gap-2">
            {step === 'input' && (
              <button
                onClick={handlePreparePrompt}
                disabled={!scenarioName.trim() || !description.trim()}
                className="px-5 py-2 rounded-lg text-[12px] font-bold bg-gradient-to-r from-violet-500 to-purple-600 text-white hover:from-violet-600 hover:to-purple-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 transition-all shadow-md shadow-violet-500/20"
              >
                <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                {stb.nextBtn || 'Next'}
              </button>
            )}
            {step === 'prompt-review' && (
              <button
                onClick={handleConfirmGenerate}
                disabled={!editablePrompt.trim()}
                className="px-5 py-2 rounded-lg text-[12px] font-bold bg-gradient-to-r from-violet-500 to-purple-600 text-white hover:from-violet-600 hover:to-purple-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 transition-all shadow-md shadow-violet-500/20"
              >
                <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
                {stb.generateBtn || 'Generate Team with AI'}
              </button>
            )}
            {step === 'preview' && generateResult && (
              <button
                onClick={handleConfirmDeploy}
                className="px-5 py-2 rounded-lg text-[12px] font-bold bg-gradient-to-r from-violet-500 to-purple-600 text-white hover:from-violet-600 hover:to-purple-700 flex items-center gap-2 transition-all shadow-md shadow-violet-500/20"
              >
                <span className="material-symbols-outlined text-[16px]">rocket_launch</span>
                {stb.deployBtn || 'Deploy This Team'}
              </button>
            )}
            {step === 'edit-agent' && (
              <button
                onClick={handleSaveAgentEdit}
                className="px-5 py-2 rounded-lg text-[12px] font-bold bg-gradient-to-r from-violet-500 to-purple-600 text-white hover:from-violet-600 hover:to-purple-700 flex items-center gap-2 transition-all"
              >
                <span className="material-symbols-outlined text-[16px]">save</span>
                {stb.saveAgent || 'Save Changes'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ScenarioTeamBuilder;
