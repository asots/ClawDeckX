import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { configApi } from '../../services/api';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import NumberStepper from '../../components/NumberStepper';
import CustomSelect from '../../components/CustomSelect';

// ---------------------------------------------------------------------------
// Constants — sourced from openclaw/extensions/*/openclaw.plugin.json
// ---------------------------------------------------------------------------

const STARTUP_PLUGINS: Array<{
  id: string;
  name: string;
  descKey: string;
  impact: 'high' | 'medium' | 'low';
  recommended: boolean;
  tag?: string;
}> = [
  { id: 'bonjour', name: 'Bonjour / mDNS', descKey: 'optimizePluginDescBonjour', impact: 'high', recommended: false, tag: 'mDNS' },
  { id: 'browser', name: 'Browser', descKey: 'optimizePluginDescBrowser', impact: 'medium', recommended: true },
  { id: 'device-pair', name: 'Device Pairing', descKey: 'optimizePluginDescDevicePair', impact: 'low', recommended: true },
  { id: 'phone-control', name: 'Phone Control', descKey: 'optimizePluginDescPhoneControl', impact: 'low', recommended: true },
  { id: 'talk-voice', name: 'Talk Voice', descKey: 'optimizePluginDescTalkVoice', impact: 'low', recommended: true },
  { id: 'acpx', name: 'ACPX Runtime', descKey: 'optimizePluginDescAcpx', impact: 'medium', recommended: true },
  { id: 'diagnostics-prometheus', name: 'Diagnostics Prometheus', descKey: 'optimizePluginDescPrometheus', impact: 'low', recommended: false },
];

const THINKING_OPTIONS = [
  { value: '', label: 'default' },
  { value: 'off', label: 'off' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'adaptive', label: 'adaptive' },
];

const PRUNING_OPTIONS = [
  { value: '', label: 'off (default)' },
  { value: 'cache-ttl', label: 'cache-ttl' },
];

const COMPACTION_OPTIONS = [
  { value: '', label: 'default' },
  { value: 'safeguard', label: 'safeguard' },
];

const REDACT_OPTIONS = [
  { value: '', label: 'off' },
  { value: 'tools', label: 'tools (recommended)' },
];

const EXEC_SECURITY_OPTIONS = [
  { value: 'deny', label: 'deny (safest)' },
  { value: 'allowlist', label: 'allowlist (recommended)' },
  { value: 'full', label: 'full (unrestricted)' },
];

const EXEC_ASK_OPTIONS = [
  { value: 'always', label: 'always' },
  { value: 'on-miss', label: 'on-miss (recommended)' },
  { value: 'off', label: 'off' },
];

const CONTEXT_INJECTION_OPTIONS = [
  { value: 'always', label: 'always (default)' },
  { value: 'continuation-skip', label: 'continuation-skip (saves tokens)' },
  { value: 'never', label: 'never' },
];

const SESSION_MAINTENANCE_OPTIONS = [
  { value: 'warn', label: 'warn (default)' },
  { value: 'enforce', label: 'enforce (auto-cleanup)' },
];

const TOTAL_STEPS = 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  language: string;
  t: any;
  wsConnected?: boolean;
  onClose: () => void;
  onApplied: () => void;
}

type PluginState = Record<string, boolean>;

