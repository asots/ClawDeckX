
import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Language } from '../types';
import { getTranslation } from '../locales';
import { gwApi } from '../services/api';
import { useGatewayStatus } from '../hooks/useGatewayStatus';
import { fmtAgoCompact } from '../utils/time';
import { subscribeManagerWS } from '../services/manager-ws';
import { templateSystem, WorkspaceTemplate } from '../services/template-system';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import CustomSelect from '../components/CustomSelect';
import { MultiAgentCollaborationV2 } from '../components/multiagent';
import ScenarioLibraryV2 from '../components/scenarios/ScenarioLibraryV2';

interface AgentsProps { language: Language; }
type Panel = 'overview' | 'files' | 'tools' | 'skills' | 'channels' | 'cron' | 'run' | 'scenarios' | 'collaboration';


function fmtHeartbeatAgo(ts: number, template: string, never: string): string {
  if (Date.now() - ts < 0) return never;
  return template.replace('{time}', fmtAgoCompact(ts) || '0s');
}

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function fmtBytes(b?: number) {
  if (b == null) return '-';
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB']; let s = b / 1024, i = 0;
  while (s >= 1024 && i < u.length - 1) { s /= 1024; i++; }
  return `${s.toFixed(s < 10 ? 1 : 0)} ${u[i]}`;
}

function extractRunText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (typeof block === 'string') return block;
        if (block?.type === 'text' && typeof block.text === 'string') return block.text;
        if (block?.type === 'tool_use') return `[${block.name || 'tool'}](...)`;
        if (block?.type === 'tool_result') return typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    const c = content as any;
    if (typeof c.text === 'string') return c.text;
    if (typeof c.content === 'string') return c.content;
  }
  return '';
}

