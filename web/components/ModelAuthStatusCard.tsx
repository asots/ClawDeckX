import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gwApi, type ModelAuthStatusResult, type ModelAuthStatusProvider, type ModelAuthProviderStatus } from '../services/api';
import { Language } from '../types';
import { getTranslation } from '../locales';

interface Props {
  language: Language;
  /** Whether the gateway is connected — skip fetching when not connected. */
  gwConnected?: boolean;
  /** Optional: open a specific window when the card header is clicked (defaults to 'gateway'). */
  onOpenTarget?: () => void;
}

const REFRESH_INTERVAL_MS = 60_000;

const statusColor: Record<ModelAuthProviderStatus, { bg: string; text: string; dot: string; label: keyof ReturnType<typeof getMas> }> = {
  ok:       { bg: 'bg-emerald-500/10 dark:bg-emerald-500/10', text: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500', label: 'statusOk' },
  expiring: { bg: 'bg-amber-500/10 dark:bg-amber-500/10',     text: 'text-amber-600 dark:text-amber-400',     dot: 'bg-amber-500',   label: 'statusExpiring' },
  expired:  { bg: 'bg-red-500/10 dark:bg-red-500/10',         text: 'text-red-600 dark:text-red-400',         dot: 'bg-red-500',     label: 'statusExpired' },
  missing:  { bg: 'bg-red-500/10 dark:bg-red-500/10',         text: 'text-red-600 dark:text-red-400',         dot: 'bg-red-500',     label: 'statusMissing' },
  static:   { bg: 'bg-slate-500/10 dark:bg-white/5',          text: 'text-slate-500 dark:text-white/60',      dot: 'bg-slate-400',   label: 'statusStatic' },
};

function getMas(language: Language): Record<string, string> {
  const t = getTranslation(language) as any;
  return (t?.d?.mas || {}) as Record<string, string>;
}

function severityOrder(s: ModelAuthProviderStatus): number {
  return ({ missing: 0, expired: 1, expiring: 2, ok: 3, static: 4 } as const)[s];
}

const ModelAuthStatusCard: React.FC<Props> = ({ language, gwConnected = true, onOpenTarget }) => {
  const mas = useMemo(() => getMas(language), [language]);
  const [result, setResult] = useState<ModelAuthStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const abortRef = useRef(false);

  const fetchStatus = useCallback(async (refresh = false) => {
    if (!gwConnected) return;
    setLoading(true);
    setError(null);
    try {
      const r = await gwApi.modelsAuthStatus(refresh ? { refresh: true } : undefined);
      if (abortRef.current) return;
      setResult(r);
    } catch (e: any) {
      if (abortRef.current) return;
      setError(e?.message || String(e));
    } finally {
      if (!abortRef.current) setLoading(false);
    }
  }, [gwConnected]);

  useEffect(() => {
    abortRef.current = false;
    void fetchStatus(false);
    const timer = setInterval(() => { void fetchStatus(false); }, REFRESH_INTERVAL_MS);
    return () => { abortRef.current = true; clearInterval(timer); };
  }, [fetchStatus]);

  const providers = useMemo<ModelAuthStatusProvider[]>(() => {
    if (!result?.providers) return [];
    return [...result.providers].sort((a, b) => {
      const sa = severityOrder(a.status);
      const sb = severityOrder(b.status);
      if (sa !== sb) return sa - sb;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [result]);

  const summary = useMemo(() => {
    const counts = { ok: 0, expiring: 0, expired: 0, missing: 0, static: 0 } as Record<ModelAuthProviderStatus, number>;
    for (const p of providers) counts[p.status] += 1;
    return counts;
  }, [providers]);

  const hasAttention = summary.expired > 0 || summary.missing > 0 || summary.expiring > 0;

  if (!gwConnected) return null;

  return (
    <div className={`rounded-2xl border p-4 sci-card ${hasAttention ? 'border-amber-200/60 dark:border-amber-500/20 bg-gradient-to-r from-amber-50/40 to-white dark:from-amber-500/[0.04] dark:to-transparent' : 'border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02]'}`}>
      <div className="flex items-center gap-2.5 mb-3">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center border ${hasAttention ? 'bg-amber-500/15 border-amber-500/20' : 'bg-gradient-to-br from-cyan-500/15 to-blue-600/15 border-cyan-500/10'}`}>
          <span className={`material-symbols-outlined text-[18px] ${hasAttention ? 'text-amber-500' : 'text-cyan-500'}`}>verified_user</span>
        </div>
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={onOpenTarget}
            className="text-[12px] font-bold text-slate-700 dark:text-white/80 hover:text-primary transition-colors text-start"
            title={mas.openAuth || 'Open auth settings'}
          >
            {mas.title || 'Model Auth Status'}
          </button>
          {result && result.ts > 0 && (
            <p className="text-[10px] text-slate-400 dark:text-white/40">
              {(mas.providersCount || '{{n}} providers').replace('{{n}}', String(providers.length))}
              {' · '}
              {new Date(result.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void fetchStatus(true)}
          disabled={loading}
          className="text-[10px] px-2 py-1 rounded-md border border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-white/5 disabled:opacity-40 flex items-center gap-1"
          title={mas.refresh || 'Refresh'}
        >
          <span className={`material-symbols-outlined text-[14px] ${loading ? 'animate-spin' : ''}`}>refresh</span>
          <span className="hidden sm:inline">{mas.refresh || 'Refresh'}</span>
        </button>
      </div>

      {error && (
        <div className="text-[11px] text-red-600 dark:text-red-400 bg-red-500/5 rounded-lg px-3 py-2 mb-2">
          {(mas.loadError || 'Failed to load auth status') + ': ' + error}
        </div>
      )}

      {!error && providers.length === 0 && !loading && (
        <div className="text-[11px] text-slate-500 dark:text-white/50 py-2">
          {mas.empty || 'No refreshable credentials configured.'}
        </div>
      )}

      {providers.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
            {(['missing', 'expired', 'expiring', 'ok', 'static'] as ModelAuthProviderStatus[]).map(s => (
              <div key={s} className={`rounded-lg px-2.5 py-2 text-center ${statusColor[s].bg}`}>
                <p className={`text-[15px] font-black tabular-nums ${statusColor[s].text}`}>{summary[s]}</p>
                <p className="text-[9px] uppercase tracking-wider text-slate-500 dark:text-white/50 mt-0.5">
                  {mas[statusColor[s].label] || s}
                </p>
              </div>
            ))}
          </div>

          <div className="space-y-1.5">
            {(expanded ? providers : providers.slice(0, 5)).map(p => (
              <div key={p.provider} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 bg-slate-50/50 dark:bg-white/[0.02]">
                <span className={`w-2 h-2 rounded-full ${statusColor[p.status].dot}`} />
                <span className="text-[11px] font-medium text-slate-700 dark:text-white/80 flex-1 min-w-0 truncate">{p.displayName}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${statusColor[p.status].bg} ${statusColor[p.status].text} font-bold uppercase tracking-wider`}>
                  {mas[statusColor[p.status].label] || p.status}
                </span>
                {p.expiry?.label && (
                  <span className="text-[10px] text-slate-400 dark:text-white/40 font-mono tabular-nums" title={mas.expiresIn || 'Expires in'}>
                    {p.expiry.label}
                  </span>
                )}
              </div>
            ))}
          </div>

          {providers.length > 5 && (
            <button
              type="button"
              onClick={() => setExpanded(v => !v)}
              className="text-[10px] text-primary hover:underline mt-2"
            >
              {expanded
                ? (mas.collapse || 'Show less')
                : (mas.showAll || 'Show all ({{n}})').replace('{{n}}', String(providers.length))}
            </button>
          )}
        </>
      )}
    </div>
  );
};

export default ModelAuthStatusCard;