interface WizardState {
  plugins: PluginState;
  modelPricingEnabled: boolean;
  pruningMode: string;
  pruningTtl: string;
  compactionMode: string;
  compactionNotify: boolean;
  compactionTruncate: boolean;
  compactionMaxHistoryShare: string;
  contextInjection: string;
  maxConcurrent: string;
  timeoutSeconds: string;
  thinkingDefault: string;
  imageMaxDimensionPx: string;
  updateCheckOnStart: boolean;
  redactSensitive: string;
  localModelLean: boolean;
  execSecurity: string;
  execAsk: string;
  execStrictInlineEval: boolean;
  execTimeoutSec: string;
  fsWorkspaceOnly: boolean;
  loopDetectionEnabled: boolean;
  sessionMaintenanceMode: string;
  sessionMaxDiskBytes: string;
  webSearchMaxResults: string;
  proxyEnabled: boolean;
  proxyUrl: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepGet(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const OptimizeWizard: React.FC<Props> = ({ language, t, wsConnected, onClose, onApplied }) => {
  const gw = t.gw as any;
  const opt: any = gw?.optimize || {};
  const { toast } = useToast();
  const { confirm } = useConfirm();

  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  const origConfigRef = useRef<Record<string, any>>({});
  const [ws, setWs] = useState<WizardState>({
    plugins: {},
    modelPricingEnabled: true,
    pruningMode: '',
    pruningTtl: '',
    compactionMode: '',
    compactionNotify: false,
    compactionTruncate: false,
    compactionMaxHistoryShare: '',
    contextInjection: 'always',
    maxConcurrent: '1',
    timeoutSeconds: '',
    thinkingDefault: '',
    imageMaxDimensionPx: '',
    updateCheckOnStart: true,
    redactSensitive: '',
    localModelLean: false,
    execSecurity: 'deny',
    execAsk: 'on-miss',
    execStrictInlineEval: false,
    execTimeoutSec: '',
    fsWorkspaceOnly: false,
    loopDetectionEnabled: false,
    sessionMaintenanceMode: 'warn',
    sessionMaxDiskBytes: '',
    webSearchMaxResults: '',
    proxyEnabled: false,
    proxyUrl: '',
  });
  const [origWs, setOrigWs] = useState<WizardState>(ws);

  // Load config on mount
  useEffect(() => {
    setLoading(true);
    setConfigError(null);
    configApi.get().then((res) => {
      const cfg = res?.config || {};
      origConfigRef.current = cfg;

      const entries = cfg?.plugins?.entries || {};
      const pluginStates: PluginState = {};
      for (const p of STARTUP_PLUGINS) {
        const entry = entries[p.id];
        pluginStates[p.id] = !(entry && typeof entry === 'object' && entry.enabled === false);
      }

      const initial: WizardState = {
        plugins: pluginStates,
        modelPricingEnabled: deepGet(cfg, 'models.pricing.enabled') !== false,
        pruningMode: deepGet(cfg, 'agents.defaults.contextPruning.mode') || '',
        pruningTtl: String(deepGet(cfg, 'agents.defaults.contextPruning.ttl') || ''),
        compactionMode: deepGet(cfg, 'agents.defaults.compaction.mode') || '',
        compactionNotify: !!deepGet(cfg, 'agents.defaults.compaction.notifyUser'),
        compactionTruncate: !!deepGet(cfg, 'agents.defaults.compaction.truncateAfterCompaction'),
        compactionMaxHistoryShare: String(deepGet(cfg, 'agents.defaults.compaction.maxHistoryShare') || ''),
        contextInjection: deepGet(cfg, 'agents.defaults.contextInjection') || 'always',
        maxConcurrent: String(deepGet(cfg, 'agents.defaults.maxConcurrent') || '1'),
        timeoutSeconds: String(deepGet(cfg, 'agents.defaults.timeoutSeconds') || ''),
        thinkingDefault: deepGet(cfg, 'agents.defaults.thinkingDefault') || '',
        imageMaxDimensionPx: String(deepGet(cfg, 'agents.defaults.imageMaxDimensionPx') || ''),
        updateCheckOnStart: deepGet(cfg, 'update.checkOnStart') !== false,
        redactSensitive: deepGet(cfg, 'logging.redactSensitive') || '',
        localModelLean: !!deepGet(cfg, 'agents.defaults.experimental.localModelLean'),
        execSecurity: deepGet(cfg, 'tools.exec.security') || 'deny',
        execAsk: deepGet(cfg, 'tools.exec.ask') || 'on-miss',
        execStrictInlineEval: !!deepGet(cfg, 'tools.exec.strictInlineEval'),
        execTimeoutSec: String(deepGet(cfg, 'tools.exec.timeoutSec') || ''),
        fsWorkspaceOnly: !!deepGet(cfg, 'tools.fs.workspaceOnly'),
        loopDetectionEnabled: !!deepGet(cfg, 'tools.loopDetection.enabled'),
        sessionMaintenanceMode: deepGet(cfg, 'session.maintenance.mode') || 'warn',
        sessionMaxDiskBytes: String(deepGet(cfg, 'session.maintenance.maxDiskBytes') || ''),
        webSearchMaxResults: String(deepGet(cfg, 'tools.web.search.maxResults') || ''),
        proxyEnabled: !!deepGet(cfg, 'proxy.enabled'),
        proxyUrl: deepGet(cfg, 'proxy.proxyUrl') || '',
      };
      setWs(initial);
      setOrigWs(initial);
    }).catch((err: any) => {
      setConfigError(err?.message || 'Failed to load config');
    }).finally(() => setLoading(false));
  }, []);

  // Change tracking
  const hasChanges = useMemo(() => JSON.stringify(ws) !== JSON.stringify(origWs), [ws, origWs]);

  const changeCount = useMemo(() => {
    let n = 0;
    for (const p of STARTUP_PLUGINS) if (ws.plugins[p.id] !== origWs.plugins[p.id]) n++;
    if (ws.modelPricingEnabled !== origWs.modelPricingEnabled) n++;
    if (ws.pruningMode !== origWs.pruningMode) n++;
    if (ws.pruningTtl !== origWs.pruningTtl) n++;
    if (ws.compactionMode !== origWs.compactionMode) n++;
    if (ws.compactionNotify !== origWs.compactionNotify) n++;
    if (ws.compactionTruncate !== origWs.compactionTruncate) n++;
    if (ws.compactionMaxHistoryShare !== origWs.compactionMaxHistoryShare) n++;
    if (ws.contextInjection !== origWs.contextInjection) n++;
    if (ws.maxConcurrent !== origWs.maxConcurrent) n++;
    if (ws.timeoutSeconds !== origWs.timeoutSeconds) n++;
    if (ws.thinkingDefault !== origWs.thinkingDefault) n++;
    if (ws.imageMaxDimensionPx !== origWs.imageMaxDimensionPx) n++;
    if (ws.updateCheckOnStart !== origWs.updateCheckOnStart) n++;
    if (ws.redactSensitive !== origWs.redactSensitive) n++;
    if (ws.localModelLean !== origWs.localModelLean) n++;
    if (ws.execSecurity !== origWs.execSecurity) n++;
    if (ws.execAsk !== origWs.execAsk) n++;
    if (ws.execStrictInlineEval !== origWs.execStrictInlineEval) n++;
    if (ws.execTimeoutSec !== origWs.execTimeoutSec) n++;
    if (ws.fsWorkspaceOnly !== origWs.fsWorkspaceOnly) n++;
    if (ws.loopDetectionEnabled !== origWs.loopDetectionEnabled) n++;
    if (ws.sessionMaintenanceMode !== origWs.sessionMaintenanceMode) n++;
    if (ws.sessionMaxDiskBytes !== origWs.sessionMaxDiskBytes) n++;
    if (ws.webSearchMaxResults !== origWs.webSearchMaxResults) n++;
    if (ws.proxyEnabled !== origWs.proxyEnabled) n++;
    if (ws.proxyUrl !== origWs.proxyUrl) n++;
    return n;
  }, [ws, origWs]);

  // Step navigation
  const canNext = step < TOTAL_STEPS - 1;
  const canPrev = step > 0;
  const goNext = useCallback(() => { if (canNext) setStep(s => s + 1); }, [canNext]);
  const goPrev = useCallback(() => { if (canPrev) setStep(s => s - 1); }, [canPrev]);

  // Quick optimize — sets recommended values across ALL steps
  const applyQuickOptimize = useCallback(() => {
    const pluginStates: PluginState = {};
    for (const p of STARTUP_PLUGINS) pluginStates[p.id] = p.recommended;
    setWs(prev => ({
      ...prev,
      plugins: pluginStates,
      modelPricingEnabled: false,
      updateCheckOnStart: false,
      redactSensitive: prev.redactSensitive || 'tools',
      pruningMode: prev.pruningMode || 'cache-ttl',
      pruningTtl: prev.pruningTtl || '30',
      compactionMode: prev.compactionMode || 'safeguard',
      compactionNotify: true,
      compactionTruncate: true,
      contextInjection: 'continuation-skip',
      execSecurity: prev.execSecurity === 'full' ? 'allowlist' : prev.execSecurity,
      execAsk: prev.execAsk === 'off' ? 'on-miss' : prev.execAsk,
      execStrictInlineEval: true,
      fsWorkspaceOnly: true,
      loopDetectionEnabled: true,
      sessionMaintenanceMode: 'enforce',
      sessionMaxDiskBytes: prev.sessionMaxDiskBytes || '500mb',
    }));
  }, []);

  // Apply all changes
  const handleApply = useCallback(async () => {
    if (!hasChanges) { onClose(); return; }

    const ok = await confirm({
      title: opt.confirmTitle || 'Apply Optimization',
      message: `${changeCount} ${opt.changesCount || 'change(s) will be applied.'}\n\n${opt.confirmRestart || 'Changes take effect after gateway restart.'}`,
      confirmText: opt.apply || 'Apply',
    });
    if (!ok) return;

    setSaving(true);
    try {
      const full = origConfigRef.current;
      // Build a partial config containing ONLY the changed top-level keys.
      // ConfigApplyFull iterates top-level keys → openclaw config set <key> <json>.
      // Sending unchanged keys (e.g. tools) causes CLI errors on complex values.
      let patch: Record<string, any> = {};

      // 1) Plugins
      const pluginsChanged = STARTUP_PLUGINS.some(p => ws.plugins[p.id] !== origWs.plugins[p.id]);
      if (pluginsChanged) {
        const entries = JSON.parse(JSON.stringify(full?.plugins?.entries || {}));
        for (const p of STARTUP_PLUGINS) {
          if (ws.plugins[p.id] !== origWs.plugins[p.id]) {
            const existing = entries[p.id] || {};
            if (ws.plugins[p.id]) {
              if (typeof existing === 'object' && Object.keys(existing).length <= 1 && existing.enabled === false) {
                delete entries[p.id];
              } else {
                entries[p.id] = { ...existing, enabled: true };
              }
            } else {
              entries[p.id] = { ...existing, enabled: false };
            }
          }
        }
        patch.plugins = { ...(full.plugins || {}), entries };
      }

      // 2) Model pricing
      if (ws.modelPricingEnabled !== origWs.modelPricingEnabled) {
        const existingModels = JSON.parse(JSON.stringify(full?.models || {}));
        if (!existingModels.pricing) existingModels.pricing = {};
        existingModels.pricing.enabled = ws.modelPricingEnabled;
        patch.models = existingModels;
      }

      // 3) Agents (context pruning, compaction, perf, lean mode, contextInjection, imageMaxDimensionPx)
      const agentsChanged = ws.pruningMode !== origWs.pruningMode
        || ws.pruningTtl !== origWs.pruningTtl
        || ws.compactionMode !== origWs.compactionMode
        || ws.compactionNotify !== origWs.compactionNotify
        || ws.compactionTruncate !== origWs.compactionTruncate
        || ws.compactionMaxHistoryShare !== origWs.compactionMaxHistoryShare
        || ws.contextInjection !== origWs.contextInjection
        || ws.maxConcurrent !== origWs.maxConcurrent
        || ws.timeoutSeconds !== origWs.timeoutSeconds
        || ws.thinkingDefault !== origWs.thinkingDefault
        || ws.imageMaxDimensionPx !== origWs.imageMaxDimensionPx
        || ws.localModelLean !== origWs.localModelLean;

      if (agentsChanged) {
        let agents = JSON.parse(JSON.stringify(full.agents || {}));

        // Context pruning
        if (ws.pruningMode !== origWs.pruningMode || ws.pruningTtl !== origWs.pruningTtl) {
          if (!agents.defaults) agents.defaults = {};
          if (!agents.defaults.contextPruning) agents.defaults.contextPruning = {};
          if (ws.pruningMode) {
            agents.defaults.contextPruning.mode = ws.pruningMode;
          } else {
            delete agents.defaults.contextPruning.mode;
          }
          if (ws.pruningTtl) {
            agents.defaults.contextPruning.ttl = ws.pruningTtl;
          } else {
            delete agents.defaults.contextPruning.ttl;
          }
          if (Object.keys(agents.defaults.contextPruning).length === 0) delete agents.defaults.contextPruning;
        }

        // Compaction
        if (ws.compactionMode !== origWs.compactionMode || ws.compactionNotify !== origWs.compactionNotify
          || ws.compactionTruncate !== origWs.compactionTruncate || ws.compactionMaxHistoryShare !== origWs.compactionMaxHistoryShare) {
          if (!agents.defaults) agents.defaults = {};
          if (!agents.defaults.compaction) agents.defaults.compaction = {};
          if (ws.compactionMode) {
            agents.defaults.compaction.mode = ws.compactionMode;
          } else {
            delete agents.defaults.compaction.mode;
          }
          agents.defaults.compaction.notifyUser = ws.compactionNotify || undefined;
          if (!agents.defaults.compaction.notifyUser) delete agents.defaults.compaction.notifyUser;
          agents.defaults.compaction.truncateAfterCompaction = ws.compactionTruncate || undefined;
          if (!agents.defaults.compaction.truncateAfterCompaction) delete agents.defaults.compaction.truncateAfterCompaction;
          const mhs = parseFloat(ws.compactionMaxHistoryShare);
          if (mhs > 0 && mhs <= 1) agents.defaults.compaction.maxHistoryShare = mhs; else delete agents.defaults.compaction.maxHistoryShare;
          if (Object.keys(agents.defaults.compaction).length === 0) delete agents.defaults.compaction;
        }

        // Context injection
        if (ws.contextInjection !== origWs.contextInjection) {
          if (!agents.defaults) agents.defaults = {};
          if (ws.contextInjection && ws.contextInjection !== 'always') {
            agents.defaults.contextInjection = ws.contextInjection;
          } else {
            delete agents.defaults.contextInjection;
          }
        }

        // Performance
        if (ws.maxConcurrent !== origWs.maxConcurrent) {
          if (!agents.defaults) agents.defaults = {};
          const v = parseInt(ws.maxConcurrent, 10);
          if (v > 0) agents.defaults.maxConcurrent = v; else delete agents.defaults.maxConcurrent;
        }
        if (ws.timeoutSeconds !== origWs.timeoutSeconds) {
          if (!agents.defaults) agents.defaults = {};
          const v = parseInt(ws.timeoutSeconds, 10);
          if (v > 0) agents.defaults.timeoutSeconds = v; else delete agents.defaults.timeoutSeconds;
        }
        if (ws.thinkingDefault !== origWs.thinkingDefault) {
          if (!agents.defaults) agents.defaults = {};
          if (ws.thinkingDefault) agents.defaults.thinkingDefault = ws.thinkingDefault; else delete agents.defaults.thinkingDefault;
        }

        // Image max dimension
        if (ws.imageMaxDimensionPx !== origWs.imageMaxDimensionPx) {
          if (!agents.defaults) agents.defaults = {};
          const v = parseInt(ws.imageMaxDimensionPx, 10);
          if (v > 0) agents.defaults.imageMaxDimensionPx = v; else delete agents.defaults.imageMaxDimensionPx;
        }

        // Lean mode
        if (ws.localModelLean !== origWs.localModelLean) {
          if (!agents.defaults) agents.defaults = {};
          if (!agents.defaults.experimental) agents.defaults.experimental = {};
          agents.defaults.experimental.localModelLean = ws.localModelLean || undefined;
          if (!agents.defaults.experimental.localModelLean) delete agents.defaults.experimental.localModelLean;
          if (Object.keys(agents.defaults.experimental).length === 0) delete agents.defaults.experimental;
        }

        patch.agents = agents;
      }

      // 4) Update config
      if (ws.updateCheckOnStart !== origWs.updateCheckOnStart) {
        const existingUpdate = JSON.parse(JSON.stringify(full?.update || {}));
        existingUpdate.checkOnStart = ws.updateCheckOnStart;
        patch.update = existingUpdate;
      }

      // 5) Logging
      if (ws.redactSensitive !== origWs.redactSensitive) {
        const existingLogging = JSON.parse(JSON.stringify(full?.logging || {}));
        if (ws.redactSensitive) {
          existingLogging.redactSensitive = ws.redactSensitive;
        } else {
          delete existingLogging.redactSensitive;
        }
        patch.logging = existingLogging;
      }

      // 6) Tools (exec, fs, loopDetection, web search)
      const toolsChanged = ws.execSecurity !== origWs.execSecurity
        || ws.execAsk !== origWs.execAsk
        || ws.execStrictInlineEval !== origWs.execStrictInlineEval
        || ws.execTimeoutSec !== origWs.execTimeoutSec
        || ws.fsWorkspaceOnly !== origWs.fsWorkspaceOnly
        || ws.loopDetectionEnabled !== origWs.loopDetectionEnabled
        || ws.webSearchMaxResults !== origWs.webSearchMaxResults;

      if (toolsChanged) {
        let tools = JSON.parse(JSON.stringify(full.tools || {}));
        if (ws.execSecurity !== origWs.execSecurity || ws.execAsk !== origWs.execAsk
          || ws.execStrictInlineEval !== origWs.execStrictInlineEval || ws.execTimeoutSec !== origWs.execTimeoutSec) {
          if (!tools.exec) tools.exec = {};
          tools.exec.security = ws.execSecurity || undefined;
          if (!tools.exec.security || tools.exec.security === 'deny') delete tools.exec.security;
          tools.exec.ask = ws.execAsk || undefined;
          if (!tools.exec.ask || tools.exec.ask === 'on-miss') delete tools.exec.ask;
          tools.exec.strictInlineEval = ws.execStrictInlineEval || undefined;
          if (!tools.exec.strictInlineEval) delete tools.exec.strictInlineEval;
          const et = parseInt(ws.execTimeoutSec, 10);
          if (et > 0) tools.exec.timeoutSec = et; else delete tools.exec.timeoutSec;
          if (Object.keys(tools.exec).length === 0) delete tools.exec;
        }
        if (ws.fsWorkspaceOnly !== origWs.fsWorkspaceOnly) {
          if (!tools.fs) tools.fs = {};
          tools.fs.workspaceOnly = ws.fsWorkspaceOnly || undefined;
          if (!tools.fs.workspaceOnly) delete tools.fs.workspaceOnly;
          if (Object.keys(tools.fs).length === 0) delete tools.fs;
        }
        if (ws.loopDetectionEnabled !== origWs.loopDetectionEnabled) {
          if (!tools.loopDetection) tools.loopDetection = {};
          tools.loopDetection.enabled = ws.loopDetectionEnabled || undefined;
          if (!tools.loopDetection.enabled) delete tools.loopDetection.enabled;
          if (Object.keys(tools.loopDetection).length === 0) delete tools.loopDetection;
        }
        if (ws.webSearchMaxResults !== origWs.webSearchMaxResults) {
          if (!tools.web) tools.web = {};
          if (!tools.web.search) tools.web.search = {};
          const mr = parseInt(ws.webSearchMaxResults, 10);
          if (mr > 0) tools.web.search.maxResults = mr; else delete tools.web.search.maxResults;
          if (Object.keys(tools.web.search).length === 0) delete tools.web.search;
          if (Object.keys(tools.web).length === 0) delete tools.web;
        }
        patch.tools = tools;
      }

      // 7) Session maintenance
      if (ws.sessionMaintenanceMode !== origWs.sessionMaintenanceMode || ws.sessionMaxDiskBytes !== origWs.sessionMaxDiskBytes) {
        let session = JSON.parse(JSON.stringify(full.session || {}));
        if (!session.maintenance) session.maintenance = {};
        if (ws.sessionMaintenanceMode && ws.sessionMaintenanceMode !== 'warn') {
          session.maintenance.mode = ws.sessionMaintenanceMode;
        } else {
          delete session.maintenance.mode;
        }
        if (ws.sessionMaxDiskBytes) {
          session.maintenance.maxDiskBytes = ws.sessionMaxDiskBytes;
        } else {
          delete session.maintenance.maxDiskBytes;
        }
        if (Object.keys(session.maintenance).length === 0) delete session.maintenance;
        patch.session = session;
      }

      // 8) Proxy
      if (ws.proxyEnabled !== origWs.proxyEnabled || ws.proxyUrl !== origWs.proxyUrl) {
        if (ws.proxyEnabled && ws.proxyUrl) {
          patch.proxy = { enabled: true, proxyUrl: ws.proxyUrl };
        } else if (!ws.proxyEnabled && ws.proxyUrl) {
          patch.proxy = { enabled: false, proxyUrl: ws.proxyUrl };
        } else {
          patch.proxy = {};
        }
      }

      // Gateway connected → CLI-based write (with timeout fallback to direct file write
      // so users don't get blocked on slow gateway startup); disconnected → direct file write.
      let viaDirect = !wsConnected;
      if (wsConnected) {
        try {
          await Promise.race([
            configApi.update(patch),
            new Promise((_, reject) => setTimeout(() => reject(new Error('GW_APPLY_TIMEOUT')), 6000)),
          ]);
        } catch (err: any) {
          if (err?.message === 'GW_APPLY_TIMEOUT') {
            await configApi.directUpdate(patch);
            viaDirect = true;
          } else {
            throw err;
          }
        }
      } else {
        await configApi.directUpdate(patch);
      }
      if (viaDirect) {
        toast('warning', opt.appliedDirect || 'Saved to config file. Restart gateway to take effect.');
      } else {
        toast('success', opt.applied || 'Optimization applied. Restart gateway to take effect.');
      }
      origConfigRef.current = { ...full, ...patch };
      setOrigWs({ ...ws });
      onApplied();
      onClose();
    } catch (err: any) {
      toast('error', `${opt.applyFailed || 'Failed to apply'}: ${err?.message || ''}`);
    } finally {
      setSaving(false);
    }
  }, [hasChanges, changeCount, ws, origWs, wsConnected, confirm, toast, opt, onApplied, onClose]);

  // Step definitions
  const STEPS = useMemo(() => [
    { key: 'plugins', icon: 'extension', label: opt.stepPlugins || 'Plugins' },
    { key: 'security', icon: 'shield', label: opt.stepSecurity || 'Security' },
    { key: 'context', icon: 'compress', label: opt.stepContext || 'Context' },
    { key: 'perf', icon: 'speed', label: opt.stepPerf || 'Performance' },
    { key: 'maintenance', icon: 'cleaning_services', label: opt.stepMaintenance || 'Cleanup' },
    { key: 'proxy', icon: 'vpn_lock', label: opt.stepProxy || 'Proxy' },
  ], [opt]);

  // Shared toggle renderer
  const Toggle = useCallback(({ on, onToggle }: { on: boolean; onToggle: () => void }) => (
    <button
      className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${on ? 'bg-mac-green' : 'bg-slate-300 dark:bg-white/15'}`}
      onClick={onToggle}
    >
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${on ? 'start-[18px]' : 'start-0.5'}`} />
    </button>
  ), []);

  const ImpactBadge = useCallback(({ impact }: { impact: 'high' | 'medium' | 'low' }) => {
    const colors: Record<string, string> = {
      high: 'bg-mac-red/10 text-mac-red border-mac-red/20',
      medium: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
      low: 'bg-mac-green/10 text-mac-green border-mac-green/20',
    };
    const labels: Record<string, string> = {
      high: opt.impactHigh || 'Heavy', medium: opt.impactMedium || 'Medium', low: opt.impactLow || 'Light',
    };
    return <span className={`text-[9px] px-1.5 py-0.5 rounded-md border font-bold ${colors[impact]}`}>{labels[impact]}</span>;
  }, [opt]);

  // Shared field label
  const FieldLabel = useCallback(({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-bold text-[var(--color-text)] dark:text-white">{label}</span>
        {hint && <span className="text-[9px] theme-text-muted">({hint})</span>}
      </div>
      {children}
    </div>
  ), []);

  // Shared config hint
  const ConfigHint = useCallback(({ path }: { path: string }) => (
    <span className="text-[9px] font-mono theme-text-muted bg-slate-100 dark:bg-white/5 px-1.5 py-0.5 rounded">{path}</span>
  ), []);

  // -------------------------------------------------------------------------
  // Step renderers
  // -------------------------------------------------------------------------

  const renderPlugins = () => (
    <div className="space-y-3">
      <button onClick={applyQuickOptimize} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-primary/20 bg-primary/5 hover:bg-primary/10 transition-all group">
        <div className="w-8 h-8 rounded-lg bg-primary/15 flex items-center justify-center group-hover:bg-primary/25 transition-colors shrink-0">
          <span className="material-symbols-outlined text-[16px] text-primary">auto_fix_high</span>
        </div>
        <div className="flex-1 min-w-0 text-start">
          <p className="text-[11px] font-bold text-primary">{opt.quickOptimize || 'Quick Optimize'}</p>
          <p className="text-[10px] theme-text-secondary">{opt.quickOptimizeDesc || 'Apply recommended settings across all steps'}</p>
        </div>
      </button>
      {/* Model pricing — biggest startup bottleneck */}
      {(() => {
        const pricingOn = ws.modelPricingEnabled;
        const pricingChanged = pricingOn !== origWs.modelPricingEnabled;
        const togglePricing = () => setWs(p => ({ ...p, modelPricingEnabled: !pricingOn }));
        return (
          <div className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all cursor-pointer ${pricingChanged ? 'border-primary/30 bg-primary/5' : 'border-mac-red/20 bg-mac-red/5 hover:border-mac-red/30'}`} onClick={togglePricing}>
            <Toggle on={pricingOn} onToggle={togglePricing} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px] font-bold text-[var(--color-text)] dark:text-white">{opt.modelPricingLabel || 'Model Pricing Fetch'}</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded-md theme-field font-mono theme-text-muted">models.pricing</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-mac-red/10 text-mac-red border-mac-red/20 border font-bold">{opt.impactHigh || 'Heavy'}</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-mac-red/10 text-mac-red border-mac-red/20 border font-bold">~120s</span>
                {pricingChanged && <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-primary/15 text-primary font-bold">{ws.modelPricingEnabled ? (opt.willEnable || 'Enable') : (opt.willDisable || 'Disable')}</span>}
              </div>
              <p className="text-[10px] theme-text-secondary mt-0.5">{opt.modelPricingDesc || 'Fetches pricing from OpenRouter & LiteLLM on startup (60s timeout each). Disable if not using cost tracking or if network is restricted.'}</p>
            </div>
          </div>
        );
      })()}
      <div className="space-y-1.5">
        {STARTUP_PLUGINS.map(plugin => {
          const enabled = ws.plugins[plugin.id] ?? true;
          const changed = enabled !== origWs.plugins[plugin.id];
          return (
            <div key={plugin.id} className={`flex items-center gap-3 px-3 py-2 rounded-xl border transition-all cursor-pointer ${changed ? 'border-primary/30 bg-primary/5' : 'border-slate-200/60 dark:border-white/[0.06] hover:border-slate-300 dark:hover:border-white/10'}`} onClick={() => setWs(p => ({ ...p, plugins: { ...p.plugins, [plugin.id]: !enabled } }))}>
              <Toggle on={enabled} onToggle={() => setWs(p => ({ ...p, plugins: { ...p.plugins, [plugin.id]: !enabled } }))} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] font-bold text-[var(--color-text)] dark:text-white">{plugin.name}</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded-md theme-field font-mono theme-text-muted">{plugin.id}</span>
                  <ImpactBadge impact={plugin.impact} />
                  {plugin.tag && <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-blue-500/10 text-blue-500 border border-blue-500/20 font-bold">{plugin.tag}</span>}
                  {changed && <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-primary/15 text-primary font-bold">{enabled ? (opt.changed || 'changed') : (opt.willDisableShort || 'will disable')}</span>}
                </div>
                <p className="text-[10px] theme-text-secondary mt-0.5">{opt[plugin.descKey] || plugin.descKey}</p>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/15">
        <span className="material-symbols-outlined text-[14px] text-amber-500 mt-px shrink-0">info</span>
        <p className="text-[10px] text-amber-600 dark:text-amber-400 leading-relaxed">{opt.restartHint || 'Changes take effect after gateway restart. Core plugins (anthropic, openai, etc.) load on-demand and are not shown.'}</p>
      </div>
    </div>
  );

  const renderContext = () => (
    <div className="space-y-4">
      <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-blue-500/5 border border-blue-500/15">
        <span className="material-symbols-outlined text-[14px] text-blue-500 mt-px shrink-0">lightbulb</span>
        <p className="text-[10px] text-blue-600 dark:text-blue-400 leading-relaxed">{opt.contextHint || 'Long conversations become slow because context grows linearly. Context pruning removes stale tool results; compaction summarizes history to stay within token limits.'}</p>
      </div>
      <FieldLabel label={opt.contextPruning || 'Context Pruning'} hint="agents.defaults.contextPruning.mode">
        <CustomSelect
          value={ws.pruningMode}
          onChange={(v: string) => setWs(p => ({ ...p, pruningMode: v }))}
          options={PRUNING_OPTIONS}
          className="max-w-[220px]"
        />
      </FieldLabel>
      {ws.pruningMode === 'cache-ttl' && (
        <FieldLabel label={opt.pruningTtl || 'Pruning TTL'} hint="agents.defaults.contextPruning.ttl">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={ws.pruningTtl}
              onChange={e => setWs(p => ({ ...p, pruningTtl: e.target.value }))}
              placeholder="30"
              className="w-24 sci-input px-3 py-1.5 rounded-lg text-[11px] font-mono"
            />
            <span className="text-[10px] theme-text-secondary">{opt.pruningTtlUnit || 'minutes (default unit)'}</span>
          </div>
        </FieldLabel>
      )}
      <div className="w-full h-px bg-slate-200 dark:bg-white/5" />
      <FieldLabel label={opt.compactionMode || 'Compaction Mode'} hint="agents.defaults.compaction.mode">
        <CustomSelect
          value={ws.compactionMode}
          onChange={(v: string) => setWs(p => ({ ...p, compactionMode: v }))}
          options={COMPACTION_OPTIONS}
          className="max-w-[220px]"
        />
        <p className="text-[9px] theme-text-muted mt-1">{opt.compactionModeHint || '"safeguard" applies stricter guardrails to preserve recent context during summarization.'}</p>
      </FieldLabel>
      <div className="flex items-center gap-3 px-3 py-2 rounded-xl border border-slate-200/60 dark:border-white/[0.06]">
        <Toggle on={ws.compactionNotify} onToggle={() => setWs(p => ({ ...p, compactionNotify: !p.compactionNotify }))} />
        <div className="flex-1 min-w-0">
          <span className="text-[11px] font-bold text-[var(--color-text)] dark:text-white">{opt.compactionNotify || 'Notify on compaction'}</span>
          <p className="text-[9px] theme-text-muted">{opt.compactionNotifyHint || 'Show brief notices when compaction starts and completes.'}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 px-3 py-2 rounded-xl border border-slate-200/60 dark:border-white/[0.06]">
        <Toggle on={ws.compactionTruncate} onToggle={() => setWs(p => ({ ...p, compactionTruncate: !p.compactionTruncate }))} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] font-bold text-[var(--color-text)] dark:text-white">{opt.compactionTruncate || 'Truncate after compaction'}</span>
            <ConfigHint path="agents.defaults.compaction.truncateAfterCompaction" />
          </div>
          <p className="text-[9px] theme-text-muted">{opt.compactionTruncateHint || 'Rotate transcript file after compaction to prevent unbounded growth.'}</p>
        </div>
      </div>
      <FieldLabel label={opt.compactionMaxHistory || 'Max History Share'} hint="agents.defaults.compaction.maxHistoryShare">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={ws.compactionMaxHistoryShare}
            onChange={e => setWs(p => ({ ...p, compactionMaxHistoryShare: e.target.value.replace(/[^0-9.]/g, '') }))}
            placeholder="0.5"
            className="w-20 sci-input px-3 py-1.5 rounded-lg text-[11px] font-mono"
          />
          <span className="text-[10px] theme-text-secondary">{opt.compactionMaxHistoryUnit || '0.1–0.9 (default 0.5)'}</span>
        </div>
      </FieldLabel>
      <div className="w-full h-px bg-slate-200 dark:bg-white/5" />
      <FieldLabel label={opt.contextInjectionLabel || 'Context Injection'} hint="agents.defaults.contextInjection">
        <CustomSelect
          value={ws.contextInjection}
          onChange={(v: string) => setWs(p => ({ ...p, contextInjection: v }))}
          options={CONTEXT_INJECTION_OPTIONS}
          className="max-w-[280px]"
        />
        <p className="text-[9px] theme-text-muted mt-1">{opt.contextInjectionHint || '"continuation-skip" skips re-injecting AGENTS.md on follow-up turns, saving tokens on long conversations.'}</p>
      </FieldLabel>
    </div>
  );

  const renderPerf = () => (
    <div className="space-y-4">
      <FieldLabel label={opt.maxConcurrent || 'Max Concurrent Runs'} hint="agents.defaults.maxConcurrent">
        <NumberStepper
          value={ws.maxConcurrent}
          onChange={(v: string) => setWs(p => ({ ...p, maxConcurrent: v }))}
          min={1}
          max={20}
          step={1}
          className="h-8 max-w-[180px]"
          inputClassName="text-[11px] px-1"
          buttonClassName="!w-7 text-[12px]"
        />
        <p className="text-[9px] theme-text-muted mt-1">{opt.maxConcurrentHint || 'Max concurrent agent runs across all conversations. Default: 1 (sequential).'}</p>
      </FieldLabel>
      <FieldLabel label={opt.agentTimeout || 'Agent Timeout'} hint="agents.defaults.timeoutSeconds">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={ws.timeoutSeconds}
            onChange={e => setWs(p => ({ ...p, timeoutSeconds: e.target.value.replace(/[^0-9]/g, '') }))}
            placeholder={opt.timeoutDefault || 'unset (no limit)'}
            className="w-28 sci-input px-3 py-1.5 rounded-lg text-[11px] font-mono"
          />
          <span className="text-[10px] theme-text-secondary">{opt.seconds || 'seconds'}</span>
        </div>
      </FieldLabel>
      <FieldLabel label={opt.imageMaxDimLabel || 'Image Max Dimension'} hint="agents.defaults.imageMaxDimensionPx">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={ws.imageMaxDimensionPx}
            onChange={e => setWs(p => ({ ...p, imageMaxDimensionPx: e.target.value.replace(/[^0-9]/g, '') }))}
            placeholder="1200"
            className="w-24 sci-input px-3 py-1.5 rounded-lg text-[11px] font-mono"
          />
          <span className="text-[10px] theme-text-secondary">{opt.imageMaxDimUnit || 'px (default 1200)'}</span>
        </div>
        <p className="text-[9px] theme-text-muted mt-1">{opt.imageMaxDimHint || 'Lower values reduce token usage for image-heavy conversations.'}</p>
      </FieldLabel>
      <FieldLabel label={opt.execTimeoutLabel || 'Exec Timeout'} hint="tools.exec.timeoutSec">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={ws.execTimeoutSec}
            onChange={e => setWs(p => ({ ...p, execTimeoutSec: e.target.value.replace(/[^0-9]/g, '') }))}
            placeholder={opt.timeoutDefault || 'unset (no limit)'}
            className="w-28 sci-input px-3 py-1.5 rounded-lg text-[11px] font-mono"
          />
          <span className="text-[10px] theme-text-secondary">{opt.seconds || 'seconds'}</span>
        </div>
        <p className="text-[9px] theme-text-muted mt-1">{opt.execTimeoutHint || 'Auto-kill exec commands after this duration. Prevents runaway processes.'}</p>
      </FieldLabel>
      <FieldLabel label={opt.webSearchMaxLabel || 'Web Search Max Results'} hint="tools.web.search.maxResults">
        <NumberStepper
          value={ws.webSearchMaxResults}
          onChange={(v: string) => setWs(p => ({ ...p, webSearchMaxResults: v }))}
          min={1}
          max={10}
          step={1}
          className="h-8 max-w-[180px]"
          inputClassName="text-[11px] px-1"
          buttonClassName="!w-7 text-[12px]"
        />
        <p className="text-[9px] theme-text-muted mt-1">{opt.webSearchMaxHint || 'Fewer results = less context tokens. Default: 10, recommended: 5.'}</p>
      </FieldLabel>
      <div className="w-full h-px bg-slate-200 dark:bg-white/5" />
      <FieldLabel label={opt.thinkingLevel || 'Default Thinking Level'} hint="agents.defaults.thinkingDefault">
        <CustomSelect
          value={ws.thinkingDefault}
          onChange={(v: string) => setWs(p => ({ ...p, thinkingDefault: v }))}
          options={THINKING_OPTIONS}
          className="max-w-[220px]"
        />
        <p className="text-[9px] theme-text-muted mt-1">{opt.thinkingHint || 'Higher thinking = better reasoning but slower & more tokens. "adaptive" lets the model decide.'}</p>
      </FieldLabel>
      <div className="w-full h-px bg-slate-200 dark:bg-white/5" />
      {(() => {
        const updateOn = ws.updateCheckOnStart;
        const updateChanged = updateOn !== origWs.updateCheckOnStart;
        const toggleUpdate = () => setWs(p => ({ ...p, updateCheckOnStart: !updateOn }));
        return (
          <div className={`flex items-center gap-3 px-3 py-2 rounded-xl border transition-all cursor-pointer ${updateChanged ? 'border-primary/30 bg-primary/5' : 'border-slate-200/60 dark:border-white/[0.06] hover:border-slate-300 dark:hover:border-white/10'}`} onClick={toggleUpdate}>
            <Toggle on={updateOn} onToggle={toggleUpdate} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px] font-bold text-[var(--color-text)] dark:text-white">{opt.updateCheckLabel || 'Check Updates on Start'}</span>
                <ConfigHint path="update.checkOnStart" />
              </div>
              <p className="text-[9px] theme-text-muted">{opt.updateCheckDesc || 'Check for new OpenClaw versions when gateway starts. Disable to speed up startup.'}</p>
            </div>
          </div>
        );
      })()}
      <FieldLabel label={opt.redactLabel || 'Log Redaction'} hint="logging.redactSensitive">
        <CustomSelect
          value={ws.redactSensitive}
          onChange={(v: string) => setWs(p => ({ ...p, redactSensitive: v }))}
          options={REDACT_OPTIONS}
          className="max-w-[220px]"
        />
        <p className="text-[9px] theme-text-muted mt-1">{opt.redactDesc || 'Redact sensitive tokens (API keys, secrets) from tool output in logs. "tools" is recommended for security.'}</p>
      </FieldLabel>
      {(() => {
        const leanOn = ws.localModelLean;
        const leanChanged = leanOn !== origWs.localModelLean;
        const toggleLean = () => setWs(p => ({ ...p, localModelLean: !leanOn }));
        return (
          <div className={`flex items-center gap-3 px-3 py-2 rounded-xl border transition-all cursor-pointer ${leanChanged ? 'border-primary/30 bg-primary/5' : 'border-slate-200/60 dark:border-white/[0.06] hover:border-slate-300 dark:hover:border-white/10'}`} onClick={toggleLean}>
            <Toggle on={leanOn} onToggle={toggleLean} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px] font-bold text-[var(--color-text)] dark:text-white">{opt.leanModeLabel || 'Local Model Lean Mode'}</span>
                <ConfigHint path="agents.defaults.experimental.localModelLean" />
              </div>
              <p className="text-[9px] theme-text-muted">{opt.leanModeDesc || 'Drop heavyweight default tools from system prompt for small local models (≤14B). Saves ~3KB of prompt space.'}</p>
            </div>
          </div>
        );
      })()}
    </div>
  );

  const renderSecurity = () => (
    <div className="space-y-4">
      <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-amber-500/5 border border-amber-500/15">
        <span className="material-symbols-outlined text-[14px] text-amber-500 mt-px shrink-0">shield</span>
        <p className="text-[10px] text-amber-600 dark:text-amber-400 leading-relaxed">{opt.securityHint || 'Control what the AI agent can execute on your system. These settings are critical for preventing unintended actions.'}</p>
      </div>
      <FieldLabel label={opt.execSecurityLabel || 'Exec Security Mode'} hint="tools.exec.security">
        <CustomSelect
          value={ws.execSecurity}
          onChange={(v: string) => setWs(p => ({ ...p, execSecurity: v }))}
          options={EXEC_SECURITY_OPTIONS}
          className="max-w-[260px]"
        />
        <p className="text-[9px] theme-text-muted mt-1">{opt.execSecurityHint || '"deny" blocks all exec. "allowlist" permits only approved commands. "full" allows everything (dangerous).'}</p>
      </FieldLabel>
      <FieldLabel label={opt.execAskLabel || 'Exec Approval Policy'} hint="tools.exec.ask">
        <CustomSelect
          value={ws.execAsk}
          onChange={(v: string) => setWs(p => ({ ...p, execAsk: v }))}
          options={EXEC_ASK_OPTIONS}
          className="max-w-[260px]"
        />
        <p className="text-[9px] theme-text-muted mt-1">{opt.execAskHint || '"on-miss" asks for approval only when a command is not in the allowlist. "always" asks every time.'}</p>
      </FieldLabel>
      <div className="w-full h-px bg-slate-200 dark:bg-white/5" />
      {(() => {
        const on = ws.execStrictInlineEval;
        const changed = on !== origWs.execStrictInlineEval;
        const toggle = () => setWs(p => ({ ...p, execStrictInlineEval: !on }));
        return (
          <div className={`flex items-center gap-3 px-3 py-2 rounded-xl border transition-all cursor-pointer ${changed ? 'border-primary/30 bg-primary/5' : 'border-slate-200/60 dark:border-white/[0.06] hover:border-slate-300 dark:hover:border-white/10'}`} onClick={toggle}>
            <Toggle on={on} onToggle={toggle} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px] font-bold text-[var(--color-text)] dark:text-white">{opt.execStrictInlineLabel || 'Strict Inline Eval'}</span>
                <ConfigHint path="tools.exec.strictInlineEval" />
              </div>
              <p className="text-[9px] theme-text-muted">{opt.execStrictInlineHint || 'Require approval for python -c, node -e, etc. Prevents allowlist bypass via inline code.'}</p>
            </div>
          </div>
        );
      })()}
      {(() => {
        const on = ws.fsWorkspaceOnly;
        const changed = on !== origWs.fsWorkspaceOnly;
        const toggle = () => setWs(p => ({ ...p, fsWorkspaceOnly: !on }));
        return (
          <div className={`flex items-center gap-3 px-3 py-2 rounded-xl border transition-all cursor-pointer ${changed ? 'border-primary/30 bg-primary/5' : 'border-slate-200/60 dark:border-white/[0.06] hover:border-slate-300 dark:hover:border-white/10'}`} onClick={toggle}>
            <Toggle on={on} onToggle={toggle} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px] font-bold text-[var(--color-text)] dark:text-white">{opt.fsWorkspaceLabel || 'Restrict FS to Workspace'}</span>
                <ConfigHint path="tools.fs.workspaceOnly" />
              </div>
              <p className="text-[9px] theme-text-muted">{opt.fsWorkspaceHint || 'Limit read/write/edit to the agent workspace directory. Prevents access to system files.'}</p>
            </div>
          </div>
        );
      })()}
      {(() => {
        const on = ws.loopDetectionEnabled;
        const changed = on !== origWs.loopDetectionEnabled;
        const toggle = () => setWs(p => ({ ...p, loopDetectionEnabled: !on }));
        return (
          <div className={`flex items-center gap-3 px-3 py-2 rounded-xl border transition-all cursor-pointer ${changed ? 'border-primary/30 bg-primary/5' : 'border-slate-200/60 dark:border-white/[0.06] hover:border-slate-300 dark:hover:border-white/10'}`} onClick={toggle}>
            <Toggle on={on} onToggle={toggle} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px] font-bold text-[var(--color-text)] dark:text-white">{opt.loopDetectionLabel || 'Tool Loop Detection'}</span>
                <ConfigHint path="tools.loopDetection.enabled" />
              </div>
              <p className="text-[9px] theme-text-muted">{opt.loopDetectionHint || 'Detect and block repetitive tool-call loops. Prevents infinite cycles that waste tokens.'}</p>
            </div>
          </div>
        );
      })()}
    </div>
  );

  const renderMaintenance = () => (
    <div className="space-y-4">
      <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-blue-500/5 border border-blue-500/15">
        <span className="material-symbols-outlined text-[14px] text-blue-500 mt-px shrink-0">cleaning_services</span>
        <p className="text-[10px] text-blue-600 dark:text-blue-400 leading-relaxed">{opt.maintenanceHint || 'Automatic session cleanup prevents disk bloat from long-running gateway instances. Recommended for always-on deployments.'}</p>
      </div>
      <FieldLabel label={opt.sessionMaintModeLabel || 'Session Maintenance Mode'} hint="session.maintenance.mode">
        <CustomSelect
          value={ws.sessionMaintenanceMode}
          onChange={(v: string) => setWs(p => ({ ...p, sessionMaintenanceMode: v }))}
          options={SESSION_MAINTENANCE_OPTIONS}
          className="max-w-[260px]"
        />
        <p className="text-[9px] theme-text-muted mt-1">{opt.sessionMaintModeHint || '"warn" only logs warnings. "enforce" auto-deletes expired sessions and enforces disk budget.'}</p>
      </FieldLabel>
      <FieldLabel label={opt.sessionDiskBudgetLabel || 'Session Disk Budget'} hint="session.maintenance.maxDiskBytes">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={ws.sessionMaxDiskBytes}
            onChange={e => setWs(p => ({ ...p, sessionMaxDiskBytes: e.target.value }))}
            placeholder="500mb"
            className="w-28 sci-input px-3 py-1.5 rounded-lg text-[11px] font-mono"
          />
          <span className="text-[10px] theme-text-secondary">{opt.sessionDiskBudgetUnit || 'e.g. 500mb, 1gb'}</span>
        </div>
        <p className="text-[9px] theme-text-muted mt-1">{opt.sessionDiskBudgetHint || 'Max disk space for session files per agent. Oldest sessions cleaned first when exceeded.'}</p>
      </FieldLabel>
    </div>
  );

  const renderProxy = () => (
    <div className="space-y-4">
      <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-blue-500/5 border border-blue-500/15">
        <span className="material-symbols-outlined text-[14px] text-blue-500 mt-px shrink-0">lightbulb</span>
        <p className="text-[10px] text-blue-600 dark:text-blue-400 leading-relaxed">{opt.proxyHint || 'Configure a forward HTTP proxy for all outbound API requests. Useful for cross-border access or corporate network requirements.'}</p>
      </div>
      <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-slate-200/60 dark:border-white/[0.06]">
        <Toggle on={ws.proxyEnabled} onToggle={() => setWs(p => ({ ...p, proxyEnabled: !p.proxyEnabled }))} />
        <div className="flex-1 min-w-0">
          <span className="text-[11px] font-bold text-[var(--color-text)] dark:text-white">{opt.proxyEnable || 'Enable Proxy'}</span>
          <ConfigHint path="proxy.enabled" />
        </div>
      </div>
      {ws.proxyEnabled && (
        <FieldLabel label={opt.proxyUrlLabel || 'Proxy URL'} hint="proxy.proxyUrl">
          <input
            type="text"
            value={ws.proxyUrl}
            onChange={e => setWs(p => ({ ...p, proxyUrl: e.target.value }))}
            placeholder="http://127.0.0.1:7890"
            className="w-full sci-input px-3 py-1.5 rounded-lg text-[11px] font-mono"
          />
          <p className="text-[9px] theme-text-muted mt-1">{opt.proxyUrlHint || 'Must be HTTP (not HTTPS/SOCKS). Example: http://proxy:8080'}</p>
        </FieldLabel>
      )}
    </div>
  );

  const STEP_RENDERERS = [renderPlugins, renderSecurity, renderContext, renderPerf, renderMaintenance, renderProxy];

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center pt-10 pb-4 bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[90%] max-w-2xl max-h-full rounded-2xl shadow-2xl theme-panel overflow-hidden sci-card animate-fade-in flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-white/10 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/15 flex items-center justify-center">
              <span className="material-symbols-outlined text-[18px] text-primary">bolt</span>
            </div>
            <div>
              <h3 className="text-sm font-bold text-[var(--color-text)] dark:text-white">{opt.title || 'Gateway Optimization'}</h3>
              <p className="text-[10px] theme-text-secondary mt-0.5">{opt.subtitle || 'Tune OpenClaw for speed, cost & stability'}</p>
            </div>
          </div>
          <button onClick={onClose} className="w-6 h-6 rounded-full theme-field flex items-center justify-center theme-text-secondary hover:bg-mac-red hover:text-white transition-all">
            <span className="material-symbols-outlined text-[14px]">close</span>
          </button>
        </div>

        {/* Step bar */}
        <div className="px-5 py-2 border-b border-slate-200 dark:border-white/5 flex items-center gap-1 overflow-x-auto no-scrollbar shrink-0">
          {STEPS.map((s, i) => (
            <button
              key={s.key}
              onClick={() => setStep(i)}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-all whitespace-nowrap ${
                i === step
                  ? 'bg-primary/15 text-primary'
                  : 'theme-text-secondary hover:bg-slate-100 dark:hover:bg-white/5'
              }`}
            >
              <span className={`w-4.5 h-4.5 rounded-full flex items-center justify-center text-[9px] font-bold ${
                i === step ? 'bg-primary text-white' : 'bg-slate-200 dark:bg-white/10 text-slate-500 dark:text-white/40'
              }`}>{i + 1}</span>
              <span className="material-symbols-outlined text-[13px]">{s.icon}</span>
              {s.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="p-5 flex-1 min-h-0 overflow-y-auto neon-scrollbar">
          {loading ? (
            <div className="flex items-center justify-center py-10 gap-2">
              <span className="material-symbols-outlined text-[18px] text-primary animate-spin">progress_activity</span>
              <span className="text-sm theme-text-secondary">{opt.loading || 'Loading config...'}</span>
            </div>
          ) : configError ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <span className="material-symbols-outlined text-[24px] text-mac-red">error</span>
              <p className="text-sm text-mac-red font-medium">{configError}</p>
              <p className="text-[11px] theme-text-secondary">{opt.configErrorHint || 'Make sure OpenClaw config path is set correctly.'}</p>
            </div>
          ) : (
            STEP_RENDERERS[step]()
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-white/10 flex items-center justify-between theme-panel shrink-0">
          <div className="text-[10px] theme-text-secondary">
            {hasChanges && (
              <span className="flex items-center gap-1 text-primary font-bold">
                <span className="material-symbols-outlined text-[12px]">edit</span>
                {changeCount} {opt.pendingChanges || 'change(s)'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canPrev && (
              <button onClick={goPrev} className="px-3 py-1.5 text-xs font-bold theme-text-secondary hover:bg-slate-200 dark:hover:bg-white/10 rounded-lg transition-all flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">chevron_left</span>
                {opt.prev || 'Back'}
              </button>
            )}
            {!canPrev && (
              <button onClick={onClose} className="px-3 py-1.5 text-xs font-bold theme-text-secondary hover:bg-slate-200 dark:hover:bg-white/10 rounded-lg transition-all">
                {gw?.cancel || 'Cancel'}
              </button>
            )}
            {canNext ? (
              <button onClick={goNext} className="px-4 py-1.5 bg-primary text-white text-xs font-bold rounded-lg shadow-lg shadow-primary/20 transition-all flex items-center gap-1">
                {opt.next || 'Next'}
                <span className="material-symbols-outlined text-[14px]">chevron_right</span>
              </button>
            ) : (
              <button
                onClick={handleApply}
                disabled={saving || loading || !!configError || !hasChanges}
                className="px-4 py-1.5 bg-primary text-white text-xs font-bold rounded-lg shadow-lg shadow-primary/20 disabled:opacity-50 transition-all flex items-center gap-1.5"
              >
                {saving && <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>}
                {saving ? (opt.applying || 'Applying...') : (opt.apply || 'Apply')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default OptimizeWizard;
