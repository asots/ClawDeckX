import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useConfirm } from '../../components/ConfirmDialog';
import { gwApi } from '../../services/api';

interface DreamingPhaseStatus {
  enabled: boolean;
  cron: string;
  managedCronPresent: boolean;
  nextRunAtMs?: number;
  lookbackDays?: number;
  limit?: number;
  minScore?: number;
  minRecallCount?: number;
  minUniqueQueries?: number;
  recencyHalfLifeDays?: number;
  maxAgeDays?: number;
  minPatternStrength?: number;
}

interface DreamingStatus {
  enabled: boolean;
  timezone?: string;
  verboseLogging: boolean;
  storageMode: 'inline' | 'separate' | 'both';
  separateReports: boolean;
  shortTermCount: number;
  recallSignalCount: number;
  dailySignalCount: number;
  totalSignalCount: number;
  phaseSignalCount: number;
  lightPhaseHitCount: number;
  remPhaseHitCount: number;
  promotedTotal: number;
  promotedToday: number;
  storePath?: string;
  phaseSignalPath?: string;
  storeError?: string;
  phaseSignalError?: string;
  phases: {
    light: DreamingPhaseStatus;
    deep: DreamingPhaseStatus;
    rem: DreamingPhaseStatus;
  };
}

interface DreamsPanelProps {
  gw: Record<string, any>;
  toast: (type: 'success' | 'error' | 'warning', msg: string) => void;
}

