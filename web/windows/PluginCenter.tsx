import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Language } from '../types';
import { getTranslation } from '../locales';
import { pluginApi, gwApi, gatewayApi, PluginStatusPlugin, PluginDiagnostic, PluginStatusResponse } from '../services/api';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import EmptyState from '../components/EmptyState';
import { copyToClipboard } from '../utils/clipboard';

// Built-in plugin catalog
type CatalogEntry = { id: string; spec: string; name: string; nameZh: string; description: string; descriptionZh: string; icon: string; category: 'channel' | 'integration' | 'utility'; relatedChannels?: string[] };
const PLUGIN_CATALOG: CatalogEntry[] = [
  { id: 'feishu', spec: '@openclaw/feishu', name: 'Feishu (Lark)', nameZh: '飞书', description: 'Feishu / Lark messaging channel plugin', descriptionZh: '飞书消息渠道插件', icon: '🪶', category: 'channel', relatedChannels: ['feishu'] },
  { id: 'dingtalk', spec: '@openclaw-china/dingtalk', name: 'DingTalk', nameZh: '钉钉', description: 'DingTalk messaging channel plugin', descriptionZh: '钉钉消息渠道插件', icon: '📌', category: 'channel', relatedChannels: ['dingtalk'] },
  { id: 'wecom-openclaw-plugin', spec: '@wecom/wecom-openclaw-plugin', name: 'WeCom', nameZh: '企业微信', description: 'WeCom (WeChat Work) messaging channel plugin', descriptionZh: '企业微信消息渠道插件', icon: '💼', category: 'channel', relatedChannels: ['wecom'] },
  { id: 'wecom-app', spec: '@openclaw-china/wecom-app', name: 'WeCom App (KF)', nameZh: '企业微信客服', description: 'WeCom customer service app plugin', descriptionZh: '企业微信客服应用插件', icon: '🎧', category: 'channel', relatedChannels: ['wecom_kf'] },
  { id: 'qqbot', spec: '@openclaw-china/qqbot', name: 'QQ Bot', nameZh: 'QQ 机器人', description: 'QQ Bot messaging channel plugin', descriptionZh: 'QQ 机器人消息渠道插件', icon: '🐧', category: 'channel', relatedChannels: ['qq'] },
  { id: 'msteams', spec: '@openclaw/msteams', name: 'Microsoft Teams', nameZh: 'Microsoft Teams', description: 'Microsoft Teams messaging channel plugin', descriptionZh: 'Microsoft Teams 消息渠道插件', icon: '🟣', category: 'channel', relatedChannels: ['msteams'] },
  { id: 'zalo', spec: '@openclaw/zalo', name: 'Zalo', nameZh: 'Zalo', description: 'Zalo messaging channel plugin (Vietnam)', descriptionZh: 'Zalo 消息渠道插件（越南）', icon: '💬', category: 'channel', relatedChannels: ['zalo'] },
  { id: 'matrix', spec: '@openclaw/matrix', name: 'Matrix', nameZh: 'Matrix', description: 'Matrix decentralized messaging channel plugin', descriptionZh: 'Matrix 去中心化消息渠道插件', icon: '🟩', category: 'channel', relatedChannels: ['matrix'] },
  { id: 'voice-call', spec: '@openclaw/voice-call', name: 'Voice Call', nameZh: '语音通话', description: 'Voice call channel plugin with telephony support', descriptionZh: '语音通话渠道插件，支持电话接入', icon: '📞', category: 'channel', relatedChannels: ['voicecall'] },
  { id: 'mattermost', spec: '@openclaw/mattermost', name: 'Mattermost', nameZh: 'Mattermost', description: 'Mattermost messaging channel plugin', descriptionZh: 'Mattermost 消息渠道插件', icon: '🔵', category: 'channel', relatedChannels: ['mattermost'] },
];
const CATALOG_MAP = Object.fromEntries(PLUGIN_CATALOG.map(c => [c.id, c]));

type PluginFilter = 'all' | 'installed' | 'not_installed' | 'loaded' | 'disabled' | 'error';

interface MergedPlugin {
  id: string; spec: string; name: string; description: string; icon: string;
  category: string; relatedChannels?: string[];
  installed: boolean; enabled: boolean;
  status?: string; version?: string; error?: string;
  installSource?: string; installPath?: string; installedAt?: string;
  toolNames?: string[]; hookNames?: string[]; channelIds?: string[];
  providerIds?: string[]; gatewayMethods?: string[]; cliCommands?: string[];
  services?: string[]; commands?: string[]; httpRoutes?: number;
  origin?: string; source?: string; kind?: string;
}

const PLUGIN_CACHE_KEY = 'clawdeckx_plugin_cache';

// Extract meaningful failure message from verbose CLI output
const extractFailureMessage = (output: string): string => {
  if (!output) return '';
  const lines = output.split('\n');
  for (const line of lines) {
    const trimmed = line.replace(/[│├╮╯◇─\s]+/g, ' ').trim();
    if (trimmed.startsWith('Failed to')) return trimmed;
  }
  return output.slice(0, 200);
};

