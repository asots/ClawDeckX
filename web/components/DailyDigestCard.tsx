import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { digestApi, type DigestConfigResponse, type DigestHistoryItem } from '../services/api';
import { useToast } from './Toast';
import CustomSelect from './CustomSelect';

interface DailyDigestCardProps {
  /** Names of currently active notify channels (used for the channel chooser). */
  activeChannels: string[];
  /** Localized strings; we accept the digest sub-tree of cm_set translations. */
  s: Record<string, string>;
  inputClassName: string;
  rowClassName: string;
}

const ALL_HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const ALL_MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

/**
 * "Daily Digest" configuration card. Lives inside the notify settings tab. The
 * card is fully self-contained: it owns its own load/save lifecycle and only
 * needs the active-channel list from the parent.
 */
const DailyDigestCard: React.FC<DailyDigestCardProps> = ({ activeChannels, s, inputClassName, rowClassName }) => {
  const { toast } = useToast();
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [sections, setSections] = useState<string[]>([]);
  const [timezone, setTimezone] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [history, setHistory] = useState<DigestHistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const enabled = cfg.notify_digest_enabled === 'true';
  const skipIfEmpty = cfg.notify_digest_skip_if_empty !== 'false';
  const time = cfg.notify_digest_time || '08:00';
  const [hh, mm] = time.split(':');

  const selectedSections = useMemo(() => {
    const raw = cfg.notify_digest_sections || '';
    return raw ? raw.split(',').map(x => x.trim()).filter(Boolean) : [];
  }, [cfg.notify_digest_sections]);

  const selectedChannels = useMemo(() => {
    const raw = cfg.notify_digest_channels || '';
    return raw ? raw.split(',').map(x => x.trim()).filter(Boolean) : [];
  }, [cfg.notify_digest_channels]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data: DigestConfigResponse = await digestApi.getConfig();
      setCfg(data.config || {});
      setSections((data.sections || []).map(x => x.id));
      setTimezone(data.timezone || '');
    } catch {
      // silent — handler reports its own errors
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const update = useCallback(async (patch: Record<string, string>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    setSaving(true);
    try {
      await digestApi.updateConfig(patch);
    } catch {
      toast('error', s.digestSaveFail || 'Save failed');
    }
    setSaving(false);
  }, [cfg, toast, s]);

  const setTime = useCallback((newH: string, newM: string) => {
    update({ notify_digest_time: `${newH}:${newM}` });
  }, [update]);

  const toggleSection = useCallback((id: string) => {
    const cur = new Set(selectedSections);
    if (cur.has(id)) cur.delete(id); else cur.add(id);
    // Preserve canonical order from the server's sections array.
    const next = sections.filter(x => cur.has(x));
    update({ notify_digest_sections: next.join(',') });
  }, [selectedSections, sections, update]);

  const toggleChannel = useCallback((ch: string) => {
    const cur = new Set(selectedChannels);
    if (cur.has(ch)) cur.delete(ch); else cur.add(ch);
    update({ notify_digest_channels: Array.from(cur).join(',') });
  }, [selectedChannels, update]);

  const handlePreview = useCallback(async () => {
    setPreviewing(true);
    try {
      const res = await digestApi.preview();
      setPreviewText(res.content || '(empty)');
    } catch {
      toast('error', s.digestPreviewFail || 'Preview failed');
    }
    setPreviewing(false);
  }, [toast, s]);

  const handleSendNow = useCallback(async () => {
    setTesting(true);
    try {
      const res = await digestApi.testSend();
      if (res.status === 'success' || res.status === 'partial' || res.status === 'empty') {
        toast('success', `${s.digestSent || 'Digest sent'} (${res.status})`);
      } else {
        toast('error', `${s.digestSendFail || 'Send failed'}: ${(res.errors || []).join(', ')}`);
      }
    } catch {
      toast('error', s.digestSendFail || 'Send failed');
    }
    setTesting(false);
  }, [toast, s]);

  const loadHistory = useCallback(async () => {
    try {
      const data = await digestApi.history(7);
      setHistory(data.list || []);
    } catch { /* noop */ }
  }, []);

  useEffect(() => {
    if (showHistory) loadHistory();
  }, [showHistory, loadHistory]);

  const sectionLabel = (id: string): string => s[`digestSection_${id}`] || id;

  if (loading) {
    return (
      <div className={rowClassName}>
        <div className="px-4 py-3 text-[12px] text-slate-400 dark:text-white/30">{s.digestLoading || 'Loading…'}</div>
      </div>
    );
  }

  return (
    <div className={rowClassName}>
      <div className="px-4 py-3">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="material-symbols-outlined text-[18px] text-violet-500">summarize</span>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-slate-700 dark:text-white/80">{s.digestTitle || 'Daily Digest'}</p>
              <p className="text-[10px] text-slate-400 dark:text-white/30 truncate">
                {s.digestDesc || 'A scheduled summary of yesterday’s activity.'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {saving && <span className="material-symbols-outlined text-[14px] text-slate-400 animate-spin">progress_activity</span>}
            <button
              onClick={() => update({ notify_digest_enabled: enabled ? 'false' : 'true' })}
              className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${enabled ? 'bg-primary' : 'bg-slate-300 dark:bg-white/15'}`}
              aria-label="toggle daily digest"
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : ''}`} />
            </button>
          </div>
        </div>

        {!enabled && (
          <p className="text-[11px] text-slate-400 dark:text-white/30">
            {s.digestDisabledHint || 'Turn on to schedule a daily summary delivered to your notification channels.'}
          </p>
        )}

        {enabled && (
          <div className="space-y-4">
            {/* Time */}
            <div>
              <label className="block text-[11px] font-medium text-slate-500 dark:text-white/40 mb-1.5">
                {s.digestTime || 'Send Time'}
                {timezone && <span className="ms-2 text-[10px] text-slate-400 dark:text-white/30">({timezone})</span>}
              </label>
              <div className="flex items-center gap-2">
                <CustomSelect
                  value={hh}
                  onChange={v => setTime(v, mm || '00')}
                  options={ALL_HOURS.map(h => ({ value: h, label: h }))}
                  className={`${inputClassName} !w-20 min-w-20`}
                />
                <span className="text-slate-400">:</span>
                <CustomSelect
                  value={ALL_MINUTES.includes(mm || '') ? mm : '00'}
                  onChange={v => setTime(hh || '08', v)}
                  options={ALL_MINUTES.map(m => ({ value: m, label: m }))}
                  className={`${inputClassName} !w-20 min-w-20`}
                />
                <span className="text-[10px] text-slate-400 dark:text-white/30">
                  {s.digestTimeHint || 'Local server time. Missed runs are caught up on next start.'}
                </span>
              </div>
            </div>

            {/* Skip if empty */}
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-slate-700 dark:text-white/70">
                  {s.digestSkipIfEmpty || 'Skip when nothing happened'}
                </p>
                <p className="text-[10px] text-slate-400 dark:text-white/30">
                  {s.digestSkipIfEmptyHint || 'Avoid noisy “quiet day” reports.'}
                </p>
              </div>
              <button
                onClick={() => update({ notify_digest_skip_if_empty: skipIfEmpty ? 'false' : 'true' })}
                className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${skipIfEmpty ? 'bg-primary' : 'bg-slate-300 dark:bg-white/15'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${skipIfEmpty ? 'translate-x-4' : ''}`} />
              </button>
            </div>

            {/* Channels */}
            {activeChannels.length > 1 && (
              <div>
                <p className="text-[11px] font-medium text-slate-500 dark:text-white/40 mb-1.5">
                  {s.digestChannels || 'Channels'}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {activeChannels.map(ch => {
                    const selected = selectedChannels.length === 0 || selectedChannels.includes(ch);
                    return (
                      <button
                        key={ch}
                        onClick={() => toggleChannel(ch)}
                        className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors ${
                          selected
                            ? 'bg-primary/10 text-primary dark:bg-primary/20'
                            : 'bg-slate-100 text-slate-400 dark:bg-white/5 dark:text-white/20'
                        }`}
                      >
                        {ch}
                      </button>
                    );
                  })}
                </div>
                {selectedChannels.length === 0 && (
                  <p className="mt-1 text-[10px] text-slate-400 dark:text-white/30 italic">
                    {s.digestAllChannels || 'all configured channels'}
                  </p>
                )}
              </div>
            )}

            {/* Sections */}
            <div>
              <p className="text-[11px] font-medium text-slate-500 dark:text-white/40 mb-1.5">
                {s.digestSections || 'Included Sections'}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {sections.map(id => {
                  const checked = selectedSections.length === 0 || selectedSections.includes(id);
                  return (
                    <label
                      key={id}
                      className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-slate-100 dark:hover:bg-white/5 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSection(id)}
                        className="w-3.5 h-3.5 accent-primary"
                      />
                      <span className="text-[11px] text-slate-600 dark:text-white/60 truncate">
                        {sectionLabel(id)}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                onClick={handlePreview}
                disabled={previewing}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 text-[11px] font-bold text-slate-600 dark:text-white/60 disabled:opacity-40 transition-colors"
              >
                <span className={`material-symbols-outlined text-[13px] ${previewing ? 'animate-spin' : ''}`}>
                  {previewing ? 'progress_activity' : 'preview'}
                </span>
                {s.digestPreview || 'Preview'}
              </button>
              <button
                onClick={handleSendNow}
                disabled={testing || activeChannels.length === 0}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary/10 text-primary hover:bg-primary/20 dark:bg-primary/20 dark:hover:bg-primary/30 text-[11px] font-bold disabled:opacity-40 transition-colors"
              >
                <span className={`material-symbols-outlined text-[13px] ${testing ? 'animate-spin' : ''}`}>
                  {testing ? 'progress_activity' : 'send'}
                </span>
                {s.digestSendNow || 'Send Now'}
              </button>
              <button
                onClick={() => setShowHistory(v => !v)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 text-[11px] font-bold text-slate-600 dark:text-white/60 transition-colors"
              >
                <span className="material-symbols-outlined text-[13px]">history</span>
                {showHistory ? (s.digestHideHistory || 'Hide History') : (s.digestHistory || 'History')}
              </button>
              {cfg.notify_digest_last_sent_date && (
                <span className="text-[10px] text-slate-400 dark:text-white/30 ms-auto">
                  {(s.digestLastSent || 'Last sent')}: {cfg.notify_digest_last_sent_date}
                </span>
              )}
            </div>

            {/* Preview body */}
            {previewText !== null && (
              <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-slate-200 dark:border-white/[0.06] bg-slate-50 dark:bg-white/[0.02] p-3 text-[11px] font-mono whitespace-pre-wrap text-slate-700 dark:text-white/70">
                {previewText}
              </pre>
            )}

            {/* History */}
            {showHistory && (
              <div className="mt-2 rounded-lg border border-slate-200 dark:border-white/[0.06] divide-y divide-slate-100 dark:divide-white/[0.06]">
                {history.length === 0 && (
                  <p className="px-3 py-2 text-[11px] text-slate-400 dark:text-white/30">
                    {s.digestNoHistory || 'No digests sent yet.'}
                  </p>
                )}
                {history.map(item => (
                  <details key={item.id} className="group">
                    <summary className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer hover:bg-slate-50 dark:hover:bg-white/[0.02]">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`inline-block w-1.5 h-1.5 rounded-full ${
                            item.status === 'success' ? 'bg-emerald-500'
                              : item.status === 'partial' ? 'bg-amber-500'
                              : item.status === 'empty' ? 'bg-slate-400'
                              : 'bg-red-500'
                          }`}
                        />
                        <span className="text-[11px] font-medium text-slate-700 dark:text-white/70 truncate">
                          {item.digest_date} · {item.status}
                        </span>
                      </div>
                      <span className="text-[10px] text-slate-400 dark:text-white/30">
                        {new Date(item.generated_at).toLocaleString()}
                      </span>
                    </summary>
                    <pre className="px-3 py-2 text-[10px] font-mono whitespace-pre-wrap text-slate-500 dark:text-white/50 bg-slate-50 dark:bg-white/[0.02]">
                      {item.content || '(empty)'}
                    </pre>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default DailyDigestCard;
