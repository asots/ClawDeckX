import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Language } from '../../types';
import { getTranslation } from '../../locales';
import { llmApi } from '../../services/api';
import type { LlmProbeResult, LlmProbeSummary, LlmModelsStatusResponse, LlmAuthHealthSummary } from '../../services/api';
import { useToast } from '../Toast';

interface LlmHealthPanelProps {
  language: Language;
}

type ProbeHistoryEntry = {
  timestamp: string;
  results: LlmProbeResult[];
  totalMs: number;
  okCount: number;
  failCount: number;
};

const PROBE_HISTORY_KEY = 'doctor.llm.probeHistory';
const MAX_PROBE_HISTORY = 20;

function probeStatusColor(status: string): string {
  switch (status) {
    case 'ok': return 'text-emerald-600 dark:text-emerald-400';
    case 'auth': return 'text-red-600 dark:text-red-400';
    case 'billing': return 'text-orange-600 dark:text-orange-400';
    case 'rate_limit': return 'text-amber-600 dark:text-amber-400';
    case 'timeout': return 'text-yellow-600 dark:text-yellow-400';
    case 'format': return 'text-purple-600 dark:text-purple-400';
    case 'no_model': return 'text-slate-500 dark:text-white/40';
    default: return 'text-red-500 dark:text-red-400';
  }
}

function probeStatusBg(status: string): string {
  switch (status) {
    case 'ok': return 'bg-emerald-500/10';
    case 'auth': return 'bg-red-500/10';
    case 'billing': return 'bg-orange-500/10';
    case 'rate_limit': return 'bg-amber-500/10';
    case 'timeout': return 'bg-yellow-500/10';
    case 'format': return 'bg-purple-500/10';
    case 'no_model': return 'bg-slate-500/10';
    default: return 'bg-red-500/10';
  }
}

function authStatusColor(status: string): string {
  switch (status) {
    case 'ok': return 'text-emerald-600 dark:text-emerald-400';
    case 'static': return 'text-blue-600 dark:text-blue-400';
    case 'expiring': return 'text-amber-600 dark:text-amber-400';
    case 'expired': return 'text-red-600 dark:text-red-400';
    case 'missing': return 'text-slate-500 dark:text-white/40';
    default: return 'text-slate-500 dark:text-white/40';
  }
}

function authStatusBg(status: string): string {
  switch (status) {
    case 'ok': return 'bg-emerald-500/10';
    case 'static': return 'bg-blue-500/10';
    case 'expiring': return 'bg-amber-500/10';
    case 'expired': return 'bg-red-500/10';
    case 'missing': return 'bg-slate-500/10';
    default: return 'bg-slate-500/10';
  }
}

function providerIcon(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes('anthropic') || p.includes('claude')) return 'psychology';
  if (p.includes('openai') || p.includes('gpt')) return 'auto_awesome';
  if (p.includes('google') || p.includes('gemini')) return 'diamond';
  if (p.includes('deepseek')) return 'code';
  if (p.includes('ollama')) return 'computer';
  if (p.includes('openrouter')) return 'hub';
  if (p.includes('mistral')) return 'wind_power';
  if (p.includes('groq')) return 'bolt';
  if (p.includes('cohere')) return 'link';
  if (p.includes('together')) return 'group';
  if (p.includes('fireworks')) return 'local_fire_department';
  if (p.includes('qwen') || p.includes('alibaba')) return 'cloud';
  if (p.includes('stepfun')) return 'stacked_line_chart';
  if (p.includes('arcee')) return 'precision_manufacturing';
  if (p.includes('comfy')) return 'palette';
  if (p.includes('vydra')) return 'graphic_eq';
  if (p.includes('bedrock') || p.includes('amazon')) return 'dns';
  return 'smart_toy';
}