function fmtNextRun(ms: number | undefined, tz?: string): string {
  if (!ms || !Number.isFinite(ms)) return '--';
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      ...(tz ? { timeZone: tz } : {}),
    });
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function fmtTimeUntil(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const diff = ms - Date.now();
  if (diff <= 0) return 'now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

const DreamsPanel: React.FC<DreamsPanelProps> = ({ gw, toast }) => {
  const dr = gw.dreams || {};
  const { confirm } = useConfirm();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<DreamingStatus | null>(null);
  const [toggling, setToggling] = useState(false);
  const [diaryLoading, setDiaryLoading] = useState(false);
  const [diaryContent, setDiaryContent] = useState<string | null>(null);
  const [diaryPath, setDiaryPath] = useState<string | null>(null);
  const [diaryOpen, setDiaryOpen] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [resettingDiary, setResettingDiary] = useState(false);
  const [resettingGrounded, setResettingGrounded] = useState(false);
  const [remLoading, setRemLoading] = useState(false);
  const [remContent, setRemContent] = useState<string | null>(null);
  const [remPath, setRemPath] = useState<string | null>(null);
  const [remOpen, setRemOpen] = useState(false);
  const mountedRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res: any = await gwApi.memoryStatus();
      if (!mountedRef.current) return;
      const d = res?.dreaming;
      if (d && typeof d === 'object') {
        setStatus(d as DreamingStatus);
        setError(null);
      } else {
        setStatus(null);
        setError(dr.unavailable || 'Dreaming data unavailable');
      }
    } catch (err: any) {
      if (!mountedRef.current) return;
      setError(err?.message || 'Failed to load dreaming status');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [dr]);

  useEffect(() => {
    mountedRef.current = true;
    fetchStatus();
    const timer = setInterval(fetchStatus, 30_000);
    return () => { mountedRef.current = false; clearInterval(timer); };
  }, [fetchStatus]);

  const toggleDreaming = useCallback(async () => {
    if (!status || toggling) return;
    const next = !status.enabled;

    const ok = await confirm({
      title: next
        ? (dr.enableConfirmTitle || dr.enableTitle || 'Enable Dreaming')
        : (dr.disableConfirmTitle || dr.disableTitle || 'Disable Dreaming'),
      message: next
        ? (dr.enableConfirmMessage || dr.enableConfirm || 'Enable the memory dreaming system now? This will start automatic memory consolidation tasks.')
        : (dr.disableConfirmMessage || dr.disableConfirm || 'Disable the memory dreaming system now? This will stop automatic memory consolidation tasks.'),
      confirmText: next
        ? (dr.enableConfirmAction || dr.enableAction || 'Enable')
        : (dr.disableConfirmAction || dr.disableAction || 'Disable'),
      danger: !next,
    });
    if (!ok) return;

    setToggling(true);
    try {
      await gwApi.configSafePatch({
        plugins: { entries: { 'memory-core': { config: { dreaming: { enabled: next } } } } },
      });
      toast('success', next ? (dr.enabled || 'Dreaming enabled') : (dr.disabled || 'Dreaming disabled'));
      await fetchStatus();
    } catch (err: any) {
      toast('error', err?.message || 'Failed to toggle dreaming');
    } finally {
      if (mountedRef.current) setToggling(false);
    }
  }, [status, toggling, toast, dr, fetchStatus, confirm]);

  const loadDiary = useCallback(async () => {
    setDiaryLoading(true);
    try {
      const res: any = await gwApi.proxy('doctor.memory.dreamDiary', {});
      if (mountedRef.current) {
        setDiaryPath(res?.path || 'DREAMS.md');
        setDiaryContent(res?.found ? (res?.content || '') : null);
        setDiaryOpen(true);
      }
    } catch (err: any) {
      toast('error', err?.message || 'Failed to load dream diary');
    } finally {
      if (mountedRef.current) setDiaryLoading(false);
    }
  }, [toast]);

  const handleBackfill = useCallback(async () => {
    if (backfilling) return;
    const ok = await confirm({
      title: dr.backfillConfirmTitle || 'Backfill Dream Diary',
      message: dr.backfillConfirmMessage || 'Replay historical daily notes into Dreams and persistent memory? This may take a while.',
      confirmText: dr.backfillConfirmAction || 'Backfill',
      danger: false,
    });
    if (!ok) return;
    setBackfilling(true);
    try {
      const res: any = await gwApi.memoryBackfillDreamDiary();
      toast('success', res?.message || (dr.backfillOk || 'Dream diary backfill started'));
      await fetchStatus();
    } catch (err: any) {
      toast('error', err?.message || (dr.backfillFailed || 'Failed to start backfill'));
    } finally {
      if (mountedRef.current) setBackfilling(false);
    }
  }, [backfilling, confirm, dr, toast, fetchStatus]);

  const handleResetDiary = useCallback(async () => {
    if (resettingDiary) return;
    const ok = await confirm({
      title: dr.resetDiaryConfirmTitle || 'Reset Dream Diary',
      message: dr.resetDiaryConfirmMessage || 'This will clear all dream diary entries. Promoted long-term memories will not be affected. Continue?',
      confirmText: dr.resetDiaryConfirmAction || 'Reset',
      danger: true,
    });
    if (!ok) return;
    setResettingDiary(true);
    try {
      const res: any = await gwApi.memoryResetDreamDiary();
      toast('success', res?.message || (dr.resetDiaryOk || 'Dream diary reset'));
      setDiaryContent(null);
      setDiaryOpen(false);
      await fetchStatus();
    } catch (err: any) {
      toast('error', err?.message || (dr.resetDiaryFailed || 'Failed to reset dream diary'));
    } finally {
      if (mountedRef.current) setResettingDiary(false);
    }
  }, [resettingDiary, confirm, dr, toast, fetchStatus]);

  const loadRemHarness = useCallback(async () => {
    setRemLoading(true);
    try {
      const res: any = await gwApi.memoryRemHarness();
      if (mountedRef.current) {
        setRemPath(res?.path || null);
        setRemContent(res?.found ? (res?.content || '') : null);
        setRemOpen(true);
      }
    } catch (err: any) {
      toast('error', err?.message || 'Failed to load REM harness');
    } finally {
      if (mountedRef.current) setRemLoading(false);
    }
  }, [toast]);

  const handleResetGrounded = useCallback(async () => {
    if (resettingGrounded) return;
    const ok = await confirm({
      title: dr.resetGroundedConfirmTitle || 'Reset Grounded Short-term',
      message: dr.resetGroundedConfirmMessage || 'This will clear all grounded short-term memory entries. Promoted long-term memories will not be affected. Continue?',
      confirmText: dr.resetGroundedConfirmAction || 'Reset',
      danger: true,
    });
    if (!ok) return;
    setResettingGrounded(true);
    try {
      const res: any = await gwApi.memoryResetGroundedShortTerm();
      toast('success', res?.message || (dr.resetGroundedOk || 'Grounded short-term memory reset'));
      await fetchStatus();
    } catch (err: any) {
      toast('error', err?.message || (dr.resetGroundedFailed || 'Failed to reset grounded short-term memory'));
    } finally {
      if (mountedRef.current) setResettingGrounded(false);
    }
  }, [resettingGrounded, confirm, dr, toast, fetchStatus]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <span className="material-symbols-outlined text-[24px] text-primary animate-spin">progress_activity</span>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 gap-3">
        <span className="material-symbols-outlined text-[32px] text-slate-300 dark:text-white/15">nights_stay</span>
        <p className="text-[11px] theme-text-muted">{error}</p>
        <button onClick={() => { setLoading(true); fetchStatus(); }}
          className="text-[10px] text-primary font-bold hover:underline">{gw.refresh || 'Refresh'}</button>
      </div>
    );
  }

  if (!status) return null;

  const phases = [
    { id: 'light' as const, icon: 'light_mode', color: 'text-amber-500', bg: 'bg-amber-500/10', label: dr.phaseLight || 'Light' },
    { id: 'deep' as const, icon: 'bedtime', color: 'text-indigo-500', bg: 'bg-indigo-500/10', label: dr.phaseDeep || 'Deep' },
    { id: 'rem' as const, icon: 'auto_awesome', color: 'text-purple-500', bg: 'bg-purple-500/10', label: dr.phaseRem || 'REM' },
  ];

  const nextRunMs = Math.min(
    ...[status.phases.light.nextRunAtMs, status.phases.deep.nextRunAtMs, status.phases.rem.nextRunAtMs]
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v)),
    Infinity,
  );

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar neon-scrollbar p-4 md:p-5 space-y-4">
      {/* Header: Global Toggle */}
      <div className="rounded-xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-4 sci-card">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${status.enabled ? 'bg-indigo-500/10 border-indigo-500/20 text-indigo-500' : 'bg-slate-100 dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-400'}`}>
            <span className="material-symbols-outlined text-[22px]">nights_stay</span>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[12px] font-bold text-slate-700 dark:text-white/80">{dr.title || 'Memory Dreaming'}</h3>
            <p className="text-[10px] text-slate-400 dark:text-white/35">
              {dr.desc || 'Automatic memory consolidation — promotes short-term recalls into durable long-term memory'}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={status.enabled}
            disabled={toggling}
            onClick={toggleDreaming}
            className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${status.enabled ? 'bg-indigo-500' : 'bg-slate-300 dark:bg-white/15'} ${toggling ? 'opacity-50' : ''}`}
          >
            <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transform transition duration-200 ease-in-out ${status.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        {status.timezone && (
          <div className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-white/30">
            <span className="material-symbols-outlined text-[12px]">schedule</span>
            {dr.timezone || 'Timezone'}: {status.timezone}
          </div>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { icon: 'neurology', label: dr.shortTerm || 'Short-term', value: status.shortTermCount, color: '#3b82f6', gradient: 'from-blue-50/50 dark:from-blue-500/[0.06]' },
          { icon: 'psychology', label: dr.promoted || 'Promoted', value: status.promotedTotal, color: '#8b5cf6', gradient: 'from-violet-50/50 dark:from-violet-500/[0.06]' },
          { icon: 'trending_up', label: dr.today || 'Today', value: `+${status.promotedToday}`, color: '#10b981', gradient: 'from-emerald-50/50 dark:from-emerald-500/[0.06]' },
          { icon: 'timer', label: dr.nextRun || 'Next Run', value: nextRunMs < Infinity ? fmtTimeUntil(nextRunMs) : '--', color: '#f59e0b', gradient: 'from-amber-50/50 dark:from-amber-500/[0.06]' },
        ].map(s => (
          <div key={s.label} className={`rounded-xl border border-slate-200/60 dark:border-white/[0.06] bg-gradient-to-br ${s.gradient} to-white dark:to-transparent p-3 sci-card`}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="material-symbols-outlined text-[14px]" style={{ color: s.color }}>{s.icon}</span>
              <span className="text-[10px] font-bold text-slate-400 dark:text-white/40 uppercase">{s.label}</span>
            </div>
            <p className="text-lg font-black tabular-nums text-slate-800 dark:text-white">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Signal Stats */}
      <div className="rounded-xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-4 sci-card">
        <h4 className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[13px] text-primary">analytics</span>
          {dr.signals || 'Signal Statistics'}
        </h4>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {[
            { label: dr.recallSignals || 'Recall Signals', value: status.recallSignalCount },
            { label: dr.dailySignals || 'Daily Signals', value: status.dailySignalCount },
            { label: dr.totalSignals || 'Total Signals', value: status.totalSignalCount },
            { label: dr.lightHits || 'Light Hits', value: status.lightPhaseHitCount },
            { label: dr.remHits || 'REM Hits', value: status.remPhaseHitCount },
          ].map(s => (
            <div key={s.label} className="rounded-lg bg-slate-50 dark:bg-white/[0.02] border border-slate-100 dark:border-white/5 px-3 py-2">
              <p className="text-[9px] font-bold text-slate-400 dark:text-white/30 uppercase">{s.label}</p>
              <p className="text-sm font-black tabular-nums text-slate-700 dark:text-white/70 mt-0.5">{s.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Phase Details */}
      <div className="rounded-xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-4 sci-card">
        <h4 className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[13px] text-primary">view_timeline</span>
          {dr.phases || 'Dreaming Phases'}
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {phases.map(phase => {
            const p = status.phases[phase.id];
            return (
              <div key={phase.id} className={`rounded-xl border p-3 transition-colors ${p.enabled ? `${phase.bg} border-current/10` : 'bg-slate-50 dark:bg-white/[0.02] border-slate-100 dark:border-white/5'}`}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`material-symbols-outlined text-[16px] ${p.enabled ? phase.color : 'text-slate-400 dark:text-white/30'}`}>{phase.icon}</span>
                  <span className={`text-[11px] font-bold uppercase ${p.enabled ? phase.color : 'text-slate-400 dark:text-white/30'}`}>{phase.label}</span>
                  <span className={`ms-auto text-[9px] px-1.5 py-0.5 rounded-full font-bold ${p.enabled ? 'bg-mac-green/15 text-mac-green' : 'bg-slate-200 dark:bg-white/10 text-slate-400 dark:text-white/30'}`}>
                    {p.enabled ? (dr.on || 'ON') : (dr.off || 'OFF')}
                  </span>
                </div>
                <div className="space-y-1 text-[10px]">
                  <div className="flex justify-between">
                    <span className="text-slate-400 dark:text-white/30">{dr.cron || 'Cron'}</span>
                    <span className="font-mono font-bold text-slate-600 dark:text-white/60">{p.cron || '--'}</span>
                  </div>
                  {p.nextRunAtMs && (
                    <div className="flex justify-between">
                      <span className="text-slate-400 dark:text-white/30">{dr.nextRun || 'Next Run'}</span>
                      <span className="font-bold text-slate-600 dark:text-white/60">{fmtNextRun(p.nextRunAtMs, status.timezone)}</span>
                    </div>
                  )}
                  {p.limit != null && (
                    <div className="flex justify-between">
                      <span className="text-slate-400 dark:text-white/30">{dr.limit || 'Limit'}</span>
                      <span className="font-bold text-slate-600 dark:text-white/60">{p.limit}</span>
                    </div>
                  )}
                  {p.lookbackDays != null && (
                    <div className="flex justify-between">
                      <span className="text-slate-400 dark:text-white/30">{dr.lookback || 'Lookback'}</span>
                      <span className="font-bold text-slate-600 dark:text-white/60">{p.lookbackDays}d</span>
                    </div>
                  )}
                  {phase.id === 'deep' && p.minScore != null && (
                    <div className="flex justify-between">
                      <span className="text-slate-400 dark:text-white/30">{dr.minScore || 'Min Score'}</span>
                      <span className="font-bold text-slate-600 dark:text-white/60">{p.minScore}</span>
                    </div>
                  )}
                  {phase.id === 'rem' && p.minPatternStrength != null && (
                    <div className="flex justify-between">
                      <span className="text-slate-400 dark:text-white/30">{dr.minPattern || 'Min Pattern'}</span>
                      <span className="font-bold text-slate-600 dark:text-white/60">{p.minPatternStrength}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Dream Diary */}
      <div className="rounded-xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-4 sci-card">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[16px] text-amber-500">auto_stories</span>
          <h4 className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-wider flex-1">
            {dr.diary || 'Dream Diary'}
          </h4>
          <button
            onClick={() => diaryOpen ? setDiaryOpen(false) : loadDiary()}
            disabled={diaryLoading}
            className="text-[10px] text-primary font-bold hover:underline flex items-center gap-0.5"
          >
            {diaryLoading && <span className="material-symbols-outlined text-[12px] animate-spin">progress_activity</span>}
            {diaryOpen ? (dr.hide || 'Hide') : (dr.view || 'View')}
          </button>
        </div>
        {diaryOpen && (
          <div className="mt-3">
            {diaryContent === null ? (
              <p className="text-[10px] text-slate-400 dark:text-white/30 italic">
                {dr.diaryEmpty || 'No dream diary found. Dreams will appear here after the first dreaming sweep.'}
              </p>
            ) : (
              <>
                {diaryPath && <p className="text-[9px] font-mono text-slate-400 dark:text-white/25 mb-2">{diaryPath}</p>}
                <pre className="text-[10px] text-slate-600 dark:text-white/60 font-mono whitespace-pre-wrap max-h-80 overflow-y-auto custom-scrollbar neon-scrollbar bg-slate-50 dark:bg-white/[0.02] rounded-lg p-3 border border-slate-100 dark:border-white/5">
                  {diaryContent || (dr.diaryEmptyContent || '(empty)')}
                </pre>
              </>
            )}
          </div>
        )}
      </div>

      {/* Actions: Backfill / Reset */}
      <div className="rounded-xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-4 sci-card">
        <h4 className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[13px] text-primary">build</span>
          {dr.actions || 'Actions'}
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {/* Backfill Dream Diary */}
          <button
            onClick={handleBackfill}
            disabled={backfilling}
            className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.02] hover:bg-indigo-50 dark:hover:bg-indigo-500/5 hover:border-indigo-300 dark:hover:border-indigo-500/20 px-3 py-2.5 transition-colors text-start disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[16px] text-indigo-500">
              {backfilling ? 'progress_activity' : 'history'}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-slate-700 dark:text-white/70">{dr.backfillAction || 'Backfill Diary'}</p>
              <p className="text-[9px] text-slate-400 dark:text-white/30">{dr.backfillDesc || 'Replay historical notes into Dreams'}</p>
            </div>
          </button>
          {/* Reset Dream Diary */}
          <button
            onClick={handleResetDiary}
            disabled={resettingDiary}
            className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.02] hover:bg-red-50 dark:hover:bg-red-500/5 hover:border-red-300 dark:hover:border-red-500/20 px-3 py-2.5 transition-colors text-start disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[16px] text-red-500">
              {resettingDiary ? 'progress_activity' : 'delete_sweep'}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-slate-700 dark:text-white/70">{dr.resetDiaryAction || 'Reset Diary'}</p>
              <p className="text-[9px] text-slate-400 dark:text-white/30">{dr.resetDiaryDesc || 'Clear all dream diary entries'}</p>
            </div>
          </button>
          {/* Preview REM Harness */}
          <button
            onClick={() => remOpen ? setRemOpen(false) : loadRemHarness()}
            disabled={remLoading}
            className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.02] hover:bg-purple-50 dark:hover:bg-purple-500/5 hover:border-purple-300 dark:hover:border-purple-500/20 px-3 py-2.5 transition-colors text-start disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[16px] text-purple-500">
              {remLoading ? 'progress_activity' : 'auto_awesome'}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-slate-700 dark:text-white/70">{dr.remPreview || 'Preview REM'}</p>
              <p className="text-[9px] text-slate-400 dark:text-white/30">{dr.remPreviewDesc || 'Preview REM dreaming output'}</p>
            </div>
          </button>
          {/* Reset Grounded Short-term */}
          <button
            onClick={handleResetGrounded}
            disabled={resettingGrounded}
            className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.02] hover:bg-red-50 dark:hover:bg-red-500/5 hover:border-red-300 dark:hover:border-red-500/20 px-3 py-2.5 transition-colors text-start disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[16px] text-red-500">
              {resettingGrounded ? 'progress_activity' : 'restart_alt'}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-slate-700 dark:text-white/70">{dr.resetGroundedAction || 'Reset Grounded'}</p>
              <p className="text-[9px] text-slate-400 dark:text-white/30">{dr.resetGroundedDesc || 'Clear grounded short-term memory'}</p>
            </div>
          </button>
        </div>
      </div>

      {/* REM Harness Preview */}
      {remOpen && (
        <div className="rounded-xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-4 sci-card">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px] text-purple-500">auto_awesome</span>
            <h4 className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-wider flex-1">
              {dr.remPreview || 'REM Harness Preview'}
            </h4>
            <button onClick={() => setRemOpen(false)} className="text-[10px] text-primary font-bold hover:underline">{dr.hide || 'Hide'}</button>
          </div>
          <div className="mt-3">
            {remContent === null ? (
              <p className="text-[10px] text-slate-400 dark:text-white/30 italic">
                {dr.remEmpty || 'No REM harness output available.'}
              </p>
            ) : (
              <>
                {remPath && <p className="text-[9px] font-mono text-slate-400 dark:text-white/25 mb-2">{remPath}</p>}
                <pre className="text-[10px] text-slate-600 dark:text-white/60 font-mono whitespace-pre-wrap max-h-80 overflow-y-auto custom-scrollbar neon-scrollbar bg-slate-50 dark:bg-white/[0.02] rounded-lg p-3 border border-slate-100 dark:border-white/5">
                  {remContent || '(empty)'}
                </pre>
              </>
            )}
          </div>
        </div>
      )}

      {/* Storage Info */}
      {(status.storePath || status.storeError || status.phaseSignalError) && (
        <div className="rounded-xl border border-slate-200/60 dark:border-white/[0.06] bg-white dark:bg-white/[0.02] p-4 sci-card">
          <h4 className="text-[10px] font-bold text-slate-500 dark:text-white/40 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[13px] text-slate-400">folder</span>
            {dr.storage || 'Storage'}
          </h4>
          <div className="space-y-1 text-[10px]">
            {status.storePath && (
              <div className="flex gap-2">
                <span className="text-slate-400 dark:text-white/30 shrink-0">{dr.storePath || 'Store'}</span>
                <span className="font-mono text-slate-600 dark:text-white/50 truncate">{status.storePath}</span>
              </div>
            )}
            <div className="flex gap-2">
              <span className="text-slate-400 dark:text-white/30 shrink-0">{dr.storageMode || 'Mode'}</span>
              <span className="font-bold text-slate-600 dark:text-white/60">{status.storageMode}</span>
            </div>
            {status.storeError && (
              <p className="text-[10px] text-red-500 font-bold mt-1">{status.storeError}</p>
            )}
            {status.phaseSignalError && (
              <p className="text-[10px] text-red-500 font-bold mt-1">{status.phaseSignalError}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default DreamsPanel;