const Agents: React.FC<AgentsProps> = ({ language }) => {
  const t = useMemo(() => getTranslation(language), [language]);
  const a = (t as any).agt as any;
  const na = (t as any).na || '-';
  const menuAgentsLabel = typeof (t as any).menu?.agents === 'string' ? (t as any).menu.agents : 'Agents';
  const { toast } = useToast();
  const { confirm } = useConfirm();

  // Gateway connectivity (shared singleton hook)
  const { ready: gwReady } = useGatewayStatus();
  const gwReadyRef = useRef(gwReady);
  gwReadyRef.current = gwReady;
  const aRef = useRef(a);
  aRef.current = a;
  const [wsConnecting, setWsConnecting] = useState(false);
  const runIdRef = useRef<string | null>(null);
  const runSessionRef = useRef<string | null>(null);

  // Run panel state
  const [runInput, setRunInput] = useState('');
  const [runSending, setRunSending] = useState(false);
  const [runStream, setRunStream] = useState<string | null>(null);
  const [runMessages, setRunMessages] = useState<Array<{ role: string; text: string; ts: number }>>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const runEndRef = useRef<HTMLDivElement>(null);
  const runTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Heartbeat event state
  const [lastHeartbeat, setLastHeartbeat] = useState<{ ts: number; status?: string } | null>(null);

  const [agentsList, setAgentsList] = useState<any>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>('overview');
  const [loading, setLoading] = useState(false);
  const [identity, setIdentity] = useState<Record<string, any>>({});
  const [config, setConfig] = useState<any>(null);
  const [filesList, setFilesList] = useState<any>(null);
  const [fileActive, setFileActive] = useState<string | null>(null);
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [fileDrafts, setFileDrafts] = useState<Record<string, string>>({});
  const [fileSaving, setFileSaving] = useState(false);
  const [tplDropdown, setTplDropdown] = useState(false);
  const [fileTemplates, setFileTemplates] = useState<WorkspaceTemplate[]>([]);
  const [skillsReport, setSkillsReport] = useState<any>(null);
  const [skillsFilter, setSkillsFilter] = useState<'all' | 'ready' | 'notReady'>('ready');
  const [channelsSnap, setChannelsSnap] = useState<any>(null);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [cronStatus, setCronStatus] = useState<any>(null);
  const [cronJobs, setCronJobs] = useState<any[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);

  // Load workspace file templates
  useEffect(() => {
    templateSystem.getAllTemplates(language).then(setFileTemplates).catch(() => { /* templates optional */ });
  }, [language]);

  // Subscribe to shared Manager WS for agent chat streaming events
  useEffect(() => {
    setWsConnecting(true);

    let opened = false;
    const connectTimeout = setTimeout(() => {
      if (!opened) setWsConnecting(false);
    }, 10000);

    const unsubscribe = subscribeManagerWS((msg: any) => {
      try {
        if (msg.type === 'chat') {
          const payload = msg.data;
          if (!payload) return;
          if (payload.sessionKey && payload.sessionKey !== runSessionRef.current) return;

          if (payload.state === 'delta') {
            const m = payload.message as any;
            const text = extractRunText(m?.content ?? m);
            if (text) setRunStream(text);
          } else if (payload.state === 'final') {
            const m = payload.message as any;
            if (m) {
              const text = extractRunText(m?.content ?? m);
              if (text) {
                setRunMessages(prev => [...prev, { role: m.role || 'assistant', text, ts: Date.now() }]);
              }
            }
            setRunStream(null);
            runIdRef.current = null;
          } else if (payload.state === 'aborted') {
            setRunStream(prev => {
              if (prev) {
                setRunMessages(msgs => [...msgs, { role: 'assistant', text: prev, ts: Date.now() }]);
              }
              return null;
            });
            runIdRef.current = null;
          } else if (payload.state === 'error') {
            setRunStream(null);
            runIdRef.current = null;
            setRunError(payload.errorMessage || a.runFailed);
          }
        } else if (msg.type === 'heartbeat') {
          setLastHeartbeat({ ts: Date.now(), status: msg.data?.status || 'running' });
        }
      } catch { /* ignore */ }
    }, (status) => {
      if (status === 'open') {
        opened = true;
        clearTimeout(connectTimeout);
        setWsConnecting(false);
      }
    });

    return () => {
      clearTimeout(connectTimeout);
      unsubscribe();
    };
  }, []);

  // Auto-scroll run panel
  useEffect(() => {
    runEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [runMessages, runStream]);

  const agents: any[] = agentsList?.agents || [];
  const defaultId = agentsList?.defaultId || null;
  const selected = agents.find((ag: any) => ag.id === selectedId) || null;

  // Build model options from gateway config for the edit agent dropdown
  const modelOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    const providers = config?.models?.providers || config?.parsed?.models?.providers || config?.config?.models?.providers || {};
    for (const [pName, pCfg] of Object.entries(providers) as [string, any][]) {
      const models = Array.isArray(pCfg?.models) ? pCfg.models : [];
      for (const m of models) {
        const id = typeof m === 'string' ? m : m?.id;
        if (!id) continue;
        const path = `${pName}/${id}`;
        const name = typeof m === 'object' && m?.name ? m.name : id;
        opts.push({ value: path, label: `${pName} / ${name}` });
      }
    }
    return opts;
  }, [config]);

  const hasUnsavedDraft = useCallback((): boolean => {
    if (!fileActive) return false;
    return fileDrafts[fileActive] != null && fileDrafts[fileActive] !== fileContents[fileActive];
  }, [fileActive, fileDrafts, fileContents]);

  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const data = await gwApi.agents();
      const result = Array.isArray(data) ? { agents: data, defaultId: null } : data;
      setAgentsList(result);
      const list = result?.agents || [];
      setSelectedId(prev => {
        if (prev && list.some((ag: any) => ag.id === prev)) return prev;
        return result?.defaultId || list[0]?.id || null;
      });
      const identityBatch = await Promise.allSettled(
        list.map((ag: any) => gwApi.agentIdentity(ag.id).then((id: any) => ({ agentId: ag.id, id })))
      );
      const newIdentity: Record<string, any> = {};
      for (const r of identityBatch) {
        if (r.status === 'fulfilled') newIdentity[r.value.agentId] = r.value.id;
      }
      setIdentity(prev => ({ ...prev, ...newIdentity }));
    } catch (err: any) { toast('error', err?.message || aRef.current.fetchFailed); }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadConfig = useCallback(() => {
    gwApi.configGet().then(setConfig).catch((err: any) => { toast('error', err?.message || aRef.current.configFetchFailed); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { loadAgents(); loadConfig(); }, []);

  const selectAgent = useCallback(async (id: string) => {
    if (hasUnsavedDraft()) {
      const discard = await confirm({
        title: a.unsavedTitle,
        message: a.unsavedWarning,
        confirmText: a.discard,
        cancelText: a.stayEdit,
      });
      if (!discard) return;
    }
    setSelectedId(id);
    setDrawerOpen(false);
    setFilesList(null); setFileActive(null); setFileContents({}); setFileDrafts({});
    setSkillsReport(null); setSkillsLoaded(false);
  }, [hasUnsavedDraft, confirm, a]);

  const selectPanel = useCallback(async (p: Panel) => {
    if (panel === 'files' && p !== 'files' && hasUnsavedDraft()) {
      const discard = await confirm({
        title: a.unsavedTitle,
        message: a.unsavedWarning,
        confirmText: a.discard,
        cancelText: a.stayEdit,
      });
      if (!discard) return;
    }
    setPanel(p);
    if (p === 'files' && selectedId) {
      gwApi.agentFilesList(selectedId).then(setFilesList).catch((err: any) => { toast('error', err?.message || a.fetchFailed); });
    }
    if (p === 'skills' && selectedId) {
      setSkillsLoaded(false);
      gwApi.agentSkills(selectedId).then((r: any) => { setSkillsReport(r); setSkillsLoaded(true); }).catch((err: any) => { setSkillsLoaded(true); toast('error', err?.message || a.skillsFetchFailed); });
    }
    if (p === 'channels') {
      setChannelsLoading(true);
      gwApi.channels().then(setChannelsSnap).catch((err: any) => { toast('error', err?.message || a.channelsFetchFailed); }).finally(() => setChannelsLoading(false));
    }
    if (p === 'cron') {
      gwApi.cronStatus().then(setCronStatus).catch((err: any) => { toast('error', err?.message || a.cronFetchFailed); });
      gwApi.cron().then((d: any) => setCronJobs(Array.isArray(d) ? d : d?.jobs || [])).catch((err: any) => { toast('error', err?.message || a.cronFetchFailed); });
    }
  }, [selectedId, panel, hasUnsavedDraft, confirm, a]);

  const loadFile = useCallback(async (name: string) => {
    if (!selectedId) return;
    setFileActive(name);
    if (fileContents[name] != null) return;
    try {
      const res = await gwApi.agentFileGet(selectedId, name);
      const content = (res as any)?.file?.content || '';
      setFileContents(prev => ({ ...prev, [name]: content }));
      setFileDrafts(prev => ({ ...prev, [name]: content }));
    } catch (err: any) { toast('error', err?.message || a.fileLoadFailed); }
  }, [selectedId, fileContents]);

  const saveFile = useCallback(async () => {
    if (!selectedId || !fileActive) return;
    const confirmed = await confirm({
      title: a.confirmSave,
      message: (a.confirmSaveMsg || '').replace('{file}', fileActive),
      confirmText: a.save,
      cancelText: a.cancel,
    });
    if (!confirmed) return;
    setFileSaving(true);
    try {
      await gwApi.agentFileSet(selectedId, fileActive, fileDrafts[fileActive] || '');
      setFileContents(prev => ({ ...prev, [fileActive!]: fileDrafts[fileActive!] || '' }));
    } catch (err: any) { toast('error', err?.message || a.fileSaveFailed); }
    setFileSaving(false);
  }, [selectedId, fileActive, fileDrafts, a]);

  // CRUD state
  const [crudMode, setCrudMode] = useState<'create' | 'edit' | null>(null);
  const [crudName, setCrudName] = useState('');
  const [crudWorkspace, setCrudWorkspace] = useState('');
  const [crudModel, setCrudModel] = useState('');
  const [crudEmoji, setCrudEmoji] = useState('');
  const [crudDefault, setCrudDefault] = useState(false);
  const [crudTheme, setCrudTheme] = useState('');
  const [crudBusy, setCrudBusy] = useState(false);
  const [crudError, setCrudError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(true);

  // Wake state
  const [waking, setWaking] = useState(false);
  const [wakeResult, setWakeResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Browser request state
  const [browserUrl, setBrowserUrl] = useState('');
  const [browserMethod, setBrowserMethod] = useState('GET');
  const [browserBody, setBrowserBody] = useState('');
  const [browserSending, setBrowserSending] = useState(false);
  const [browserResult, setBrowserResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Wake menu state (click-based for mobile support)
  const [wakeMenuOpen, setWakeMenuOpen] = useState(false);

  const handleWake = useCallback(async (mode: 'now' | 'next-heartbeat') => {
    setWakeMenuOpen(false);
    setWaking(true);
    setWakeResult(null);
    try {
      await gwApi.proxy('wake', { mode, text: a.wakeText });
      setWakeResult({ ok: true, text: a.wakeOk });
      setTimeout(() => setWakeResult(null), 3000);
    } catch (err: any) {
      setWakeResult({ ok: false, text: `${a.wakeFailed}: ${err?.message || ''}` });
    }
    setWaking(false);
  }, [a]);

  const handleBrowserRequest = useCallback(async () => {
    if (!browserUrl.trim() || browserSending) return;
    setBrowserSending(true);
    setBrowserResult(null);
    try {
      const payload: any = { method: browserMethod, path: browserUrl.trim() };
      if (['POST', 'PUT', 'PATCH'].includes(browserMethod) && browserBody.trim()) {
        try { payload.body = JSON.parse(browserBody.trim()); } catch { payload.body = browserBody.trim(); }
      }
      const res = await gwApi.proxy('browser.request', payload) as any;
      setBrowserResult({ ok: true, text: `${a.browserOk}${res?.status ? ` (${res.status})` : ''}` });
    } catch (err: any) {
      setBrowserResult({ ok: false, text: `${a.browserFailed}: ${err?.message || ''}` });
    }
    setBrowserSending(false);
  }, [browserUrl, browserMethod, browserBody, browserSending, a]);

  const openCreate = useCallback(() => {
    setCrudMode('create');
    // Generate a unique default name
    const existingIds = new Set(agents.map((ag: any) => ag.id));
    let idx = agents.length + 1;
    let suggestedName = `agent-${idx}`;
    while (existingIds.has(suggestedName)) { idx++; suggestedName = `agent-${idx}`; }
    // Derive workspace base path from existing agents
    let wsBase = '';
    if (config) {
      const cfg0 = config?.agents || config?.parsed?.agents || config?.config?.agents || {};
      const list = cfg0?.list || [];
      const defaults = cfg0?.defaults;
      const refEntry = list.find((e: any) => e?.workspace) || defaults;
      const refWs = refEntry?.workspace || '';
      if (refWs) {
        // Extract base dir: e.g. "/home/user/.openclaw/workspace-shop" → "/home/user/.openclaw"
        const sep = refWs.includes('\\') ? '\\' : '/';
        const lastSep = refWs.lastIndexOf(sep);
        wsBase = lastSep > 0 ? refWs.slice(0, lastSep) : refWs;
      }
    }
    const suggestedWs = wsBase ? `${wsBase}${wsBase.includes('\\') ? '\\' : '/'}workspace-${suggestedName}` : '';
    setCrudName(suggestedName);
    setCrudWorkspace(suggestedWs);
    setCrudModel('');
    setCrudEmoji('🤖');
    setCrudDefault(false);
    setCrudTheme('');
    setCrudError(null);
  }, [agents, config]);

  const openEdit = useCallback(() => {
    if (!selected) return;
    setCrudMode('edit');
    // Read raw values from config entry (not display labels)
    const cfg0 = config?.agents || config?.parsed?.agents || config?.config?.agents || {};
    const list = cfg0?.list || [];
    const entry = list.find((e: any) => e?.id === selected.id);
    const defaults = cfg0?.defaults;
    const rawWorkspace = entry?.workspace || defaults?.workspace || '';
    const rawModel = entry?.model || defaults?.model || '';
    const modelStr = typeof rawModel === 'string' ? rawModel : (rawModel?.primary || '');
    const isDefault = selected.id === defaultId;
    const theme = selected.identity?.theme || identity[selected.id]?.theme || '';
    setCrudName(resolveLabel(selected));
    setCrudWorkspace(rawWorkspace);
    setCrudModel(modelStr);
    setCrudEmoji(resolveEmoji(selected));
    setCrudDefault(isDefault);
    setCrudTheme(theme);
    setCrudError(null);
  }, [selected, config, defaultId, identity]);

  const handleCreate = useCallback(async () => {
    if (!gwReady || crudBusy) return;
    if (!crudName.trim()) return;
    if (!AGENT_NAME_RE.test(crudName.trim())) {
      setCrudError(a.nameValidation);
      return;
    }
    setCrudBusy(true); setCrudError(null);
    try {
      await gwApi.proxy('agents.create', {
        name: crudName.trim(),
        workspace: crudWorkspace.trim() || undefined,
        emoji: crudEmoji.trim() || undefined,
      });
      // Patch config for model/default/emoji/theme if specified
      if (crudModel.trim() || crudDefault || crudEmoji.trim() || crudTheme.trim()) {
        try {
          const cfgRaw = await gwApi.configGet() as any;
          const baseHash = cfgRaw?.hash || cfgRaw?.baseHash || '';
          const agentEntry: Record<string, any> = { id: crudName.trim() };
          if (crudModel.trim()) agentEntry.model = crudModel.trim();
          if (crudDefault) agentEntry.default = true;
          const identityPatch: Record<string, any> = {};
          if (crudEmoji.trim()) identityPatch.emoji = crudEmoji.trim();
          if (crudTheme.trim()) identityPatch.theme = crudTheme.trim();
          if (Object.keys(identityPatch).length > 0) agentEntry.identity = identityPatch;
          await gwApi.configPatch(JSON.stringify({ agents: { list: [agentEntry] } }), baseHash);
        } catch { /* best-effort */ }
      }
      setCrudMode(null);
      loadAgents();
      loadConfig();
    } catch (err: any) {
      setCrudError(aRef.current.createFailed + ': ' + (err?.message || ''));
    }
    setCrudBusy(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crudName, crudWorkspace, crudEmoji, crudModel, crudDefault, crudTheme, crudBusy, loadAgents]);

  const handleUpdate = useCallback(async () => {
    if (!gwReady || crudBusy || !selectedId) return;
    setCrudBusy(true); setCrudError(null);
    try {
      // Build a minimal agent entry patch
      const agentEntry: Record<string, any> = { id: selectedId };
      if (crudName.trim()) agentEntry.name = crudName.trim();
      if (crudWorkspace.trim()) agentEntry.workspace = crudWorkspace.trim();
      if (crudModel.trim()) agentEntry.model = crudModel.trim();
      agentEntry.default = crudDefault || undefined;
      // Build identity patch (emoji + theme)
      const identityPatch: Record<string, any> = {};
      if (crudEmoji.trim()) identityPatch.emoji = crudEmoji.trim();
      if (crudTheme.trim()) identityPatch.theme = crudTheme.trim();
      if (Object.keys(identityPatch).length > 0) agentEntry.identity = identityPatch;
      // Patch config via config.patch (merges agents.list by id)
      const cfgRaw = await gwApi.configGet() as any;
      const baseHash = cfgRaw?.hash || cfgRaw?.baseHash || '';
      const patch = { agents: { list: [agentEntry] } };
      await gwApi.configPatch(JSON.stringify(patch), baseHash);
      setCrudMode(null);
      loadAgents();
      loadConfig();
    } catch (err: any) {
      setCrudError(aRef.current.updateFailed + ': ' + (err?.message || ''));
    }
    setCrudBusy(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, crudName, crudWorkspace, crudModel, crudEmoji, crudDefault, crudTheme, crudBusy, loadAgents]);

  const handleDelete = useCallback(async () => {
    if (!gwReady || crudBusy || !selectedId) return;
    setCrudBusy(true); setCrudError(null);
    try {
      await gwApi.proxy('agents.delete', { agentId: selectedId, deleteFiles });
      setDeleteConfirm(false);
      setSelectedId(null);
      loadAgents();
    } catch (err: any) {
      setCrudError(aRef.current.deleteFailed + ': ' + (err?.message || ''));
    }
    setCrudBusy(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, deleteFiles, crudBusy, loadAgents]);

  const resolveLabel = (ag: any) => {
    const id = identity[ag.id];
    const explicitName = ag.name?.trim();
    if (explicitName && explicitName !== ag.id) return explicitName;
    return id?.name?.trim() || ag.identity?.name?.trim() || explicitName || ag.id;
  };
  const resolveEmoji = (ag: any) => {
    const id = identity[ag.id];
    return id?.emoji?.trim() || ag.identity?.emoji?.trim() || id?.avatar?.trim() || ag.identity?.avatar?.trim() || '';
  };

  const resolveAgentConfig = (agentId: string) => {
    if (!config) return { model: na, workspace: a.workspaceDefault, skills: null, tools: null };
    const cfg0 = config?.agents || config?.parsed?.agents || config?.config?.agents || {};
    const list = cfg0?.list || [];
    const entry = list.find((e: any) => e?.id === agentId);
    const defaults = cfg0?.defaults;
    const model = entry?.model || defaults?.model;
    const modelLabel = typeof model === 'string' ? model : (model?.primary || na);
    const fallbacks = typeof model === 'object' ? model?.fallbacks : null;
    const toolsCfg = config?.tools || config?.parsed?.tools || config?.config?.tools || null;
    return {
      model: modelLabel + (Array.isArray(fallbacks) && fallbacks.length > 0 ? ` (+${fallbacks.length})` : ''),
      workspace: entry?.workspace || defaults?.workspace || a.workspaceDefault,
      skills: entry?.skills || null,
      tools: entry?.tools || toolsCfg,
    };
  };

  // Send message to agent via REST proxy (streaming events come via Manager WS)
  const sendToAgent = useCallback(async () => {
    if (!gwReady || runSending || !selectedId) return;
    const msg = runInput.trim();
    if (!msg) return;

    // SessionKey format: agent:<agentId>:<sessionName>
    const sessionName = `run-${Date.now()}`;
    const sessionKey = `agent:${selectedId}:${sessionName}`;
    runSessionRef.current = sessionKey;

    setRunMessages(prev => [...prev, { role: 'user', text: msg, ts: Date.now() }]);
    setRunInput('');
    setRunSending(true);
    setRunError(null);
    setRunStream('');

    try {
      const idempotencyKey = `${sessionKey}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const res = await gwApi.proxy('chat.send', {
        sessionKey,
        message: msg,
        idempotencyKey,
      }) as any;
      runIdRef.current = res?.runId || idempotencyKey;
    } catch (err: any) {
      setRunStream(null);
      setRunError(err?.message || aRef.current.runFailed);
    } finally {
      setRunSending(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runInput, runSending, selectedId]);

  const handleRunAbort = useCallback(async () => {
    if (!gwReady) return;
    try {
      await gwApi.proxy('chat.abort', { sessionKey: runSessionRef.current, runId: runIdRef.current || undefined });
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRunKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendToAgent();
    }
  }, [sendToAgent]);

  const handleRunInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setRunInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, []);

  const isRunStreaming = runIdRef.current !== null || runStream !== null;

  const ma = ((t as any).multiAgent || {}) as any;
  const sc = ((t as any).scenario || {}) as any;
  const TABS: { id: Panel; icon: string; label: string }[] = [
    { id: 'overview', icon: 'dashboard', label: a.overview },
    { id: 'files', icon: 'description', label: a.files },
    { id: 'tools', icon: 'build', label: a.tools },
    { id: 'skills', icon: 'extension', label: a.skills },
    { id: 'channels', icon: 'forum', label: a.channels },
    { id: 'cron', icon: 'schedule', label: a.cron },
    { id: 'run', icon: 'play_arrow', label: a.run },
    { id: 'scenarios', icon: 'auto_awesome', label: sc.title || 'Scenarios' },
    { id: 'collaboration', icon: 'groups', label: ma.title || 'Multi-Agent' },
  ];

  const TOOL_SECTIONS = [
    { label: 'Files', tools: ['read', 'write', 'edit', 'apply_patch'] },
    { label: 'Runtime', tools: ['exec', 'process'] },
    { label: 'Web', tools: ['web_search', 'web_fetch'] },
    { label: 'Memory', tools: ['memory_search', 'memory_get'] },
    { label: 'Sessions', tools: ['sessions_list', 'sessions_history', 'sessions_send', 'sessions_spawn', 'session_status'] },
    { label: 'UI', tools: ['browser', 'canvas'] },
    { label: 'Messaging', tools: ['message'] },
    { label: 'Automation', tools: ['cron', 'gateway'] },
    { label: 'Agents', tools: ['agents_list'] },
    { label: 'Media', tools: ['image'] },
  ];

  return (
    <div className="flex-1 flex overflow-hidden bg-slate-50/50 dark:bg-transparent">
      {/* Mobile drawer overlay */}
      {drawerOpen && (
        <div className="md:hidden fixed top-[32px] bottom-[72px] start-0 end-0 z-40 bg-black/40 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />
      )}

      {/* Sidebar — desktop: static, mobile: slide-out drawer */}
      <div className={`fixed md:static top-[32px] bottom-[72px] md:top-auto md:bottom-auto start-0 z-50 w-64 md:w-56 lg:w-64 shrink-0 border-e border-slate-200/60 dark:border-white/[0.06] theme-panel flex flex-col transform transition-transform duration-200 ease-out ${drawerOpen ? 'translate-x-0' : '-translate-x-full rtl:translate-x-full md:translate-x-0'}`}>
        <div className="p-3 border-b border-slate-200/60 dark:border-white/[0.06] neon-divider">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xs font-bold text-slate-700 dark:text-white/80">{a.title}</h2>
              <p className="text-[11px] text-slate-400 dark:text-white/35">{agents.length} {menuAgentsLabel}</p>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={openCreate} disabled={!gwReady}
                className="p-1 rounded-lg text-slate-400 hover:text-primary hover:bg-primary/5 transition-all disabled:opacity-30"
                title={a.createAgent}>
                <span className="material-symbols-outlined text-[16px]">add</span>
              </button>
              <button onClick={loadAgents} disabled={loading} className="p-1 rounded-lg text-slate-400 hover:text-primary hover:bg-primary/5 transition-all disabled:opacity-40">
                <span className={`material-symbols-outlined text-[16px] ${loading ? 'animate-spin' : ''}`}>refresh</span>
              </button>
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar neon-scrollbar p-1.5 space-y-0.5">
          {agents.length === 0 ? (
            <p className="text-[10px] text-slate-400 dark:text-white/20 text-center py-8">{a.noAgents}</p>
          ) : agents.map((ag: any) => {
            const emoji = resolveEmoji(ag);
            const label = resolveLabel(ag);
            const isDefault = ag.id === defaultId;
            const isSelected = ag.id === selectedId;
            return (
              <button key={ag.id} onClick={() => selectAgent(ag.id)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-start transition-all ${isSelected ? 'bg-primary/10 border border-primary/20 glow-border' : 'hover:bg-slate-100 dark:hover:bg-white/[0.03] border border-transparent'}`}>
                <div className={`relative w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 ${isSelected ? 'bg-primary/20 text-primary' : 'theme-field theme-text-muted'}`}>
                  {emoji || label.slice(0, 1).toUpperCase()}
                  {lastHeartbeat && (Date.now() - lastHeartbeat.ts < 120000) && (
                    <span className="absolute -bottom-0.5 -end-0.5 w-2.5 h-2.5 rounded-full bg-mac-green border-2 border-white dark:border-[#1a1c22]" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-[11px] font-semibold truncate ${isSelected ? 'text-primary' : 'text-slate-700 dark:text-white/70'}`}>{label}</p>
                  <p className="text-[11px] text-slate-400 dark:text-white/35 font-mono truncate">{ag.id}</p>
                </div>
                {isDefault && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-bold shrink-0">default</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selected ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Mobile hamburger for empty state */}
            <div className="md:hidden flex items-center px-4 pt-3 pb-1 shrink-0">
              <button onClick={() => setDrawerOpen(true)} className="p-1.5 -ms-1 rounded-lg text-slate-500 dark:text-white/50 hover:text-primary hover:bg-primary/5 transition-all">
                <span className="material-symbols-outlined text-[20px]">menu</span>
              </button>
            </div>
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-slate-400 dark:text-white/20">
                <span className="material-symbols-outlined text-4xl mb-2 animate-glow-breathe">smart_toy</span>
                <p className="text-sm">{a.selectAgent}</p>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Agent Header */}
            <div className="shrink-0 px-4 md:px-5 pt-3 md:pt-4 pb-0">
              <div className="flex items-center gap-3">
                {/* Hamburger menu — mobile only */}
                <button onClick={() => setDrawerOpen(true)} className="md:hidden p-1.5 -ms-1 rounded-lg text-slate-500 dark:text-white/50 hover:text-primary hover:bg-primary/5 transition-all shrink-0">
                  <span className="material-symbols-outlined text-[20px]">menu</span>
                </button>
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-lg font-bold text-primary shrink-0 animate-glow-breathe">
                  {resolveEmoji(selected) || resolveLabel(selected).slice(0, 1).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-bold text-slate-800 dark:text-white truncate">{resolveLabel(selected)}</h2>
                    {selected.id === defaultId && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-bold">{(t as any).default}</span>}
                  </div>
                  <p className="text-[10px] text-slate-400 dark:text-white/40 font-mono">{selected.id}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <div className="relative">
                    <button onClick={() => setWakeMenuOpen(v => !v)} disabled={!gwReady || waking}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-amber-500 hover:bg-amber-500/5 transition-all disabled:opacity-30"
                      title={a.wake}>
                      <span className={`material-symbols-outlined text-[16px] ${waking ? 'animate-spin' : ''}`}>{waking ? 'progress_activity' : 'alarm'}</span>
                    </button>
                    {wakeMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-20" onClick={() => setWakeMenuOpen(false)} />
                        <div className="absolute end-0 top-full mt-1 z-30">
                          <div className="theme-panel sci-card rounded-xl shadow-xl p-1 min-w-[140px]">
                            <button onClick={() => handleWake('now')}
                              className="w-full text-start px-3 py-1.5 rounded-lg text-[10px] font-bold theme-text-secondary hover:bg-amber-500/10 hover:text-amber-600 transition-colors">
                              {a.wakeNow}
                            </button>
                            <button onClick={() => handleWake('next-heartbeat')}
                              className="w-full text-start px-3 py-1.5 rounded-lg text-[10px] font-bold theme-text-secondary hover:bg-amber-500/10 hover:text-amber-600 transition-colors">
                              {a.wakeNext}
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                  <button onClick={openEdit} disabled={!gwReady}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-primary hover:bg-primary/5 transition-all disabled:opacity-30"
                    title={a.edit}>
                    <span className="material-symbols-outlined text-[16px]">edit</span>
                  </button>
                  <button onClick={() => selected.id !== defaultId && setDeleteConfirm(true)}
                    disabled={!gwReady || selected.id === defaultId}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-mac-red hover:bg-mac-red/5 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                    title={selected.id === defaultId ? a.defaultCannotDelete : a.delete}>
                    <span className="material-symbols-outlined text-[16px]">delete</span>
                  </button>
                </div>
                {wakeResult && (
                  <div className={`absolute top-14 end-4 px-3 py-1.5 rounded-xl text-[10px] font-bold z-30 shadow-lg ${wakeResult.ok ? 'bg-mac-green/10 text-mac-green border border-mac-green/20' : 'bg-red-50 dark:bg-red-500/5 text-red-500 border border-red-200 dark:border-red-500/20'}`}>
                    {wakeResult.text}
                  </div>
                )}
              </div>

              {/* Tabs — horizontally scrollable on mobile */}
              <div className="flex gap-0.5 mt-3 border-b border-slate-200/60 dark:border-white/[0.06] overflow-x-auto no-scrollbar neon-divider">
                {TABS.map(tab => (
                  <button key={tab.id} onClick={() => selectPanel(tab.id)}
                    className={`px-3 py-2 text-[11px] font-medium border-b-2 transition-all whitespace-nowrap shrink-0 flex items-center gap-1 ${panel === tab.id ? 'border-primary text-primary' : 'border-transparent theme-text-muted hover:text-slate-700 dark:hover:text-white/60'}`}>
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Panel Content */}
            <div className="flex-1 overflow-y-auto custom-scrollbar neon-scrollbar p-4 md:p-5">
              {/* Overview Panel */}
              {panel === 'overview' && (() => {
                const cfg = resolveAgentConfig(selected.id);
                const ident = identity[selected.id];
                return (
                  <div className="space-y-4 max-w-5xl">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {[
                        { label: a.workspace, value: cfg.workspace, icon: 'folder' },
                        { label: a.model, value: cfg.model, icon: 'smart_toy' },
                        { label: a.identity, value: ident?.name || selected.identity?.name || na, icon: 'person' },
                        { label: a.agentStatus, value: lastHeartbeat && (Date.now() - lastHeartbeat.ts < 120000) ? a.online : a.offline, icon: 'circle', statusColor: lastHeartbeat && (Date.now() - lastHeartbeat.ts < 120000) ? 'text-mac-green' : 'text-slate-400' },
                        { label: a.lastHeartbeat, value: lastHeartbeat ? fmtHeartbeatAgo(lastHeartbeat.ts, a.heartbeatAgo, a.heartbeatNever) : a.heartbeatNever, icon: 'favorite' },
                        { label: a.isDefault, value: selected.id === defaultId ? a.yes : a.no, icon: 'star' },
                        { label: a.skills, value: cfg.skills ? `${cfg.skills.length} selected` : (t as any).menu?.all, icon: 'extension' },
                      ].map((kv: any) => (
                        <div key={kv.label} className="rounded-xl bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06] p-3 sci-card">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <span className={`material-symbols-outlined text-[13px] ${kv.statusColor || 'text-slate-400 dark:text-white/40'}`}>{kv.icon}</span>
                            <span className="text-[11px] font-bold text-slate-400 dark:text-white/40 uppercase">{kv.label}</span>
                          </div>
                          <p className={`text-[11px] font-semibold font-mono truncate ${kv.statusColor || 'text-slate-700 dark:text-white/70'}`}>{kv.value}</p>
                        </div>
                      ))}
                    </div>
                    {selected.identity?.theme && (
                      <div className="rounded-xl bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06] p-3">
                        <p className="text-[11px] font-bold text-slate-400 dark:text-white/40 uppercase mb-1">{a.theme}</p>
                        <p className="text-[11px] text-slate-600 dark:text-white/50">{selected.identity.theme}</p>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Files Panel */}
              {panel === 'files' && (
                <div className="flex flex-col md:flex-row gap-4 max-w-5xl" style={{ minHeight: 300 }}>
                  <div className="w-full md:w-48 shrink-0 space-y-1">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-bold theme-text-muted uppercase">{a.coreFiles}</span>
                      <button onClick={() => selectedId && gwApi.agentFilesList(selectedId).then(setFilesList).catch((err: any) => { toast('error', err?.message || a.fetchFailed); })} className="text-[10px] text-primary hover:underline">{a.refresh}</button>
                    </div>
                    {(filesList?.files || []).length === 0 ? (
                      <p className="text-[10px] text-slate-400 dark:text-white/20 py-4 text-center">{a.noFiles}</p>
                    ) : (filesList?.files || []).map((f: any) => (
                      <button key={f.name} onClick={() => loadFile(f.name)}
                        className={`w-full text-start px-2.5 py-2 rounded-lg text-[10px] transition-all ${fileActive === f.name ? 'bg-primary/10 text-primary border border-primary/20' : 'hover:bg-slate-100 dark:hover:bg-white/[0.03] border border-transparent'}`}>
                        <p className="font-mono font-semibold truncate">{f.name}</p>
                        <p className="text-[11px] text-slate-400 dark:text-white/35 mt-0.5">
                          {f.missing ? <span className="text-mac-yellow">{a.fileMissing}</span> : fmtBytes(f.size)}
                        </p>
                      </button>
                    ))}
                  </div>
                  <div className="flex-1 min-w-0">
                    {!fileActive ? (
                      <div className="flex items-center justify-center h-full text-slate-400 dark:text-white/20 text-[11px]">{a.selectFile}</div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-mono font-bold theme-text-secondary">{fileActive}</span>
                          <div className="flex gap-2">
                            {/* Template insert dropdown */}
                            {fileActive && fileTemplates.filter(t => t.targetFile === fileActive).length > 0 && (
                              <div className="relative">
                                <button onClick={() => setTplDropdown(!tplDropdown)}
                                  className="text-[10px] px-2 py-1 rounded-lg border border-primary/30 text-primary hover:bg-primary/5 font-bold transition-colors flex items-center gap-1">
                                  <span className="material-symbols-outlined text-[12px]">auto_fix_high</span>
                                  {a.insertTemplate}
                                </button>
                                {tplDropdown && (
                                  <div className="absolute end-0 top-full mt-1 z-30 theme-panel sci-card rounded-xl shadow-xl p-1 min-w-[200px]">
                                    {fileTemplates.filter(t => t.targetFile === fileActive).map((tpl: WorkspaceTemplate) => {
                                      const resolved = templateSystem.resolveI18n(tpl, language);
                                      return (
                                        <button key={tpl.id} onClick={() => {
                                          setFileDrafts(prev => ({ ...prev, [fileActive!]: resolved.content }));
                                          setTplDropdown(false);
                                        }}
                                          className="w-full text-start px-3 py-2 rounded-lg text-[10px] hover:bg-primary/5 transition-colors flex items-center gap-2">
                                          <span className="material-symbols-outlined text-[14px] text-primary">{tpl.icon}</span>
                                          <div className="min-w-0">
                                            <p className="font-bold text-slate-700 dark:text-white/70">{resolved.name}</p>
                                            <p className="text-[11px] text-slate-400 dark:text-white/35 truncate">{resolved.desc}</p>
                                          </div>
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            )}
                            <button onClick={() => { if (fileActive) setFileDrafts(prev => ({ ...prev, [fileActive]: fileContents[fileActive] || '' })); }}
                              disabled={!fileActive || fileDrafts[fileActive] === fileContents[fileActive]}
                              className="text-[10px] px-2 py-1 rounded-lg theme-field theme-text-secondary disabled:opacity-30">{a.reset}</button>
                            <button onClick={saveFile} disabled={fileSaving || !fileActive || fileDrafts[fileActive] === fileContents[fileActive]}
                              className="text-[10px] px-3 py-1 rounded-lg bg-primary text-white font-bold disabled:opacity-30">{fileSaving ? a.saving : a.save}</button>
                          </div>
                        </div>
                        <textarea
                          value={fileDrafts[fileActive] ?? fileContents[fileActive] ?? ''}
                          onChange={e => setFileDrafts(prev => ({ ...prev, [fileActive!]: e.target.value }))}
                          className="w-full h-80 p-3 rounded-xl bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06] text-[11px] font-mono text-slate-700 dark:text-white/70 resize-none focus:outline-none focus:ring-1 focus:ring-primary/30"
                          spellCheck={false}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Tools Panel */}
              {panel === 'tools' && (() => {
                const cfg = resolveAgentConfig(selected.id);
                const tools = cfg.tools || {};
                const profile = tools.profile || 'full';
                return (
                  <div className="space-y-4 max-w-5xl">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-[11px] font-bold theme-text-secondary uppercase">{a.toolAccess}</h3>
                        <p className="text-[11px] text-slate-400 dark:text-white/35 mt-0.5">{a.profile}: <span className="font-mono text-primary">{profile}</span></p>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {TOOL_SECTIONS.map(section => (
                        <div key={section.label} className="rounded-xl bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06] p-3">
                          <p className="text-[10px] font-bold theme-text-muted uppercase mb-2">{section.label}</p>
                          <div className="space-y-1">
                            {section.tools.map(tool => {
                              const denied = Array.isArray(tools.deny) && tools.deny.includes(tool);
                              const allowed = !denied;
                              return (
                                <div key={tool} className="flex items-center justify-between py-1">
                                  <span className="text-[10px] font-mono text-slate-600 dark:text-white/50">{tool}</span>
                                  <div className={`w-2 h-2 rounded-full ${allowed ? 'bg-mac-green' : 'bg-slate-300 dark:bg-white/10'}`} />
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Skills Panel */}
              {panel === 'skills' && (() => {
                const allSkills: any[] = skillsReport?.skills || [];
                // Filter skills based on selected filter
                const skills = allSkills.filter((sk: any) => {
                  if (skillsFilter === 'ready') return sk.eligible;
                  if (skillsFilter === 'notReady') return !sk.eligible;
                  return true; // 'all'
                });
                const groups: Record<string, any[]> = {};
                skills.forEach((sk: any) => {
                  const src = sk.bundled ? a.sourceBuiltIn : (sk.source || a.sourceOther);
                  if (!groups[src]) groups[src] = [];
                  groups[src].push(sk);
                });
                const readyCount = allSkills.filter(sk => sk.eligible).length;
                const notReadyCount = allSkills.filter(sk => !sk.eligible).length;
                return (
                  <div className="space-y-4 max-w-5xl">
                    <div className="flex items-center justify-between">
                      <h3 className="text-[11px] font-bold theme-text-secondary uppercase">{a.skills}</h3>
                      <button onClick={() => {
                        if (!selectedId) return;
                        setSkillsLoaded(false);
                        gwApi.agentSkills(selectedId).then((r: any) => { setSkillsReport(r); setSkillsLoaded(true); }).catch((err: any) => { setSkillsLoaded(true); toast('error', err?.message || a.skillsFetchFailed); });
                      }}
                        className="text-[10px] text-primary hover:underline">{a.refresh}</button>
                    </div>
                    {/* Filter buttons */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setSkillsFilter('ready')}
                        className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all ${
                          skillsFilter === 'ready'
                            ? 'bg-mac-green/10 text-mac-green border border-mac-green/20'
                            : 'bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-white/40 hover:bg-slate-200 dark:hover:bg-white/10'
                        }`}
                      >
                        {a.eligible || '就绪'} ({readyCount})
                      </button>
                      <button
                        onClick={() => setSkillsFilter('notReady')}
                        className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all ${
                          skillsFilter === 'notReady'
                            ? 'bg-slate-200 dark:bg-white/10 text-slate-700 dark:text-white/70 border border-slate-300 dark:border-white/20'
                            : 'bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-white/40 hover:bg-slate-200 dark:hover:bg-white/10'
                        }`}
                      >
                        {a.notEligible || '未就绪'} ({notReadyCount})
                      </button>
                      <button
                        onClick={() => setSkillsFilter('all')}
                        className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all ${
                          skillsFilter === 'all'
                            ? 'bg-primary/10 text-primary border border-primary/20'
                            : 'bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-white/40 hover:bg-slate-200 dark:hover:bg-white/10'
                        }`}
                      >
                        {a.all || '全部'} ({allSkills.length})
                      </button>
                    </div>
                    {skills.length === 0 ? (
                      <p className="text-[10px] text-slate-400 dark:text-white/20 py-8 text-center">{!skillsLoaded ? a.loading : a.noSkills}</p>
                    ) : Object.entries(groups).map(([group, items]) => (
                      <div key={group}>
                        <p className="text-[11px] font-bold text-slate-400 dark:text-white/35 uppercase mb-2">{group} ({items.length})</p>
                        <div className="space-y-1">
                          {items.map((sk: any) => (
                            <div key={sk.name} className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06]">
                              <div className={`w-2 h-2 rounded-full shrink-0 ${sk.eligible ? 'bg-mac-green' : 'bg-slate-300 dark:bg-white/10'}`} />
                              <div className="flex-1 min-w-0">
                                <p className="text-[10px] font-semibold text-slate-700 dark:text-white/60 truncate">{sk.name}</p>
                                {sk.description && <p className="text-[11px] text-slate-400 dark:text-white/35 truncate">{sk.description}</p>}
                              </div>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${sk.eligible ? 'bg-mac-green/10 text-mac-green' : 'bg-slate-100 dark:bg-white/5 text-slate-400'}`}>
                                {sk.eligible ? a.eligible : a.notEligible}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Channels Panel */}
              {panel === 'channels' && (() => {
                // Parse channel data from OpenClaw Gateway channels.status response
                let channels: any[] = [];
                if (channelsSnap && typeof channelsSnap === 'object') {
                  const order = channelsSnap.channelOrder || [];
                  const channelData = channelsSnap.channels || {};
                  const accounts = channelsSnap.channelAccounts || {};
                  const labels = channelsSnap.channelLabels || {};
                  const meta = channelsSnap.channelMeta || [];
                  
                  // Build channel list from channelOrder
                  channels = order.map((id: string) => {
                    const data = channelData[id];
                    const accountList = accounts[id] || [];
                    const metaEntry = meta.find((m: any) => m.id === id);
                    const label = metaEntry?.label || labels[id] || id;
                    
                    // Determine connection status from accounts
                    let connected = false;
                    let running = false;
                    if (accountList.length > 0) {
                      connected = accountList.some((acc: any) => acc.connected);
                      running = accountList.some((acc: any) => acc.running);
                    } else if (data && typeof data === 'object') {
                      connected = (data as any).connected || false;
                      running = (data as any).running || false;
                    }
                    
                    return {
                      id,
                      label,
                      connected,
                      running,
                      accounts: accountList,
                      data
                    };
                  });
                }
                return (
                  <div className="space-y-4 max-w-5xl">
                    <div className="flex items-center justify-between">
                      <h3 className="text-[11px] font-bold text-slate-600 dark:text-white/60 uppercase">{a.channels}</h3>
                      <button onClick={() => { setChannelsLoading(true); gwApi.channels().then(setChannelsSnap).catch((err: any) => { toast('error', err?.message || a.channelsFetchFailed); }).finally(() => setChannelsLoading(false)); }}
                        className="text-[10px] text-primary hover:underline">{a.refresh}</button>
                    </div>
                    {channelsLoading ? (
                      <p className="text-[10px] text-slate-400 dark:text-white/20 py-8 text-center">{a.loading}</p>
                    ) : channels.length === 0 ? (
                      <p className="text-[10px] text-slate-400 dark:text-white/20 py-8 text-center">{a.noChannels}</p>
                    ) : (
                      <div className="space-y-2">
                        {channels.map((ch: any, i: number) => {
                          const id = ch.id || ch.name || `ch-${i}`;
                          const label = ch.label || ch.name || id;
                          const isConn = ch.connected || ch.running || ch.status === 'connected';
                          return (
                            <div key={id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06]">
                              <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${isConn ? 'bg-mac-green animate-pulse' : 'bg-slate-300 dark:bg-white/10'}`} />
                              <div className="flex-1 min-w-0">
                                <p className="text-[11px] font-semibold text-slate-700 dark:text-white/60">{label}</p>
                                <p className="text-[11px] text-slate-400 dark:text-white/35 font-mono">{id}</p>
                              </div>
                              <span className={`text-[11px] font-bold ${isConn ? 'text-mac-green' : 'text-slate-400'}`}>{isConn ? a.connected : a.disabled}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Run Panel */}
              {panel === 'run' && (
                <div className="flex flex-col max-w-5xl h-full">
                  {!gwReady ? (
                    <div className="flex flex-col items-center justify-center py-16 text-slate-400 dark:text-white/20">
                      <span className="material-symbols-outlined text-3xl mb-2">{wsConnecting ? 'progress_activity' : 'cloud_off'}</span>
                      <p className="text-[11px]">{wsConnecting ? a.wsConnecting : a.wsError}</p>
                      {!wsConnecting && <p className="text-[11px] mt-1">{a.configMissing}</p>}
                    </div>
                  ) : (
                    <>
                      {/* Header with clear button */}
                      {runMessages.length > 0 && (
                        <div className="flex justify-end mb-2 shrink-0">
                          <button onClick={async () => {
                            const ok = await confirm({ title: a.clearChat, message: a.clearChatConfirm, confirmText: a.delete, cancelText: a.cancel });
                            if (ok) { setRunMessages([]); setRunStream(null); setRunError(null); }
                          }} className="text-[10px] px-2 py-1 rounded-lg text-slate-400 hover:text-mac-red hover:bg-mac-red/5 transition-all flex items-center gap-1">
                            <span className="material-symbols-outlined text-[12px]">delete_sweep</span>
                            {a.clearChat}
                          </button>
                        </div>
                      )}
                      {/* Messages */}
                      <div className="flex-1 overflow-y-auto custom-scrollbar neon-scrollbar space-y-3 mb-4">
                        {runMessages.length === 0 && !runStream && (
                          <div className="flex flex-col items-center py-12 text-slate-400 dark:text-white/20">
                            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
                              <span className="material-symbols-outlined text-[24px] text-primary">play_arrow</span>
                            </div>
                            <p className="text-[11px] font-medium text-slate-500 dark:text-white/40">{a.runAgent}</p>
                            <p className="text-[11px] mt-1">{a.runPrompt}</p>
                          </div>
                        )}

                        {runMessages.map((msg, idx) => {
                          const isUser = msg.role === 'user';
                          return (
                            <div key={idx} className={`flex items-start gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
                              <div className={`w-7 h-7 shrink-0 rounded-lg flex items-center justify-center border mt-0.5 ${isUser
                                ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-black border-slate-700 dark:border-slate-300'
                                : 'bg-primary/10 border-primary/20 text-primary'
                                }`}>
                                <span className="material-symbols-outlined text-[14px]">
                                  {isUser ? 'person' : 'smart_toy'}
                                </span>
                              </div>
                              <div className={`max-w-[80%] ${isUser ? 'text-end' : ''}`}>
                                <div className={`p-3.5 rounded-2xl shadow-sm border ${isUser
                                  ? 'bg-primary text-white border-primary/30 rounded-se-sm'
                                  : 'bg-white dark:bg-white/[0.03] text-slate-800 dark:text-slate-200 border-slate-200 dark:border-white/[0.06] rounded-ss-sm'
                                  }`}>
                                  <div className="text-[13px] leading-relaxed whitespace-pre-wrap break-words">{msg.text}</div>
                                </div>
                              </div>
                            </div>
                          );
                        })}

                        {/* Streaming */}
                        {runStream !== null && (
                          <div className="flex items-start gap-2.5">
                            <div className="w-7 h-7 shrink-0 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mt-0.5">
                              <span className="material-symbols-outlined text-[14px]">smart_toy</span>
                            </div>
                            <div className="max-w-[80%]">
                              <div className="p-3.5 rounded-2xl rounded-ss-sm shadow-sm border bg-white dark:bg-white/[0.03] border-slate-200 dark:border-white/[0.06]">
                                {runStream ? (
                                  <div className="text-[13px] leading-relaxed whitespace-pre-wrap break-words text-slate-800 dark:text-slate-200">
                                    {runStream}
                                    <span className="inline-block w-0.5 h-4 bg-primary animate-pulse ms-0.5 align-text-bottom" />
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-2 text-slate-400">
                                    <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                                    <span className="text-[11px]">{a.running}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        )}

                        {runError && (
                          <div className="flex justify-center">
                            <div className="px-3 py-2 rounded-xl bg-mac-red/10 border border-mac-red/20 text-[10px] text-mac-red font-medium flex items-center gap-2">
                              <span className="material-symbols-outlined text-[14px]">error</span>
                              {runError}
                            </div>
                          </div>
                        )}

                        <div ref={runEndRef} />
                      </div>

                      {/* Input */}
                      <div className="shrink-0 mt-auto">
                        <div className="relative flex items-end gap-1.5 bg-white dark:bg-black/40 border border-slate-200 dark:border-white/10 rounded-2xl p-1.5 shadow-lg shadow-black/5 dark:shadow-black/20 focus-within:ring-2 focus-within:ring-primary/20 transition-all">
                          <textarea
                            ref={runTextareaRef}
                            rows={1}
                            className="flex-1 bg-transparent border-none text-[12px] text-slate-800 dark:text-white py-2 px-2 focus:ring-0 outline-none resize-none max-h-28 placeholder:text-slate-400 dark:placeholder:text-white/25"
                            placeholder={a.runPrompt}
                            value={runInput}
                            onChange={handleRunInputChange}
                            onKeyDown={handleRunKeyDown}
                            disabled={!gwReady}
                          />
                          {isRunStreaming ? (
                            <button onClick={handleRunAbort}
                              className="w-8 h-8 rounded-full bg-mac-red text-white flex items-center justify-center shrink-0 shadow-lg transition-all hover:bg-red-600 active:scale-95">
                              <span className="material-symbols-outlined text-[16px]">stop</span>
                            </button>
                          ) : (
                            <button onClick={sendToAgent}
                              disabled={!runInput.trim() || runSending || !gwReady}
                              className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-all active:scale-95 ${runInput.trim() && !runSending && gwReady
                                ? 'bg-primary text-white shadow-lg shadow-primary/30'
                                : 'bg-slate-100 dark:bg-white/5 text-slate-400'
                                }`}>
                              <span className="material-symbols-outlined text-[16px]">
                                {runSending ? 'progress_activity' : 'arrow_upward'}
                              </span>
                            </button>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Browser Request Panel */}
              {panel === 'tools' && (
                <div className="mt-6 max-w-5xl">
                  <div className="rounded-xl bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06] p-4 space-y-3">
                    <h3 className="text-[11px] font-bold text-slate-600 dark:text-white/60 uppercase flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-[14px] text-primary">language</span>
                      {a.browserReq}
                    </h3>
                    <div className="flex gap-2">
                      <CustomSelect value={browserMethod} onChange={v => setBrowserMethod(v)}
                        options={['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'].map(m => ({ value: m, label: m }))}
                        className="h-8 px-2 bg-white dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg text-[10px] font-mono text-slate-700 dark:text-white/70" />
                      <input value={browserUrl} onChange={e => setBrowserUrl(e.target.value)}
                        placeholder={a.browserUrl || '/api/...'}
                        className="flex-1 h-8 px-3 bg-white dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg text-[10px] font-mono text-slate-700 dark:text-white/70 outline-none" />
                      <button onClick={handleBrowserRequest} disabled={browserSending || !browserUrl.trim() || !gwReady}
                        className="h-8 px-3 bg-primary text-white text-[10px] font-bold rounded-lg disabled:opacity-40 flex items-center gap-1">
                        <span className="material-symbols-outlined text-[12px]">{browserSending ? 'progress_activity' : 'send'}</span>
                        {browserSending ? a.browserSending : a.browserSend}
                      </button>
                    </div>
                    {['POST', 'PUT', 'PATCH'].includes(browserMethod) && (
                      <div>
                        <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase block mb-1">{a.browserBody}</label>
                        <textarea value={browserBody} onChange={e => setBrowserBody(e.target.value)}
                          placeholder={a.browserBodyHint || '{"key": "value"}'}
                          rows={3}
                          className="w-full px-3 py-2 bg-white dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg text-[10px] font-mono text-slate-700 dark:text-white/70 outline-none resize-none focus:ring-1 focus:ring-primary/30" />
                      </div>
                    )}
                    {browserResult && (
                      <div className={`px-2 py-1.5 rounded-lg text-[10px] ${browserResult.ok ? 'bg-mac-green/10 text-mac-green' : 'bg-red-50 dark:bg-red-500/5 text-red-500'}`}>
                        {browserResult.text}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Cron Panel */}
              {panel === 'cron' && (() => {
                const jobs = cronJobs.filter((j: any) => j.agentId === selected.id || !j.agentId);
                return (
                  <div className="space-y-4 max-w-5xl">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-[11px] font-bold text-slate-600 dark:text-white/60 uppercase">{a.cron}</h3>
                        {cronStatus && (
                          <p className="text-[11px] text-slate-400 dark:text-white/35 mt-0.5">
                            {cronStatus.enabled ? a.enabled : a.disabled} · {cronStatus.jobs ?? 0} jobs
                          </p>
                        )}
                      </div>
                      <button onClick={() => { gwApi.cronStatus().then(setCronStatus).catch((err: any) => { toast('error', err?.message || a.cronFetchFailed); }); gwApi.cron().then((d: any) => setCronJobs(Array.isArray(d) ? d : d?.jobs || [])).catch((err: any) => { toast('error', err?.message || a.cronFetchFailed); }); }}
                        className="text-[10px] text-primary hover:underline">{a.refresh}</button>
                    </div>
                    {jobs.length === 0 ? (
                      <p className="text-[10px] text-slate-400 dark:text-white/20 py-8 text-center">{a.noJobs}</p>
                    ) : (
                      <div className="space-y-2">
                        {jobs.map((job: any, i: number) => (
                          <div key={job.name || i} className="px-3 py-2.5 rounded-xl bg-white dark:bg-white/[0.03] border border-slate-200/60 dark:border-white/[0.06]">
                            <div className="flex items-center justify-between">
                              <p className="text-[11px] font-semibold text-slate-700 dark:text-white/60">{job.name}</p>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${job.enabled ? 'bg-mac-green/10 text-mac-green' : 'bg-slate-100 dark:bg-white/5 text-slate-400'}`}>
                                {job.enabled ? a.enabled : a.disabled}
                              </span>
                            </div>
                            {job.description && <p className="text-[11px] text-slate-400 dark:text-white/35 mt-0.5">{job.description}</p>}
                            <div className="flex gap-3 mt-1.5 text-[11px] text-slate-400 dark:text-white/35 font-mono">
                              {job.schedule && <span>{a.schedule}: {typeof job.schedule === 'string' ? job.schedule : job.schedule.kind === 'every' ? `${Math.round((job.schedule.everyMs || 0) / 60000)}m` : job.schedule.kind === 'at' ? (job.schedule.at ? new Date(job.schedule.at).toLocaleString() : '-') : job.schedule.expr || '-'}</span>}
                              {job.sessionTarget && <span>→ {job.sessionTarget}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Scenarios Panel */}
              {panel === 'scenarios' && (
                <ScenarioLibraryV2
                  language={language}
                  defaultAgentId={selectedId || undefined}
                  onApplyScenario={() => {
                    // 应用场景后刷新文件列表
                    if (selectedId) {
                      gwApi.agentFilesList(selectedId).then(setFilesList).catch((err: any) => { toast('error', err?.message || a.fetchFailed); });
                    }
                  }}
                />
              )}

              {/* Collaboration Panel */}
              {panel === 'collaboration' && (
                <MultiAgentCollaborationV2 
                  language={language} 
                  defaultAgentId={selectedId || undefined}
                  onDeploy={() => {
                    // 部署完成后静默刷新代理列表
                    loadAgents();
                  }}
                />
              )}
            </div>
          </>
        )}
      </div>

      {/* Create/Edit Modal */}
      {crudMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md mx-4 rounded-2xl bg-white dark:bg-[#1a1a2e] border border-slate-200 dark:border-white/10 shadow-2xl p-5">
            <h3 className="text-sm font-bold text-slate-800 dark:text-white mb-4 flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-primary">{crudMode === 'create' ? 'add_circle' : 'edit'}</span>
              {crudMode === 'create' ? a.createAgent : a.editAgent}
            </h3>

            {crudError && (
              <div className="mb-3 px-3 py-2 rounded-xl bg-mac-red/10 border border-mac-red/20 text-[10px] text-mac-red">{crudError}</div>
            )}

            <div className="space-y-3">
              <div>
                <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase block mb-1">{a.agentName}</label>
                <input value={crudName} onChange={e => {
                    const newName = e.target.value;
                    setCrudName(newName);
                    if (crudMode === 'create' && config) {
                      const cfg0 = config?.agents || config?.parsed?.agents || config?.config?.agents || {};
                      const list = cfg0?.list || [];
                      const defaults = cfg0?.defaults;
                      const refEntry = list.find((en: any) => en?.workspace) || defaults;
                      const refWs = refEntry?.workspace || '';
                      if (refWs) {
                        const sep = refWs.includes('\\') ? '\\' : '/';
                        const lastSep = refWs.lastIndexOf(sep);
                        const wsBase = lastSep > 0 ? refWs.slice(0, lastSep) : refWs;
                        setCrudWorkspace(newName.trim() ? `${wsBase}${sep}workspace-${newName.trim()}` : '');
                      }
                    }
                  }}
                  placeholder={a.agentNameHint}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[12px] text-slate-800 dark:text-white/80 focus:outline-none focus:ring-1 focus:ring-primary/30"
                  disabled={crudBusy} />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase block mb-1">{a.workspacePath}</label>
                <input value={crudWorkspace} onChange={e => setCrudWorkspace(e.target.value)}
                  placeholder={a.workspaceHint}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[12px] font-mono text-slate-800 dark:text-white/80 focus:outline-none focus:ring-1 focus:ring-primary/30"
                  disabled={crudBusy} />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase block mb-1">{a.model}</label>
                {modelOptions.length > 0 ? (
                  <CustomSelect
                    value={crudModel}
                    onChange={setCrudModel}
                    options={[{ value: '', label: a.modelHint || 'Inherit default' }, ...modelOptions]}
                    disabled={crudBusy}
                    className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[12px] font-mono text-slate-800 dark:text-white/80"
                  />
                ) : (
                  <input value={crudModel} onChange={e => setCrudModel(e.target.value)}
                    placeholder={a.modelHint}
                    className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[12px] font-mono text-slate-800 dark:text-white/80 focus:outline-none focus:ring-1 focus:ring-primary/30"
                    disabled={crudBusy} />
                )}
              </div>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase block mb-1">{a.emoji}</label>
                  <input value={crudEmoji} onChange={e => setCrudEmoji(e.target.value)}
                    placeholder={a.emojiHint}
                    className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[12px] text-slate-800 dark:text-white/80 focus:outline-none focus:ring-1 focus:ring-primary/30"
                    disabled={crudBusy} />
                </div>
                <div className="shrink-0 pt-4">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={crudDefault} onChange={e => setCrudDefault(e.target.checked)}
                      className="accent-primary w-3.5 h-3.5" disabled={crudBusy} />
                    <span className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase">{a.isDefault}</span>
                  </label>
                </div>
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase block mb-1">{a.theme}</label>
                <textarea value={crudTheme} onChange={e => setCrudTheme(e.target.value)}
                  placeholder={a.themeHint || 'Agent personality / instructions...'}
                  rows={3}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 text-[12px] text-slate-800 dark:text-white/80 focus:outline-none focus:ring-1 focus:ring-primary/30 resize-none"
                  disabled={crudBusy} />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setCrudMode(null)} disabled={crudBusy}
                className="px-4 py-2 rounded-xl text-[11px] font-bold text-slate-500 dark:text-white/40 hover:bg-slate-100 dark:hover:bg-white/5 transition-all">{a.cancel}</button>
              <button onClick={crudMode === 'create' ? handleCreate : handleUpdate} disabled={crudBusy || !crudName.trim()}
                className="px-4 py-2 rounded-xl bg-primary text-white text-[11px] font-bold disabled:opacity-40 transition-all">
                {crudBusy ? (crudMode === 'create' ? a.creating : a.updating) : (crudMode === 'create' ? a.create : a.save)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-sm mx-4 rounded-2xl bg-white dark:bg-[#1a1a2e] border border-slate-200 dark:border-white/10 shadow-2xl p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-mac-red/10 flex items-center justify-center">
                <span className="material-symbols-outlined text-[20px] text-mac-red">delete_forever</span>
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-800 dark:text-white">{a.deleteAgent}</h3>
                <p className="text-[10px] text-slate-400 dark:text-white/40 font-mono">{selectedId}</p>
              </div>
            </div>

            <p className="text-[11px] text-slate-600 dark:text-white/50 mb-3">{a.confirmDelete}</p>

            {crudError && (
              <div className="mb-3 px-3 py-2 rounded-xl bg-mac-red/10 border border-mac-red/20 text-[10px] text-mac-red">{crudError}</div>
            )}

            <label className="flex items-center gap-2 mb-4">
              <input type="checkbox" checked={deleteFiles} onChange={e => setDeleteFiles(e.target.checked)} className="accent-mac-red" />
              <span className="text-[10px] text-slate-500 dark:text-white/40">{a.deleteFiles}</span>
            </label>

            <div className="flex justify-end gap-2">
              <button onClick={() => { setDeleteConfirm(false); setCrudError(null); }} disabled={crudBusy}
                className="px-4 py-2 rounded-xl text-[11px] font-bold text-slate-500 dark:text-white/40 hover:bg-slate-100 dark:hover:bg-white/5 transition-all">{a.cancel}</button>
              <button onClick={handleDelete} disabled={crudBusy}
                className="px-4 py-2 rounded-xl bg-mac-red text-white text-[11px] font-bold disabled:opacity-40 transition-all">
                {crudBusy ? a.deleting : a.delete}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Agents;