const SkeletonCard: React.FC = () => (
  <div className="bg-slate-50 dark:bg-white/[0.02] border border-slate-200 dark:border-white/10 rounded-2xl p-4 animate-pulse flex flex-col">
    <div className="flex items-center gap-2.5 mb-2">
      <div className="w-7 h-7 rounded-lg bg-slate-200 dark:bg-white/10" />
      <div className="flex-1 min-w-0">
        <div className="h-4 w-24 bg-slate-200 dark:bg-white/10 rounded mb-1" />
        <div className="h-3 w-36 bg-slate-100 dark:bg-white/5 rounded" />
      </div>
    </div>
    <div className="flex gap-1 mb-2">
      <div className="h-5 w-16 bg-slate-100 dark:bg-white/5 rounded-full" />
      <div className="h-5 w-14 bg-slate-100 dark:bg-white/5 rounded-full" />
    </div>
    <div className="h-3 w-full bg-slate-100 dark:bg-white/5 rounded mb-1" />
    <div className="h-3 w-2/3 bg-slate-100 dark:bg-white/5 rounded mb-3" />
    <div className="mt-auto pt-2 border-t border-slate-100 dark:border-white/5 flex gap-1">
      <div className="h-7 w-16 bg-slate-100 dark:bg-white/5 rounded-lg" />
      <div className="h-7 w-14 bg-slate-100 dark:bg-white/5 rounded-lg" />
    </div>
  </div>
);

interface PluginCenterProps { language: Language; }