function formatMs(ms?: number): string {
  if (ms === undefined || ms === null) return '--';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRemaining(ms?: number): string {
  if (!ms || ms <= 0) return '--';
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h`;
  const mins = Math.floor(ms / 60000);
  return `${mins}m`;
}

const LlmHealthPanel: React.FC<LlmHealthPanelProps> = ({ language }) => {
  const t = useMemo(() => getTranslation(language) as any, [language]);
  const { toast } = useToast();
  const dr = (t.dr || {}) as any;

  const [modelsStatus, setModelsStatus] = useState<LlmModelsStatusResponse | null>(null);
  const [authHealth, setAuthHealth] = useState<LlmAuthHealthSummary | null>(null);
  const [probeResults, setProbeResults] = useState<LlmProbeSummary | null>(null);
  const [probeHistory, setProbeHistory] = useState<ProbeHistoryEntry[]>(() => {
    try {
      const raw = localStorage.getItem(PROBE_HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const [loading, setLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [probing, setProbing] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [activeSection, setActiveSection] = useState<'providers' | 'auth' | 'fallback' | 'errors'>('providers');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadData = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const [status, health] = await Promise.all([
        llmApi.modelsStatusCached(15000, force),
        llmApi.authHealthCached(15000, force),
      ]);
      if (mountedRef.current) {
        setModelsStatus(status);
        setAuthHealth(health);
        setHasLoadedOnce(true);
      }
    } catch (err: any) {
      if (mountedRef.current) {
        toast('error', `${dr.llmLoadFail || 'Failed to load LLM status'}: ${err?.message || ''}`);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [dr.llmLoadFail, toast]);

  useEffect(() => { loadData(false); }, [loadData]);

  const runProbe = useCallback(async (provider?: string) => {
    setProbing(true);
    try {
      const params = provider ? { provider } : {};
      const result = await llmApi.probe(params);
      if (!mountedRef.current) return;
      setProbeResults(result);
      const entry: ProbeHistoryEntry = {
        timestamp: new Date().toISOString(),
        results: result.results,
        totalMs: result.totalMs,
        okCount: result.okCount,
        failCount: result.failCount,
      };
      setProbeHistory(prev => {
        const next = [entry, ...prev].slice(0, MAX_PROBE_HISTORY);
        try { localStorage.setItem(PROBE_HISTORY_KEY, JSON.stringify(next)); } catch {}
        return next;
      });
      if (result.failCount > 0) {
        toast('warning', `${dr.llmProbePartial || 'Probe complete'}: ${result.okCount} ${dr.ok || 'OK'}, ${result.failCount} ${dr.llmFailed || 'failed'}`);
      } else {
        toast('success', `${dr.llmProbeOk || 'All providers healthy'} (${formatMs(result.totalMs)})`);
      }
      await loadData(true);
    } catch (err: any) {
      if (mountedRef.current) {
        toast('error', `${dr.llmProbeFail || 'Probe failed'}: ${err?.message || ''}`);
      }
    } finally {
      if (mountedRef.current) setProbing(false);
    }
  }, [dr.llmFailed, dr.llmProbeOk, dr.llmProbePartial, dr.llmProbeFail, dr.ok, loadData, toast]);

  const providers = useMemo(() => authHealth?.providers || [], [authHealth]);
  const profiles = useMemo(() => authHealth?.profiles || [], [authHealth]);
  const models = useMemo(() => modelsStatus?.models || [], [modelsStatus]);
  const fallbacks = useMemo(() => modelsStatus?.fallbacks || [], [modelsStatus]);

  const providerCards = useMemo(() => {
    const map = new Map<string, {
      provider: string;
      authStatus: string;
      profileCount: number;
      modelCount: number;
      models: string[];
      probeStatus?: string;
      latencyMs?: number;
      probeError?: string;
    }>();

    providers.forEach(p => {
      map.set(p.provider, {
        provider: p.provider,
        authStatus: p.status,
        profileCount: p.profileCount,
        modelCount: 0,
        models: [],
      });
    });

    models.forEach(m => {
      const existing = map.get(m.provider);
      if (existing) {
        existing.modelCount++;
        if (!existing.models.includes(m.model)) existing.models.push(m.model);
      } else {
        map.set(m.provider, {
          provider: m.provider,
          authStatus: 'static',
          profileCount: 0,
          modelCount: 1,
          models: [m.model],
        });
      }
    });

    if (probeResults) {
      probeResults.results.forEach(r => {
        const existing = map.get(r.provider);
        if (existing) {
          existing.probeStatus = r.status;
          existing.latencyMs = r.latencyMs;
          existing.probeError = r.error;
        }
      });
    }

    return Array.from(map.values()).sort((a, b) => {
      const order: Record<string, number> = { ok: 0, static: 1, expiring: 2, expired: 3, missing: 4 };
      return (order[a.authStatus] ?? 5) - (order[b.authStatus] ?? 5);
    });
  }, [providers, models, probeResults]);

  const overallStatus = useMemo(() => {
    if (providerCards.length === 0) return 'unknown';
    const hasError = providerCards.some(p => p.authStatus === 'expired' || p.authStatus === 'missing' || p.probeStatus === 'auth' || p.probeStatus === 'billing');
    const hasWarn = providerCards.some(p => p.authStatus === 'expiring' || p.probeStatus === 'timeout' || p.probeStatus === 'rate_limit');
    if (hasError) return 'error';
    if (hasWarn) return 'warn';
    return 'ok';
  }, [providerCards]);

  const errorStats = useMemo(() => {
    if (!probeResults) return null;
    const counts: Record<string, number> = {};
    probeResults.results.forEach(r => {
      if (r.status !== 'ok') {
        counts[r.status] = (counts[r.status] || 0) + 1;
      }
    });
    return counts;
  }, [probeResults]);

  const sectionBtns: Array<{ id: typeof activeSection; icon: string; label: string }> = [
    { id: 'providers', icon: 'dns', label: dr.llmSectionProviders || 'Providers' },
    { id: 'auth', icon: 'key', label: dr.llmSectionAuth || 'Auth' },
    { id: 'fallback', icon: 'swap_horiz', label: dr.llmSectionFallback || 'Fallback' },
    { id: 'errors', icon: 'error_outline', label: dr.llmSectionErrors || 'Errors' },
  ];

  return (
    <div className="space-y-3 max-w-6xl mx-auto">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${overallStatus === 'ok' ? 'bg-emerald-500' : overallStatus === 'warn' ? 'bg-amber-500' : overallStatus === 'error' ? 'bg-red-500' : 'bg-slate-400'}`} />
          <span className="text-[12px] font-bold text-slate-700 dark:text-white/75">
            {providerCards.length} {dr.llmProviders || 'Providers'}
          </span>
          {probeResults && (
            <span className="text-[10px] text-slate-400 dark:text-white/35">
              {dr.llmLastProbe || 'Last probe'}: {probeResults.okCount}/{probeResults.results.length} OK ({formatMs(probeResults.totalMs)})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => loadData(true)} disabled={loading}
            className="h-7 px-2.5 rounded-lg text-[10px] font-bold border border-slate-200 dark:border-white/10 text-slate-600 dark:text-white/50 hover:bg-slate-50 dark:hover:bg-white/[0.03] disabled:opacity-50 flex items-center gap-1">
            <span className={`material-symbols-outlined text-[12px] ${loading ? 'animate-spin' : ''}`}>{loading ? 'progress_activity' : 'refresh'}</span>
            {dr.llmRefresh || 'Refresh'}
          </button>
          <button onClick={() => runProbe()} disabled={probing}
            className="h-7 px-2.5 rounded-lg text-[10px] font-bold bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-50 flex items-center gap-1">
            <span className={`material-symbols-outlined text-[12px] ${probing ? 'animate-spin' : ''}`}>{probing ? 'progress_activity' : 'network_check'}</span>
            {probing ? (dr.llmProbing || 'Probing...') : (dr.llmProbeAll || 'Probe All')}
          </button>
        </div>
      </div>

      {/* Enter Detecting Banner */}
      {loading && !hasLoadedOnce && (
        <div className="rounded-xl border border-primary/30 bg-primary/10 px-3 py-2 flex items-center gap-2 text-[11px] text-primary">
          <span className="material-symbols-outlined text-[14px] animate-spin">monitor_heart</span>
          <span className="font-semibold">{dr.llmDetecting || 'Detecting LLM health status...'}</span>
          <span className="ms-0.5 inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
        </div>
      )}

      {/* Section Tabs */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {sectionBtns.map(s => (
          <button key={s.id} onClick={() => setActiveSection(s.id)}
            className={`h-7 px-2.5 rounded-lg text-[10px] font-bold flex items-center gap-1 whitespace-nowrap transition-all ${activeSection === s.id ? 'bg-primary/15 text-primary' : 'bg-slate-100 dark:bg-white/[0.04] text-slate-500 dark:text-white/40 hover:bg-slate-200 dark:hover:bg-white/[0.06]'}`}>
            <span className="material-symbols-outlined text-[12px]">{s.icon}</span>
            {s.label}
          </button>
        ))}
        <button onClick={() => setShowHistory(!showHistory)}
          className={`h-7 px-2.5 rounded-lg text-[10px] font-bold flex items-center gap-1 whitespace-nowrap transition-all ms-auto ${showHistory ? 'bg-primary/15 text-primary' : 'bg-slate-100 dark:bg-white/[0.04] text-slate-500 dark:text-white/40 hover:bg-slate-200 dark:hover:bg-white/[0.06]'}`}>
          <span className="material-symbols-outlined text-[12px]">history</span>
          {dr.llmHistory || 'History'} {probeHistory.length > 0 && `(${probeHistory.length})`}
        </button>
      </div>

      {/* === Providers Section === */}
      {activeSection === 'providers' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
          {providerCards.length === 0 && !loading && (
            <div className="col-span-full text-center py-8 text-[11px] text-slate-400 dark:text-white/40">
              {dr.llmNoProviders || 'No LLM providers configured'}
            </div>
          )}
          {loading && providerCards.length === 0 && (
            <div className="col-span-full flex items-center justify-center py-8 gap-2">
              <span className="material-symbols-outlined text-[16px] text-primary/60 animate-spin">progress_activity</span>
              <span className="text-[11px] text-slate-400">{dr.running || 'Loading...'}</span>
            </div>
          )}
          {providerCards.map(card => {
            const isExpanded = expandedProvider === card.provider;
            const probeRes = probeResults?.results.filter(r => r.provider === card.provider) || [];
            return (
              <div key={card.provider}
                className={`rounded-xl border p-3 transition-all cursor-pointer hover:border-primary/30 ${
                  card.probeStatus === 'ok' ? 'border-emerald-200/70 dark:border-emerald-500/20 bg-gradient-to-br from-emerald-50/50 to-white dark:from-emerald-500/5 dark:to-transparent' :
                  card.probeStatus && card.probeStatus !== 'ok' ? 'border-red-200/70 dark:border-red-500/20 bg-gradient-to-br from-red-50/50 to-white dark:from-red-500/5 dark:to-transparent' :
                  card.authStatus === 'expired' || card.authStatus === 'missing' ? 'border-red-200/70 dark:border-red-500/20 bg-gradient-to-br from-red-50/30 to-white dark:from-red-500/5 dark:to-transparent' :
                  card.authStatus === 'expiring' ? 'border-amber-200/70 dark:border-amber-500/20 bg-gradient-to-br from-amber-50/30 to-white dark:from-amber-500/5 dark:to-transparent' :
                  'border-slate-200/70 dark:border-white/10 bg-white dark:bg-white/[0.02]'
                }`}
                onClick={() => setExpandedProvider(isExpanded ? null : card.provider)}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="material-symbols-outlined text-[18px] text-slate-500 dark:text-white/50">{providerIcon(card.provider)}</span>
                    <div className="min-w-0">
                      <p className="text-[12px] font-bold text-slate-700 dark:text-white/75 truncate">{card.provider}</p>
                      <p className="text-[9px] text-slate-400 dark:text-white/30">{card.modelCount} {dr.llmModels || 'models'} · {card.profileCount} {dr.llmProfiles || 'profiles'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {card.probeStatus && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${probeStatusBg(card.probeStatus)} ${probeStatusColor(card.probeStatus)}`}>
                        {card.probeStatus === 'ok' ? (dr.ok || 'OK') : card.probeStatus.toUpperCase()}
                      </span>
                    )}
                    {card.latencyMs !== undefined && (
                      <span className="text-[9px] text-slate-400 dark:text-white/30">{formatMs(card.latencyMs)}</span>
                    )}
                    {!card.probeStatus && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${authStatusBg(card.authStatus)} ${authStatusColor(card.authStatus)}`}>
                        {card.authStatus.toUpperCase()}
                      </span>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); runProbe(card.provider); }} disabled={probing}
                      className="w-6 h-6 rounded-lg flex items-center justify-center hover:bg-primary/10 disabled:opacity-40"
                      title={dr.llmProbeOne || 'Probe this provider'}>
                      <span className={`material-symbols-outlined text-[14px] text-primary ${probing ? 'animate-spin' : ''}`}>
                        {probing ? 'progress_activity' : 'play_arrow'}
                      </span>
                    </button>
                  </div>
                </div>
                {card.probeError && (
                  <p className="text-[10px] text-red-500 dark:text-red-400 mt-1.5 break-all line-clamp-2">{card.probeError}</p>
                )}
                {card.models.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {card.models.slice(0, isExpanded ? card.models.length : 3).map(m => (
                      <span key={m} className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/[0.04] text-slate-500 dark:text-white/40 truncate max-w-[140px]">{m}</span>
                    ))}
                    {!isExpanded && card.models.length > 3 && (
                      <span className="text-[9px] text-slate-400 dark:text-white/30">+{card.models.length - 3}</span>
                    )}
                  </div>
                )}
                {isExpanded && probeRes.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-slate-200/60 dark:border-white/10 space-y-1">
                    <p className="text-[9px] uppercase tracking-wider text-slate-400 dark:text-white/35">{dr.llmProbeResults || 'Probe Results'}</p>
                    {probeRes.map((r, i) => (
                      <div key={`${r.model}-${i}`} className="flex items-center justify-between gap-2 text-[10px]">
                        <span className="text-slate-600 dark:text-white/55 truncate">{r.model}</span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className={`font-bold ${probeStatusColor(r.status)}`}>{r.status.toUpperCase()}</span>
                          {r.latencyMs !== undefined && <span className="text-slate-400 dark:text-white/30">{formatMs(r.latencyMs)}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* === Auth Section === */}
      {activeSection === 'auth' && (
        <div className="rounded-2xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-3">
          <p className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-white/40 mb-2 flex items-center gap-1">
            <span className="material-symbols-outlined text-[12px]">key</span>
            {dr.llmAuthTitle || 'Authentication Profiles'}
          </p>
          {profiles.length === 0 ? (
            <p className="text-[11px] text-slate-400 dark:text-white/40 py-4 text-center">{dr.llmNoAuth || 'No auth profiles found'}</p>
          ) : (
            <div className="space-y-2">
              {profiles.map((p, i) => (
                <div key={`${p.provider}-${p.profileId || i}`}
                  className="rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.02] p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-[14px] text-slate-400">{providerIcon(p.provider)}</span>
                        <p className="text-[12px] font-bold text-slate-700 dark:text-white/75 truncate">{p.provider}</p>
                        {p.profileId && <span className="text-[9px] text-slate-400 dark:text-white/30 truncate">({p.profileId})</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        {p.authType && <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/[0.04] text-slate-500 dark:text-white/40">{p.authType}</span>}
                        {p.label && <span className="text-[9px] text-slate-400 dark:text-white/30">{p.label}</span>}
                        {p.source && <span className="text-[9px] text-slate-400 dark:text-white/30">{dr.llmSource || 'source'}: {p.source}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {p.remainingMs !== undefined && p.remainingMs > 0 && (
                        <span className="text-[9px] text-slate-400 dark:text-white/30">
                          {dr.llmExpires || 'expires'}: {formatRemaining(p.remainingMs)}
                        </span>
                      )}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${authStatusBg(p.authStatus)} ${authStatusColor(p.authStatus)}`}>
                        {p.authStatus.toUpperCase()}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* === Fallback Section === */}
      {activeSection === 'fallback' && (
        <div className="space-y-3">
          {/* Fallback summary */}
          {fallbacks.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="rounded-xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-2.5 text-center">
                <p className="text-[18px] font-black text-primary">{fallbacks.length}</p>
                <p className="text-[9px] text-slate-400 dark:text-white/40 uppercase font-bold">{dr.llmFallbackChains || 'Chains'}</p>
              </div>
              <div className="rounded-xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-2.5 text-center">
                <p className="text-[18px] font-black text-slate-700 dark:text-white/75">{fallbacks.reduce((s, f) => s + f.chain.length, 0)}</p>
                <p className="text-[9px] text-slate-400 dark:text-white/40 uppercase font-bold">{dr.llmTotalNodes || 'Nodes'}</p>
              </div>
              <div className="rounded-xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-2.5 text-center">
                <p className="text-[18px] font-black text-emerald-600 dark:text-emerald-400">
                  {fallbacks.reduce((s, f) => s + f.chain.filter(c => {
                    const pr = probeResults?.results.find(r => r.provider === c.provider && r.model === c.model);
                    return pr?.status === 'ok';
                  }).length, 0)}
                </p>
                <p className="text-[9px] text-slate-400 dark:text-white/40 uppercase font-bold">{dr.llmHealthy || 'Healthy'}</p>
              </div>
              <div className="rounded-xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-2.5 text-center">
                <p className="text-[18px] font-black text-red-500">
                  {fallbacks.reduce((s, f) => s + f.chain.filter(c => {
                    const pr = probeResults?.results.find(r => r.provider === c.provider && r.model === c.model);
                    return pr && pr.status !== 'ok';
                  }).length, 0)}
                </p>
                <p className="text-[9px] text-slate-400 dark:text-white/40 uppercase font-bold">{dr.llmFailed || 'Failed'}</p>
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-white/40 mb-3 flex items-center gap-1">
              <span className="material-symbols-outlined text-[12px]">swap_horiz</span>
              {dr.llmFallbackTitle || 'Fallback Chains'}
            </p>
            {fallbacks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <span className="material-symbols-outlined text-[32px] text-slate-300 dark:text-white/15 mb-2">link_off</span>
                <p className="text-[11px] text-slate-400 dark:text-white/40">{dr.llmNoFallback || 'No fallback chains configured'}</p>
                <p className="text-[9px] text-slate-300 dark:text-white/20 mt-1">{dr.llmNoFallbackHint || 'Configure model fallbacks in your openclaw config'}</p>
              </div>
            ) : (
              <div className="space-y-4">
                {fallbacks.map((fb, fi) => {
                  const chainHealth = fb.chain.map(c => {
                    const pr = probeResults?.results.find(r => r.provider === c.provider && r.model === c.model);
                    const auth = profiles.find(p => p.provider === c.provider);
                    return { ...c, probeRes: pr, authProfile: auth };
                  });
                  const healthyCount = chainHealth.filter(c => c.probeRes?.status === 'ok').length;
                  const failedCount = chainHealth.filter(c => c.probeRes && c.probeRes.status !== 'ok').length;
                  const untestedCount = chainHealth.filter(c => !c.probeRes).length;
                  const chainStatus = failedCount === fb.chain.length ? 'critical' : failedCount > 0 ? 'degraded' : healthyCount === fb.chain.length ? 'healthy' : 'unknown';

                  return (
                    <div key={`fb-${fi}`} className={`rounded-xl border p-3 ${
                      chainStatus === 'critical' ? 'border-red-200/60 dark:border-red-500/20 bg-gradient-to-r from-red-50/30 to-white dark:from-red-500/[0.03] dark:to-transparent' :
                      chainStatus === 'degraded' ? 'border-amber-200/60 dark:border-amber-500/20 bg-gradient-to-r from-amber-50/30 to-white dark:from-amber-500/[0.03] dark:to-transparent' :
                      chainStatus === 'healthy' ? 'border-emerald-200/60 dark:border-emerald-500/20 bg-gradient-to-r from-emerald-50/30 to-white dark:from-emerald-500/[0.03] dark:to-transparent' :
                      'border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-white/[0.01]'
                    }`}>
                      {/* Chain header */}
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-black text-white ${
                            chainStatus === 'critical' ? 'bg-red-500' : chainStatus === 'degraded' ? 'bg-amber-500' : chainStatus === 'healthy' ? 'bg-emerald-500' : 'bg-slate-400'
                          }`}>{fi + 1}</span>
                          <div>
                            <p className="text-[11px] font-bold text-slate-700 dark:text-white/75 uppercase">{fb.role}</p>
                            <p className="text-[9px] text-slate-400 dark:text-white/30">
                              {fb.chain.length} {dr.llmNodes || 'nodes'}
                              {healthyCount > 0 && <span className="text-emerald-500 ms-1">· {healthyCount} {dr.ok || 'OK'}</span>}
                              {failedCount > 0 && <span className="text-red-500 ms-1">· {failedCount} {dr.llmFailed || 'failed'}</span>}
                              {untestedCount > 0 && <span className="text-slate-400 ms-1">· {untestedCount} {dr.llmUntested || 'untested'}</span>}
                            </p>
                          </div>
                        </div>
                        {chainStatus !== 'unknown' && (
                          <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold uppercase ${
                            chainStatus === 'healthy' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' :
                            chainStatus === 'degraded' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' :
                            'bg-red-500/10 text-red-600 dark:text-red-400'
                          }`}>
                            {chainStatus === 'healthy' ? (dr.llmChainHealthy || 'All Healthy') :
                             chainStatus === 'degraded' ? (dr.llmChainDegraded || 'Degraded') :
                             (dr.llmChainDown || 'All Down')}
                          </span>
                        )}
                      </div>

                      {/* Chain pipeline visualization */}
                      <div className="relative">
                        {/* Connector line */}
                        {fb.chain.length > 1 && (
                          <div className="absolute top-1/2 start-4 end-4 h-px bg-slate-200 dark:bg-white/10 -translate-y-1/2 hidden sm:block" />
                        )}
                        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-0">
                          {chainHealth.map((c, ci) => {
                            const isPrimary = ci === 0;
                            const isHealthy = c.probeRes?.status === 'ok';
                            const isFailed = c.probeRes && c.probeRes.status !== 'ok';
                            const nodeColor = isHealthy ? 'border-emerald-300 dark:border-emerald-500/30' :
                              isFailed ? 'border-red-300 dark:border-red-500/30' : 'border-slate-200 dark:border-white/10';
                            const nodeBg = isHealthy ? 'bg-emerald-50/50 dark:bg-emerald-500/5' :
                              isFailed ? 'bg-red-50/50 dark:bg-red-500/5' : 'bg-white dark:bg-white/[0.02]';

                            return (
                              <React.Fragment key={`${c.provider}-${c.model}-${ci}`}>
                                {ci > 0 && (
                                  <div className="flex items-center justify-center sm:mx-1 shrink-0">
                                    <span className="material-symbols-outlined text-[14px] text-slate-300 dark:text-white/20 rotate-90 sm:rotate-0">arrow_forward</span>
                                  </div>
                                )}
                                <div className={`relative flex-1 min-w-0 rounded-xl border-2 ${nodeColor} ${nodeBg} p-2.5 z-10 transition-all hover:shadow-md`}>
                                  {/* Priority badge */}
                                  <div className={`absolute -top-1.5 -start-1.5 w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-black text-white shadow-sm ${
                                    isPrimary ? 'bg-primary' : 'bg-slate-400 dark:bg-slate-600'
                                  }`}>{ci + 1}</div>

                                  {/* Node content */}
                                  <div className="flex items-start gap-2 ps-3">
                                    <span className="material-symbols-outlined text-[16px] text-slate-500 dark:text-white/50 mt-0.5 shrink-0">{providerIcon(c.provider)}</span>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <p className="text-[11px] font-bold text-slate-700 dark:text-white/75 truncate">{c.provider}</p>
                                        {isPrimary && (
                                          <span className="text-[7px] px-1 py-px rounded bg-primary/15 text-primary font-bold uppercase shrink-0">{dr.llmPrimary || 'Primary'}</span>
                                        )}
                                      </div>
                                      <p className="text-[9px] text-slate-400 dark:text-white/30 truncate mt-0.5">{c.model}</p>

                                      {/* Status row */}
                                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                                        {c.probeRes ? (
                                          <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold ${probeStatusBg(c.probeRes.status)} ${probeStatusColor(c.probeRes.status)}`}>
                                            {c.probeRes.status === 'ok' ? '● OK' : `✕ ${c.probeRes.status.toUpperCase()}`}
                                          </span>
                                        ) : c.authProfile ? (
                                          <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold ${authStatusBg(c.authProfile.authStatus)} ${authStatusColor(c.authProfile.authStatus)}`}>
                                            {c.authProfile.authStatus.toUpperCase()}
                                          </span>
                                        ) : (
                                          <span className="text-[8px] px-1.5 py-0.5 rounded font-bold bg-slate-100 dark:bg-white/5 text-slate-400 dark:text-white/30">
                                            {dr.llmUntested || 'UNTESTED'}
                                          </span>
                                        )}
                                        {c.probeRes?.latencyMs !== undefined && (
                                          <span className="text-[8px] text-slate-400 dark:text-white/25 tabular-nums">{formatMs(c.probeRes.latencyMs)}</span>
                                        )}
                                      </div>

                                      {/* Error detail */}
                                      {c.probeRes?.error && (
                                        <p className="text-[8px] text-red-500/80 dark:text-red-400/70 mt-1 line-clamp-1 break-all">{c.probeRes.error}</p>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </React.Fragment>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* === Errors Section === */}
      {activeSection === 'errors' && (
        <div className="space-y-3">
          {/* Error type distribution */}
          {errorStats && Object.keys(errorStats).length > 0 ? (
            <div className="rounded-2xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-3">
              <p className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-white/40 mb-2 flex items-center gap-1">
                <span className="material-symbols-outlined text-[12px]">error_outline</span>
                {dr.llmErrorDist || 'Error Distribution'}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {Object.entries(errorStats).map(([type, count]) => (
                  <div key={type} className={`rounded-lg p-2.5 ${probeStatusBg(type)}`}>
                    <p className={`text-[18px] font-black ${probeStatusColor(type)}`}>{count}</p>
                    <p className="text-[10px] text-slate-500 dark:text-white/40 uppercase font-bold">{type.replace(/_/g, ' ')}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-emerald-200/60 dark:border-emerald-500/10 bg-emerald-50/30 dark:bg-emerald-500/5 p-4 text-center">
              <span className="material-symbols-outlined text-[24px] text-emerald-500 mb-1">check_circle</span>
              <p className="text-[12px] font-bold text-emerald-700 dark:text-emerald-300">{dr.llmNoErrors || 'No errors detected'}</p>
              <p className="text-[10px] text-emerald-600/60 dark:text-emerald-400/50 mt-0.5">{dr.llmRunProbeHint || 'Run a probe to check provider health'}</p>
            </div>
          )}

          {/* Failed probe details */}
          {probeResults && probeResults.results.filter(r => r.status !== 'ok').length > 0 && (
            <div className="rounded-2xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-3">
              <p className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-white/40 mb-2">{dr.llmFailedProbes || 'Failed Probes'}</p>
              <div className="space-y-2">
                {probeResults.results.filter(r => r.status !== 'ok').map((r, i) => (
                  <div key={`err-${i}`} className="rounded-lg border border-red-200/50 dark:border-red-500/20 bg-red-50/50 dark:bg-red-500/5 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="material-symbols-outlined text-[14px] text-red-500">warning</span>
                        <p className="text-[11px] font-bold text-slate-700 dark:text-white/75 truncate">{r.provider}/{r.model}</p>
                      </div>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold shrink-0 ${probeStatusBg(r.status)} ${probeStatusColor(r.status)}`}>
                        {r.status.toUpperCase()}
                      </span>
                    </div>
                    {r.error && <p className="text-[10px] text-red-600/80 dark:text-red-300/70 mt-1 break-all">{r.error}</p>}
                    {r.latencyMs !== undefined && <p className="text-[9px] text-slate-400 dark:text-white/30 mt-1">{formatMs(r.latencyMs)}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* === Probe History === */}
      {showHistory && (
        <div className="rounded-2xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-white/40 flex items-center gap-1">
              <span className="material-symbols-outlined text-[12px]">history</span>
              {dr.llmProbeHistory || 'Probe History'}
            </p>
            {probeHistory.length > 0 && (
              <button onClick={() => { setProbeHistory([]); localStorage.removeItem(PROBE_HISTORY_KEY); }}
                className="text-[10px] text-red-500 hover:opacity-80">{dr.llmClearHistory || 'Clear'}</button>
            )}
          </div>
          {probeHistory.length === 0 ? (
            <p className="text-[11px] text-slate-400 dark:text-white/40 py-2 text-center">{dr.llmNoHistory || 'No probe history'}</p>
          ) : (
            <div className="space-y-1.5 max-h-[240px] overflow-y-auto">
              {probeHistory.map((h, i) => (
                <div key={`h-${i}`} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-slate-50 dark:bg-white/[0.02] text-[10px]">
                  <span className="text-slate-400 dark:text-white/35 shrink-0">{new Date(h.timestamp).toLocaleString()}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-emerald-600 dark:text-emerald-400 font-bold">{h.okCount} OK</span>
                    {h.failCount > 0 && <span className="text-red-500 font-bold">{h.failCount} FAIL</span>}
                    <span className="text-slate-400 dark:text-white/30">{formatMs(h.totalMs)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* Mini trend chart */}
          {probeHistory.length >= 2 && (
            <div className="mt-2 pt-2 border-t border-slate-200/60 dark:border-white/10">
              <p className="text-[9px] text-slate-400 dark:text-white/30 mb-1">{dr.llmSuccessRate || 'Success Rate Trend'}</p>
              <div className="h-12 rounded bg-slate-50 dark:bg-white/[0.02] border border-slate-200/70 dark:border-white/10 p-1 relative">
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full">
                  {(() => {
                    const data = [...probeHistory].reverse().slice(-20);
                    const points = data.map((h, i) => {
                      const total = h.okCount + h.failCount;
                      const rate = total > 0 ? (h.okCount / total) * 100 : 0;
                      const x = (i / Math.max(data.length - 1, 1)) * 100;
                      const y = 100 - rate;
                      return `${x},${y}`;
                    }).join(' ');
                    const areaPoints = `${points} 100,100 0,100`;
                    return (
                      <>
                        <polygon points={areaPoints} fill="#10b981" opacity="0.15" />
                        <polyline points={points} fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" />
                      </>
                    );
                  })()}
                </svg>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LlmHealthPanel;