const PluginCenter: React.FC<PluginCenterProps> = ({ language }) => {
  const t = useMemo(() => getTranslation(language), [language]);
  const sk = (t as any).sk || {};
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const isZh = language === 'zh' || language === 'zh-TW';

  const [filter, setFilter] = useState<PluginFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [canInstall, setCanInstall] = useState(true);
  const [isRemote, setIsRemote] = useState(false);
  const [statusData, setStatusData] = useState<PluginStatusResponse | null>(() => {
    try {
      const cached = localStorage.getItem(PLUGIN_CACHE_KEY);
      return cached ? JSON.parse(cached) : null;
    } catch { return null; }
  });
  const [installingSpec, setInstallingSpec] = useState<string | null>(null);
  const [installPhase, setInstallPhase] = useState<'installing' | 'restarting' | 'ready' | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [detailPlugin, setDetailPlugin] = useState<MergedPlugin | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // Fetch: use status API (works on both local & remote), fallback to list.
  // After fetch, cache to localStorage for next load.
  const fetchPlugins = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    setRefreshing(true);
    try {
      const res = await pluginApi.status();
      setCanInstall(res.can_install); setIsRemote(res.is_remote); setStatusData(res);
      try { localStorage.setItem(PLUGIN_CACHE_KEY, JSON.stringify(res)); } catch { /* quota */ }
    } catch {
      try {
        const list = await pluginApi.list();
        setCanInstall(list.can_install); setIsRemote(list.is_remote);
        const data: PluginStatusResponse = {
          plugins: list.plugins.map(p => ({ ...p, status: (p.enabled ? 'loaded' : 'disabled') as any })),
          diagnostics: [], slots: {}, allow: [], deny: [],
          can_install: list.can_install, is_remote: list.is_remote,
        };
        setStatusData(data);
        try { localStorage.setItem(PLUGIN_CACHE_KEY, JSON.stringify(data)); } catch { /* quota */ }
      } catch { /* ignore */ }
    } finally { setLoading(false); setRefreshing(false); }
  }, []);

  // Initial load: if cache exists show it immediately, otherwise show skeleton.
  // Always auto-refresh in background on mount.
  useEffect(() => {
    const hasCached = !!localStorage.getItem(PLUGIN_CACHE_KEY);
    if (hasCached) setLoading(false);
    fetchPlugins(hasCached);
  }, [fetchPlugins]);

  // Merge catalog + runtime status
  const plugins: MergedPlugin[] = useMemo(() => {
    const rtMap: Record<string, PluginStatusPlugin> = {};
    for (const p of statusData?.plugins || []) rtMap[p.id] = p;
    const result: MergedPlugin[] = PLUGIN_CATALOG.map(cat => {
      const rt = rtMap[cat.id];
      return {
        id: cat.id, spec: rt?.spec || cat.spec,
        name: isZh ? cat.nameZh : cat.name, description: isZh ? cat.descriptionZh : cat.description,
        icon: cat.icon, category: cat.category, relatedChannels: cat.relatedChannels,
        installed: rt?.installed ?? (rt ? true : false), enabled: rt?.enabled ?? true,
        status: rt?.status, version: rt?.version, error: rt?.error,
        installSource: rt?.installSource, installPath: rt?.installPath, installedAt: rt?.installedAt,
        toolNames: rt?.toolNames, hookNames: rt?.hookNames, channelIds: rt?.channelIds,
        providerIds: rt?.providerIds, gatewayMethods: rt?.gatewayMethods, cliCommands: rt?.cliCommands,
        services: rt?.services, commands: rt?.commands, httpRoutes: rt?.httpRoutes,
        origin: rt?.origin, source: rt?.source, kind: rt?.kind,
      };
    });
    for (const [id, rt] of Object.entries(rtMap)) {
      if (!CATALOG_MAP[id]) {
        result.push({
          id, spec: rt.spec || id, name: rt.name || id, description: rt.description || rt.spec || '',
          icon: '🔌', category: 'utility', installed: rt.installed ?? true, enabled: rt.enabled ?? true,
          status: rt.status, version: rt.version, error: rt.error,
          installSource: rt.installSource, installPath: rt.installPath, installedAt: rt.installedAt,
          toolNames: rt.toolNames, hookNames: rt.hookNames, channelIds: rt.channelIds,
          providerIds: rt.providerIds, gatewayMethods: rt.gatewayMethods, cliCommands: rt.cliCommands,
          services: rt.services, commands: rt.commands, httpRoutes: rt.httpRoutes,
          origin: rt.origin, source: rt.source, kind: rt.kind,
        });
      }
    }
    return result;
  }, [statusData, isZh]);

  const filtered = useMemo(() => {
    let list = plugins;
    if (filter === 'installed') list = list.filter(p => p.installed);
    else if (filter === 'not_installed') list = list.filter(p => !p.installed);
    else if (filter === 'loaded') list = list.filter(p => p.status === 'loaded');
    else if (filter === 'disabled') list = list.filter(p => p.status === 'disabled');
    else if (filter === 'error') list = list.filter(p => p.status === 'error');
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || p.spec.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => { if (a.installed !== b.installed) return a.installed ? -1 : 1; return a.name.localeCompare(b.name); });
  }, [plugins, filter, searchQuery]);

  const installedCount = useMemo(() => plugins.filter(p => p.installed).length, [plugins]);
  const loadedCount = useMemo(() => plugins.filter(p => p.status === 'loaded').length, [plugins]);
  const errorCount = useMemo(() => plugins.filter(p => p.status === 'error').length, [plugins]);
  const diagnostics = statusData?.diagnostics || [];
  const slots = statusData?.slots || {};
  const allowList = statusData?.allow || [];
  const denyList = statusData?.deny || [];

  // ── Actions ──
  // Local only: install, uninstall, update
  // Both local & remote: enable/disable (config.patch RPC), view details, diagnostics, slots view

  const pollGatewayAndRefresh = useCallback((onDone: () => void) => {
    let retries = 0;
    const poll = setInterval(async () => {
      retries++;
      try { await gwApi.proxy('health', {}); clearInterval(poll); onDone(); setTimeout(fetchPlugins, 500); } catch { /* not ready */ }
      if (retries >= 30) { clearInterval(poll); onDone(); fetchPlugins(); }
    }, 1000);
  }, [fetchPlugins]);

  const handleInstall = useCallback(async (plugin: MergedPlugin) => {
    if (!canInstall) { toast('error', sk.pluginLocalOnlyAction || sk.pluginLocalOnly); return; }
    setInstallingSpec(plugin.spec); setInstallPhase('installing');
    try {
      const res = await pluginApi.install(plugin.spec);
      if (res.success) {
        setInstallPhase('restarting');
        try { await gatewayApi.restart(); } catch { /* ignore */ }
        pollGatewayAndRefresh(() => { toast('success', sk.pluginInstallOk); setInstallingSpec(null); setInstallPhase(null); });
      } else { toast('error', `${sk.pluginInstallFail}: ${extractFailureMessage(res.output)}`); setInstallingSpec(null); setInstallPhase(null); }
    } catch (err: any) { toast('error', `${sk.pluginInstallFail}: ${err?.message || ''}`); setInstallingSpec(null); setInstallPhase(null); }
  }, [canInstall, sk, toast, pollGatewayAndRefresh]);

  const handleUninstall = useCallback(async (plugin: MergedPlugin) => {
    if (!canInstall) { toast('error', sk.pluginLocalOnlyAction); return; }
    const ok = await confirm({ title: sk.pluginUninstallBtn || 'Uninstall', message: sk.pluginUninstallConfirm || `Uninstall "${plugin.name}"?`, danger: true, confirmText: sk.pluginUninstallBtn || 'Uninstall' });
    if (!ok) return;
    setUninstallingId(plugin.id);
    try {
      const res = await pluginApi.uninstall(plugin.id);
      if (res.success) {
        toast('success', sk.pluginUninstallOk);
        try { await gatewayApi.restart(); } catch { /* ignore */ }
        pollGatewayAndRefresh(() => setUninstallingId(null));
      } else { toast('error', `${sk.pluginUninstallFail}: ${res.output || ''}`); setUninstallingId(null); }
    } catch (err: any) { toast('error', `${sk.pluginUninstallFail}: ${err?.message || ''}`); setUninstallingId(null); }
  }, [canInstall, sk, toast, confirm, pollGatewayAndRefresh]);

  const handleUpdate = useCallback(async (pluginId?: string, all?: boolean) => {
    if (!canInstall) { toast('error', sk.pluginLocalOnlyAction); return; }
    setUpdatingId(all ? '__all__' : pluginId || null);
    try {
      const res = await pluginApi.update(pluginId, all);
      if (res.success) {
        toast('success', all ? sk.pluginUpdateAllOk : sk.pluginUpdateOk);
        try { await gatewayApi.restart(); } catch { /* ignore */ }
        pollGatewayAndRefresh(() => setUpdatingId(null));
      } else { toast('error', `${sk.pluginUpdateFail}: ${extractFailureMessage(res.output)}`); setUpdatingId(null); }
    } catch (err: any) { toast('error', `${sk.pluginUpdateFail}: ${err?.message || ''}`); setUpdatingId(null); }
  }, [canInstall, sk, toast, pollGatewayAndRefresh]);

  // Toggle enable/disable — works on both local & remote (via config.patch RPC)
  const handleToggle = useCallback(async (plugin: MergedPlugin) => {
    const willEnable = !plugin.enabled;
    if (!willEnable) { const ok = await confirm({ title: sk.pluginDisableBtn, message: `${sk.pluginDisableBtn} "${plugin.name}"?`, danger: true, confirmText: sk.pluginDisableBtn }); if (!ok) return; }
    setTogglingId(plugin.id);
    try {
      await gwApi.proxy('config.patch', { raw: JSON.stringify({ plugins: { entries: { [plugin.id]: { enabled: willEnable } } } }) });
      toast('success', sk.pluginToggleOk); fetchPlugins();
    } catch (err: any) { toast('error', `${sk.pluginToggleFail}: ${err?.message || ''}`); }
    setTogglingId(null);
  }, [sk, toast, confirm, fetchPlugins]);

  const handleCopySpec = useCallback((spec: string) => {
    copyToClipboard(spec).then(() => toast('success', sk.pluginCopied)).catch(() => {});
  }, [sk, toast]);

  const statusBadge = (s?: string) => s === 'loaded' ? 'bg-mac-green/15 text-mac-green' : s === 'error' ? 'bg-mac-red/15 text-mac-red' : 'bg-slate-200 dark:bg-white/10 text-slate-500';
  const statusLabel = (s?: string) => s === 'loaded' ? (sk.pluginStatusLoaded || 'Loaded') : s === 'error' ? (sk.pluginStatusError || 'Error') : (sk.pluginStatusDisabled || 'Disabled');

  const filters: { id: PluginFilter; label: string; count?: number }[] = [
    { id: 'all', label: sk.pluginAll || 'All', count: plugins.length },
    { id: 'installed', label: sk.pluginInstalledFilter || 'Installed', count: installedCount },
    { id: 'loaded', label: sk.pluginFilterLoaded || 'Loaded', count: loadedCount },
    { id: 'error', label: sk.pluginFilterError || 'Errors', count: errorCount },
    { id: 'not_installed', label: sk.pluginNotInstalledFilter || 'Not Installed' },
  ];
  const npmInstalledCount = plugins.filter(p => p.installed && p.installSource === 'npm').length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="p-3 flex items-center gap-2 border-b border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-black/20 shrink-0">
        {/* Search */}
        <div className="relative flex-1 min-w-0">
          <span className="material-symbols-outlined absolute start-3 top-1/2 -translate-y-1/2 text-slate-400 text-[16px]">search</span>
          <input
            className="w-full h-9 ps-9 pe-4 bg-white dark:bg-[#1a1c22] border border-slate-200 dark:border-white/10 rounded-lg text-xs text-slate-800 dark:text-white placeholder:text-slate-400 focus:ring-1 focus:ring-primary outline-none"
            placeholder={`${sk.search || 'Search'}...`}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
        {/* Filter pills */}
        <div className="flex bg-slate-200 dark:bg-black/40 p-0.5 rounded-lg shadow-inner shrink-0">
          {filters.map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              className={`px-2 py-1 rounded text-[10px] font-bold transition-all whitespace-nowrap flex items-center gap-1 ${filter === f.id
                ? 'bg-white dark:bg-primary shadow-sm text-slate-900 dark:text-white'
                : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
              }`}>
              {f.label}{f.count != null && <span className="opacity-60">({f.count})</span>}
            </button>
          ))}
        </div>
        {/* Update All — local only */}
        {canInstall && npmInstalledCount > 0 && (
          <button onClick={() => handleUpdate(undefined, true)} disabled={!!updatingId}
            className="h-9 px-3 bg-primary/10 text-primary text-[10px] font-bold rounded-lg hover:bg-primary hover:text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 shrink-0"
            title={sk.pluginUpdateAllBtn || 'Update All'}>
            <span className={`material-symbols-outlined text-[14px] ${updatingId === '__all__' ? 'animate-spin' : ''}`}>
              {updatingId === '__all__' ? 'progress_activity' : 'system_update'}
            </span>
            {sk.pluginUpdateAllBtn || 'Update All'}
          </button>
        )}
        {/* Diagnostics toggle */}
        {diagnostics.length > 0 && (
          <button onClick={() => setShowDiagnostics(!showDiagnostics)}
            className={`h-9 px-2.5 text-[10px] font-bold rounded-lg flex items-center gap-1 shrink-0 transition-colors ${showDiagnostics ? 'bg-mac-red/10 text-mac-red' : 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-500/20'}`}>
            <span className="material-symbols-outlined text-[14px]">warning</span>
            {diagnostics.length}
          </button>
        )}
        {/* Refresh */}
        <button onClick={() => fetchPlugins()} disabled={refreshing}
          className="h-9 w-9 flex items-center justify-center bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
          title={sk.pluginRefresh || 'Refresh'}>
          <span className={`material-symbols-outlined text-[16px] text-slate-500 ${refreshing ? 'animate-spin' : ''}`}>
            {refreshing ? 'progress_activity' : 'refresh'}
          </span>
        </button>
      </div>

      {/* Remote gateway hint */}
      {isRemote && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 flex items-start gap-2">
          <span className="material-symbols-outlined text-[16px] text-amber-500 mt-0.5 shrink-0">warning</span>
          <div>
            <span className="text-[11px] font-bold text-amber-700 dark:text-amber-400">{sk.pluginRemoteGw || 'Remote Gateway'}</span>
            <p className="text-[10px] text-amber-600 dark:text-amber-400/80 mt-0.5">{sk.pluginRemoteHint || 'Install plugins via CLI'}</p>
          </div>
        </div>
      )}

      {/* Diagnostics panel */}
      {showDiagnostics && diagnostics.length > 0 && (
        <div className="mx-4 mt-3 p-3 rounded-lg bg-mac-red/5 dark:bg-mac-red/10 border border-mac-red/20">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-[11px] font-bold text-mac-red">{sk.pluginDiagnostics || 'Diagnostics'} ({diagnostics.length})</h4>
            <button onClick={() => setShowDiagnostics(false)} className="text-slate-400 hover:text-slate-600"><span className="material-symbols-outlined text-[14px]">close</span></button>
          </div>
          <div className="space-y-1 max-h-32 overflow-y-auto custom-scrollbar">
            {diagnostics.map((d, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[10px]">
                <span className={`material-symbols-outlined text-[12px] mt-0.5 ${d.level === 'error' ? 'text-mac-red' : 'text-amber-500'}`}>{d.level === 'error' ? 'error' : 'warning'}</span>
                <span className="text-slate-600 dark:text-white/60">{d.pluginId && <strong className="text-slate-700 dark:text-white/80">[{d.pluginId}]</strong>} {d.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Slots & Allow/Deny info bar — works on both local & remote */}
      {(Object.keys(slots).length > 0 || allowList.length > 0 || denyList.length > 0) && (
        <div className="mx-4 mt-3 flex flex-wrap gap-2">
          {Object.entries(slots).map(([key, value]) => (
            <span key={key} className="text-[10px] px-2 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/20 text-indigo-600 dark:text-indigo-400 font-bold">
              {key === 'memory' ? (sk.pluginSlotMemory || 'Memory') : key === 'contextEngine' ? (sk.pluginSlotContextEngine || 'Context Engine') : key}: {value || (sk.pluginSlotDefault || 'default')}
            </span>
          ))}
          {allowList.length > 0 && (
            <span className="text-[10px] px-2 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-bold">
              {sk.pluginAllowList || 'Allowlist'}: {allowList.join(', ')}
            </span>
          )}
          {denyList.length > 0 && (
            <span className="text-[10px] px-2 py-1 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-400 font-bold">
              {sk.pluginDenyList || 'Denylist'}: {denyList.join(', ')}
            </span>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar">
        <div className="max-w-6xl mx-auto">
          {/* Skeleton loading (no cache) */}
          {loading && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
            </div>
          )}

          {/* Empty */}
          {!loading && filtered.length === 0 && (
            <EmptyState icon="power_off" title={sk.pluginNoPlugins || 'No plugins found'} />
          )}

          {/* Plugin cards */}
          {!loading && filtered.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered.map(plugin => {
                const isCurrentInstalling = installingSpec === plugin.spec;
                const isUninstalling = uninstallingId === plugin.id;
                const isUpdating = updatingId === plugin.id || updatingId === '__all__';
                const isBusy = isCurrentInstalling || togglingId === plugin.id || isUninstalling || isUpdating;
                return (
                  <div key={plugin.id}
                    className={`bg-slate-50 dark:bg-white/[0.02] border rounded-2xl p-4 transition-all group shadow-sm flex flex-col ${
                      plugin.status === 'error' ? 'border-mac-red/30 dark:border-mac-red/20' :
                      plugin.installed
                        ? plugin.enabled ? 'border-mac-green/30 dark:border-mac-green/20 hover:border-mac-green/60' : 'border-slate-200/50 dark:border-white/5 opacity-60'
                        : 'border-slate-200 dark:border-white/10 hover:border-primary/40'
                    }`}>
                    {/* Header */}
                    <div className="flex items-center gap-2.5 mb-2">
                      <span className="text-lg leading-none">{plugin.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <h4 className="font-bold text-[13px] text-slate-800 dark:text-white truncate">{plugin.name}</h4>
                          {plugin.version && <span className="text-[9px] font-mono text-slate-400 dark:text-white/30 shrink-0">v{plugin.version}</span>}
                        </div>
                        <span className="text-[10px] font-mono text-slate-400 dark:text-white/30 truncate block">{plugin.spec}</span>
                      </div>
                      {/* Enable/Disable toggle — works on both local & remote */}
                      {plugin.installed && (
                        <button onClick={() => handleToggle(plugin)} disabled={isBusy}
                          className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${isBusy ? 'opacity-50 cursor-wait' : plugin.enabled ? 'bg-mac-green' : 'bg-slate-300 dark:bg-white/20'}`}>
                          <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${plugin.enabled ? 'translate-x-[18px] rtl:-translate-x-[18px]' : 'translate-x-0.5 rtl:-translate-x-0.5'}`} />
                        </button>
                      )}
                    </div>

                    {/* Status badges */}
                    <div className="flex flex-wrap gap-1 mb-2">
                      {plugin.status && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${statusBadge(plugin.status)}`}>
                          {statusLabel(plugin.status)}
                        </span>
                      )}
                      {!plugin.status && (plugin.installed ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-mac-green/15 text-mac-green font-bold">{sk.pluginInstalled || 'Installed'}</span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-white/40 font-bold">{sk.pluginNotInstalled || 'Not Installed'}</span>
                      ))}
                      {plugin.installSource && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-white/40 font-bold">
                          {plugin.installSource === 'npm' ? 'npm' : plugin.installSource === 'path' ? (sk.pluginPathSource || 'local path') : plugin.installSource}
                        </span>
                      )}
                      {plugin.kind && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-bold">{plugin.kind}</span>}
                      {plugin.relatedChannels && plugin.relatedChannels.length > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary/70 font-bold">{sk.pluginChannel || 'Channel'}: {plugin.relatedChannels.join(', ')}</span>
                      )}
                    </div>

                    {/* Error display */}
                    {plugin.error && (
                      <div className="mb-2 px-2 py-1 rounded-lg bg-mac-red/5 border border-mac-red/20 text-[10px] text-mac-red truncate" title={plugin.error}>
                        {plugin.error}
                      </div>
                    )}

                    {/* Description */}
                    <p className="text-[11px] text-slate-500 dark:text-white/40 leading-relaxed mb-3 line-clamp-2">{plugin.description}</p>

                    {/* Install/uninstall progress */}
                    {(isCurrentInstalling || isUninstalling || isUpdating) && (
                      <div className="mb-2 px-2 py-1.5 rounded-lg bg-primary/5 border border-primary/20 flex items-center gap-2">
                        <span className="material-symbols-outlined text-[14px] text-primary animate-spin">progress_activity</span>
                        <span className="text-[10px] font-bold text-primary">
                          {isUninstalling ? (sk.pluginUninstalling || 'Uninstalling...') :
                           isUpdating ? (sk.pluginUpdating || 'Updating...') :
                           installPhase === 'installing' ? (sk.pluginInstalling || 'Installing...') :
                           installPhase === 'restarting' ? (sk.pluginRestarting || 'Restarting gateway...') :
                           (sk.pluginReady || 'Gateway ready')}
                        </span>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-1 mt-auto pt-2 border-t border-slate-100 dark:border-white/5 flex-wrap">
                      {/* Install — local only */}
                      {!plugin.installed && (
                        <button onClick={() => handleInstall(plugin)} disabled={!canInstall || !!installingSpec}
                          className="h-7 px-3 bg-primary/10 text-primary text-[10px] font-bold rounded-lg hover:bg-primary hover:text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1">
                          <span className="material-symbols-outlined text-[12px]">download</span>
                          {sk.pluginInstallBtn || 'Install'}
                        </button>
                      )}
                      {/* Update — local only, npm plugins */}
                      {plugin.installed && canInstall && plugin.installSource === 'npm' && (
                        <button onClick={() => handleUpdate(plugin.id)} disabled={isBusy}
                          className="h-7 px-2.5 bg-primary/10 text-primary text-[10px] font-bold rounded-lg hover:bg-primary hover:text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1">
                          <span className="material-symbols-outlined text-[12px]">system_update</span>
                          {sk.pluginUpdateBtn || 'Update'}
                        </button>
                      )}
                      {/* Uninstall — local only */}
                      {plugin.installed && canInstall && (
                        <button onClick={() => handleUninstall(plugin)} disabled={isBusy}
                          className="h-7 px-2.5 bg-mac-red/10 text-mac-red text-[10px] font-bold rounded-lg hover:bg-mac-red hover:text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1">
                          <span className="material-symbols-outlined text-[12px]">delete</span>
                          {sk.pluginUninstallBtn || 'Uninstall'}
                        </button>
                      )}
                      {/* Detail — works on both local & remote */}
                      <button onClick={() => setDetailPlugin(plugin)}
                        className="h-7 px-2.5 bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/60 hover:bg-slate-200 dark:hover:bg-white/10 text-[10px] font-bold rounded-lg transition-colors flex items-center gap-1">
                        <span className="material-symbols-outlined text-[11px]">info</span>
                        {sk.pluginDetailTitle || 'Details'}
                      </button>
                      {/* Copy spec */}
                      <button onClick={() => handleCopySpec(plugin.spec)}
                        className="h-7 px-2.5 bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/60 hover:bg-slate-200 dark:hover:bg-white/10 text-[10px] font-bold rounded-lg transition-colors flex items-center gap-1">
                        <span className="material-symbols-outlined text-[11px]">content_copy</span>
                        {sk.pluginCopySpec || 'Copy Spec'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Detail modal — works on both local & remote */}
      {detailPlugin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setDetailPlugin(null)}>
          <div className="bg-white dark:bg-[#1a1c22] border border-slate-200 dark:border-white/10 rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            {/* Modal header */}
            <div className="px-5 py-4 border-b border-slate-200 dark:border-white/5 flex items-center gap-3">
              <span className="text-xl">{detailPlugin.icon}</span>
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-[15px] text-slate-800 dark:text-white truncate">{detailPlugin.name}</h3>
                <span className="text-[10px] font-mono text-slate-400">{detailPlugin.spec}</span>
              </div>
              <button onClick={() => setDetailPlugin(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-white/60">
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>
            {/* Modal body */}
            <div className="flex-1 overflow-y-auto px-5 py-4 custom-scrollbar space-y-3">
              {/* Basic info rows */}
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div><span className="text-slate-400 dark:text-white/30">{sk.pluginDetailStatus || 'Status'}:</span> <span className={`font-bold ${detailPlugin.status === 'loaded' ? 'text-mac-green' : detailPlugin.status === 'error' ? 'text-mac-red' : 'text-slate-500'}`}>{statusLabel(detailPlugin.status)}</span></div>
                {detailPlugin.version && <div><span className="text-slate-400 dark:text-white/30">{sk.pluginDetailVersion || 'Version'}:</span> <span className="font-bold text-slate-700 dark:text-white/80">{detailPlugin.version}</span></div>}
                {detailPlugin.origin && <div><span className="text-slate-400 dark:text-white/30">{sk.pluginDetailOrigin || 'Origin'}:</span> <span className="font-bold text-slate-700 dark:text-white/80">{detailPlugin.origin}</span></div>}
                {detailPlugin.installSource && <div><span className="text-slate-400 dark:text-white/30">{sk.pluginDetailInstallSource || 'Install Source'}:</span> <span className="font-bold text-slate-700 dark:text-white/80">{detailPlugin.installSource}</span></div>}
                {detailPlugin.installedAt && <div><span className="text-slate-400 dark:text-white/30">{sk.pluginDetailInstalledAt || 'Installed At'}:</span> <span className="font-bold text-slate-700 dark:text-white/80">{detailPlugin.installedAt}</span></div>}
                {detailPlugin.kind && <div><span className="text-slate-400 dark:text-white/30">Kind:</span> <span className="font-bold text-slate-700 dark:text-white/80">{detailPlugin.kind}</span></div>}
              </div>
              {detailPlugin.installPath && (
                <div className="text-[10px]"><span className="text-slate-400 dark:text-white/30">{sk.pluginDetailInstallPath || 'Install Path'}:</span> <span className="font-mono text-slate-600 dark:text-white/50 break-all">{detailPlugin.installPath}</span></div>
              )}
              {detailPlugin.source && (
                <div className="text-[10px]"><span className="text-slate-400 dark:text-white/30">{sk.pluginDetailSource || 'Source'}:</span> <span className="font-mono text-slate-600 dark:text-white/50 break-all">{detailPlugin.source}</span></div>
              )}
              {/* Error */}
              {detailPlugin.error && (
                <div className="px-3 py-2 rounded-lg bg-mac-red/5 border border-mac-red/20">
                  <span className="text-[10px] font-bold text-mac-red">{sk.pluginDetailError || 'Error'}:</span>
                  <pre className="text-[10px] text-mac-red/80 mt-1 whitespace-pre-wrap break-all">{detailPlugin.error}</pre>
                </div>
              )}
              {/* Capabilities */}
              {detailPlugin.toolNames && detailPlugin.toolNames.length > 0 && (
                <div><span className="text-[10px] font-bold text-slate-500 dark:text-white/40">{sk.pluginDetailTools || 'Tools'}</span><div className="flex flex-wrap gap-1 mt-1">{detailPlugin.toolNames.map(n => <span key={n} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/50 font-mono">{n}</span>)}</div></div>
              )}
              {detailPlugin.hookNames && detailPlugin.hookNames.length > 0 && (
                <div><span className="text-[10px] font-bold text-slate-500 dark:text-white/40">{sk.pluginDetailHooks || 'Hooks'}</span><div className="flex flex-wrap gap-1 mt-1">{detailPlugin.hookNames.map(n => <span key={n} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/50 font-mono">{n}</span>)}</div></div>
              )}
              {detailPlugin.channelIds && detailPlugin.channelIds.length > 0 && (
                <div><span className="text-[10px] font-bold text-slate-500 dark:text-white/40">{sk.pluginDetailChannels || 'Channels'}</span><div className="flex flex-wrap gap-1 mt-1">{detailPlugin.channelIds.map(n => <span key={n} className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary/70 font-mono">{n}</span>)}</div></div>
              )}
              {detailPlugin.providerIds && detailPlugin.providerIds.length > 0 && (
                <div><span className="text-[10px] font-bold text-slate-500 dark:text-white/40">{sk.pluginDetailProviders || 'Providers'}</span><div className="flex flex-wrap gap-1 mt-1">{detailPlugin.providerIds.map(n => <span key={n} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/50 font-mono">{n}</span>)}</div></div>
              )}
              {detailPlugin.gatewayMethods && detailPlugin.gatewayMethods.length > 0 && (
                <div><span className="text-[10px] font-bold text-slate-500 dark:text-white/40">{sk.pluginDetailGatewayMethods || 'Gateway Methods'}</span><div className="flex flex-wrap gap-1 mt-1">{detailPlugin.gatewayMethods.map(n => <span key={n} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/50 font-mono">{n}</span>)}</div></div>
              )}
              {detailPlugin.cliCommands && detailPlugin.cliCommands.length > 0 && (
                <div><span className="text-[10px] font-bold text-slate-500 dark:text-white/40">{sk.pluginDetailCliCommands || 'CLI Commands'}</span><div className="flex flex-wrap gap-1 mt-1">{detailPlugin.cliCommands.map(n => <span key={n} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/50 font-mono">{n}</span>)}</div></div>
              )}
              {detailPlugin.services && detailPlugin.services.length > 0 && (
                <div><span className="text-[10px] font-bold text-slate-500 dark:text-white/40">{sk.pluginDetailServices || 'Services'}</span><div className="flex flex-wrap gap-1 mt-1">{detailPlugin.services.map(n => <span key={n} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/50 font-mono">{n}</span>)}</div></div>
              )}
              {detailPlugin.commands && detailPlugin.commands.length > 0 && (
                <div><span className="text-[10px] font-bold text-slate-500 dark:text-white/40">{sk.pluginDetailCommands || 'Commands'}</span><div className="flex flex-wrap gap-1 mt-1">{detailPlugin.commands.map(n => <span key={n} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/50 font-mono">{n}</span>)}</div></div>
              )}
              {detailPlugin.httpRoutes != null && detailPlugin.httpRoutes > 0 && (
                <div className="text-[10px]"><span className="text-slate-400 dark:text-white/30">{sk.pluginDetailHttpRoutes || 'HTTP Routes'}:</span> <span className="font-bold text-slate-700 dark:text-white/80">{detailPlugin.httpRoutes}</span></div>
              )}
              {/* If no detail info at all */}
              {!detailPlugin.status && !detailPlugin.version && !detailPlugin.toolNames?.length && !detailPlugin.hookNames?.length && !detailPlugin.channelIds?.length && (
                <p className="text-[11px] text-slate-400 dark:text-white/30 text-center py-4">{sk.pluginDetailNoInfo || 'No detailed info available'}</p>
              )}
            </div>
            {/* Modal footer */}
            <div className="px-5 py-3 border-t border-slate-200 dark:border-white/5 flex justify-end">
              <button onClick={() => setDetailPlugin(null)} className="h-8 px-4 bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/60 hover:bg-slate-200 dark:hover:bg-white/10 text-[11px] font-bold rounded-lg transition-colors">
                {sk.pluginClose || 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer status bar */}
      <footer className="h-8 px-4 border-t border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-black/20 flex items-center justify-between shrink-0 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-white/20">
        <div className="flex items-center gap-3">
          <span>{plugins.length} {sk.pluginCatalogCount || 'plugins in catalog'}</span>
          <span className="w-1 h-1 rounded-full bg-slate-200 dark:bg-white/10" />
          <span className="text-mac-green">{loadedCount} {sk.pluginLoadedCount || 'loaded'}</span>
          {errorCount > 0 && (<><span className="w-1 h-1 rounded-full bg-slate-200 dark:bg-white/10" /><span className="text-mac-red">{errorCount} {sk.pluginErrorCount || 'errors'}</span></>)}
        </div>
        <div className="flex items-center gap-1">
          <span className="material-symbols-outlined text-[12px]">{isRemote ? 'cloud' : 'computer'}</span>
          <span>{isRemote ? (sk.pluginRemoteGw || 'Remote Gateway') : (sk.pluginLocalGw || 'Local Gateway')}</span>
        </div>
      </footer>
    </div>
  );
};

export default PluginCenter;
