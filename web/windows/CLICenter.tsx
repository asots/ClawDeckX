import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Language } from '../types';
import { getTranslation } from '../locales';
import { useToast } from '../components/Toast';
import EmptyState from '../components/EmptyState';
import CustomSelect from '../components/CustomSelect';
import TranslateModelPicker from '../components/TranslateModelPicker';
import { copyToClipboard } from '../utils/clipboard';
import { skillTranslationApi } from '../services/api';

interface CLICenterProps { language: Language; }

interface CliItem {
  id: string;
  name: string;
  homepage: string;
  description: string | null;
  category: string;
  subcategory: string | null;
  tags: string[];
  language: string | null;
  license: string | null;
  stars: number | null;
  install: Record<string, string>;
  sources: string[];
  extra?: {
    entryPoint?: string | null;
    version?: string | null;
    requires?: string | null;
    packageManager?: string | null;
    npmPackage?: string | null;
    docsUrl?: string | null;
    skillMd?: string | null;
    uninstallCmd?: string | null;
    updateCmd?: string | null;
    agentHarnessRepo?: string | null;
    contributors?: { name?: string; url?: string }[];
  };
}

interface CliCatalog {
  schema: number;
  generatedAt: string;
  counts: { total: number; [k: string]: number };
  categories: string[];
  languages: string[];
  items: CliItem[];
}

const CLI_API_URL = 'https://market.clawdeckx.com/api/v1/cli-apps';
const CACHE_KEY = 'cli_catalog_cache_v1';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

type SortKey = 'stars' | 'name';

interface CacheEntry { ts: number; data: CliCatalog; }

function loadCache(): CliCatalog | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: CacheEntry = JSON.parse(raw);
    if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch { return null; }
}

function saveCache(data: CliCatalog) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch { /* quota exceeded — ignore */ }
}

function formatStars(n: number | null | undefined): string {
  if (!n || n <= 0) return '';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function buildInstallPrompt(item: CliItem, sk: any): string {
  const cli = sk.cli || {};
  const ex = item.extra || {};
  const lines: string[] = [
    cli.installPromptIntro || 'Please install the following CLI tool and demonstrate its basic usage:',
    '',
  ];
  lines.push(`- ${cli.installPromptName || 'Name'}: ${item.name}`);
  if (ex.version && ex.version !== 'latest') {
    lines.push(`- ${cli.installPromptVersion || 'Version'}: ${ex.version}`);
  }
  if (item.description) {
    lines.push(`- ${cli.installPromptDesc || 'Description'}: ${item.description}`);
  }
  if (item.category) {
    lines.push(`- ${cli.installPromptCategory || 'Category'}: ${item.category}`);
  }
  lines.push(`- ${cli.installPromptHomepage || 'Homepage'}: ${item.homepage}`);
  if (ex.docsUrl && ex.docsUrl !== item.homepage) {
    lines.push(`- ${cli.installPromptDocs || 'Docs'}: ${ex.docsUrl}`);
  }
  if (ex.skillMd && ex.skillMd !== ex.docsUrl && ex.skillMd !== item.homepage) {
    lines.push(`- ${cli.installPromptSkill || 'Usage guide'}: ${ex.skillMd}`);
  }
  if (ex.requires) {
    lines.push(`- ${cli.installPromptRequires || 'Prerequisites'}: ${ex.requires}`);
  }
  if (ex.entryPoint) {
    lines.push(`- ${cli.installPromptEntryPoint || 'CLI command'}: \`${ex.entryPoint}\``);
  }
  if (ex.packageManager) {
    lines.push(`- ${cli.installPromptPackageManager || 'Recommended package manager'}: ${ex.packageManager}`);
  }
  const installCmds = Object.entries(item.install || {});
  if (installCmds.length > 0) {
    lines.push('', `${cli.installPromptInstallCmd || 'Suggested install commands'}:`);
    for (const [mgr, cmd] of installCmds) lines.push(`  - ${mgr}: \`${cmd}\``);
  }
  if (ex.uninstallCmd) {
    lines.push('', `${cli.installPromptUninstallCmd || 'Uninstall'}: \`${ex.uninstallCmd}\``);
  }
  if (ex.updateCmd) {
    lines.push(`${cli.installPromptUpdateCmd || 'Update'}: \`${ex.updateCmd}\``);
  }
  if (ex.contributors && ex.contributors.length > 0) {
    const names = ex.contributors
      .map(c => c?.name)
      .filter((n): n is string => !!n)
      .join(', ');
    if (names) lines.push('', `${cli.installPromptMaintainers || 'Maintainers'}: ${names}`);
  }
  return lines.join('\n');
}

const CLIToolCard: React.FC<{
  item: CliItem;
  sk: any;
  onCopyPrompt: (item: CliItem) => void;
  translation?: { name: string; description: string; status: string };
  showTranslated: boolean;
}> = React.memo(({ item, sk, onCopyPrompt, translation, showTranslated }) => {
  const cli = sk.cli || {};
  const stars = formatStars(item.stars);
  const useTranslated = showTranslated && translation?.status === 'cached';
  const displayName = useTranslated && translation?.name ? translation.name : item.name;
  const displayDesc = useTranslated && translation?.description ? translation.description : (item.description || '');
  return (
    <div
      className="theme-panel rounded-2xl p-4 hover:border-primary/30 transition-all group shadow-sm flex flex-col sci-card"
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' }}
    >
      <div className="flex items-start gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/15 to-purple-500/15 flex items-center justify-center shrink-0 border border-slate-200/50 dark:border-white/5">
          <span className="material-symbols-outlined text-[20px] text-primary">terminal</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <h4 className="font-bold text-[13px] text-slate-800 dark:text-white truncate">{displayName}</h4>
            {item.language && (
              <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full theme-field theme-text-secondary font-mono">
                {item.language}
              </span>
            )}
            {translation?.status === 'translating' && (
              <span className="text-[9px] text-primary animate-pulse shrink-0">{sk.translating || 'Translating...'}</span>
            )}
          </div>
          <span className="text-[11px] theme-text-muted truncate block">
            {item.category}{item.subcategory ? ` · ${item.subcategory}` : ''}
          </span>
        </div>
      </div>

      {displayDesc && (
        <p className="text-[11px] theme-text-muted leading-relaxed mb-3 line-clamp-3">
          {displayDesc}
        </p>
      )}

      {item.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {item.tags.slice(0, 4).map(tag => (
            <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded-full theme-field theme-text-secondary">{tag}</span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 mt-auto text-[10px] text-slate-400 dark:text-white/35 overflow-hidden whitespace-nowrap">
        {stars && (
          <span className="flex items-center gap-0.5 shrink-0">
            <span className="material-symbols-outlined text-[10px]">star</span>{stars}
          </span>
        )}
        {item.license && (
          <span className="flex items-center gap-0.5 shrink-0">
            <span className="material-symbols-outlined text-[10px]">balance</span>
            <span className="truncate max-w-[60px]">{item.license}</span>
          </span>
        )}
        <a
          href={item.homepage}
          target="_blank"
          rel="noopener noreferrer"
          className="ms-auto flex items-center text-primary/60 hover:text-primary transition-colors"
          title={cli.openHomepage || 'Open homepage'}
          onClick={e => e.stopPropagation()}
        >
          <span className="material-symbols-outlined text-[12px]">open_in_new</span>
        </a>
      </div>

      <div className="flex items-center gap-1 mt-auto pt-2 border-t border-slate-100 dark:border-white/5">
        <button
          onClick={() => onCopyPrompt(item)}
          className="flex-1 h-7 text-[10px] font-bold rounded-lg transition-colors flex items-center justify-center gap-1 bg-primary/15 text-primary hover:bg-primary/25"
        >
          <span className="material-symbols-outlined text-[12px]">content_copy</span>
          <span className="truncate">{cli.copyPrompt || 'Copy Prompt'}</span>
        </button>
      </div>
    </div>
  );
});
CLIToolCard.displayName = 'CLIToolCard';

const PAGE_SIZE = 60;

const CLICenter: React.FC<CLICenterProps> = ({ language }) => {
  const t = useMemo(() => getTranslation(language), [language]);
  const sk = (t as any).sk || {};
  const cli = sk.cli || {};
  const { toast } = useToast();

  const [catalog, setCatalog] = useState<CliCatalog | null>(() => loadCache());
  const [loading, setLoading] = useState(!loadCache());
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [lang, setLang] = useState<string>('all');
  const [sortBy, setSortBy] = useState<SortKey>('stars');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // ── Auto-translate (mirrors Skills/ClawHub pattern) ──────────────────
  const [autoTranslate, setAutoTranslate] = useState(() => {
    const saved = localStorage.getItem('skills-auto-translate');
    return saved === null ? true : saved === 'true';
  });
  const [translateEngine, setTranslateEngine] = useState<'' | 'free'>(() => {
    const saved = localStorage.getItem('skills-translate-engine');
    return saved === 'free' ? 'free' : '';
  });
  const [translations, setTranslations] = useState<Record<string, { name: string; description: string; status: string; engine?: string }>>({});
  const translationsRef = useRef(translations);
  translationsRef.current = translations;

  useEffect(() => { localStorage.setItem('skills-auto-translate', String(autoTranslate)); }, [autoTranslate]);
  useEffect(() => { localStorage.setItem('skills-translate-engine', translateEngine); }, [translateEngine]);

  const fetchCatalog = useCallback(async (force = false) => {
    if (!force) {
      const cached = loadCache();
      if (cached) {
        setCatalog(cached);
        setLoading(false);
      }
    }
    setError(null);
    if (!catalog || force) setLoading(true);
    try {
      const res = await fetch(CLI_API_URL, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: CliCatalog = await res.json();
      setCatalog(data);
      saveCache(data);
    } catch (err: any) {
      setError(err?.message || 'fetch failed');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { fetchCatalog(false); }, [fetchCatalog]);

  // Reset pagination on filter change
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [search, category, lang, sortBy]);

  // ── Translation batch logic (mirrors Skills.tsx translateBatch) ──────
  const translateBatch = useCallback(async (
    targetLang: string,
    items: { skill_key: string; name: string; description: string }[],
    engine?: string,
  ) => {
    if (targetLang === 'en' || items.length === 0) return;
    const current = translationsRef.current;
    const itemsToCheck = items.filter(item => {
      const existing = current[item.skill_key];
      if (!existing || existing.status !== 'cached') return true;
      if (engine && existing.engine && existing.engine !== engine) return true;
      return false;
    });
    if (itemsToCheck.length === 0) return;

    try {
      const allKeys = itemsToCheck.map(s => s.skill_key);
      const cached = await skillTranslationApi.get(targetLang, allKeys) as any;
      const entries: any[] = Array.isArray(cached) ? cached : (cached?.data || []);
      const cachedMap: Record<string, boolean> = {};
      if (entries.length > 0) {
        setTranslations(prev => {
          const next = { ...prev };
          for (const e of entries) {
            if (e.status === 'cached') {
              if (engine && e.engine && e.engine !== engine) continue;
              next[e.skill_key] = { name: e.name, description: e.description, status: 'cached', engine: e.engine || '' };
              cachedMap[e.skill_key] = true;
            }
          }
          return next;
        });
      }
      const needTranslate = itemsToCheck.filter(s => !cachedMap[s.skill_key] && (s.name || s.description));
      if (needTranslate.length === 0) return;

      setTranslations(prev => {
        const next = { ...prev };
        for (const s of needTranslate) {
          if (!next[s.skill_key] || next[s.skill_key].status !== 'cached') {
            next[s.skill_key] = { name: '', description: '', status: 'translating' };
          }
        }
        return next;
      });

      await skillTranslationApi.translate(targetLang, needTranslate, engine || undefined);

      const pendingKeys = needTranslate.map(s => s.skill_key);
      let retries = 0;
      const poll = setInterval(async () => {
        retries++;
        if (retries > 30) { clearInterval(poll); return; }
        try {
          const res = await skillTranslationApi.get(targetLang, pendingKeys) as any;
          const list: any[] = Array.isArray(res) ? res : (res?.data || []);
          let allDone = true;
          setTranslations(prev => {
            const next = { ...prev };
            for (const e of list) {
              if (e.status === 'cached') {
                next[e.skill_key] = { name: e.name, description: e.description, status: 'cached', engine: e.engine || '' };
              } else {
                allDone = false;
              }
            }
            return next;
          });
          if (allDone) clearInterval(poll);
        } catch { /* ignore */ }
      }, 10000);
    } catch { /* ignore */ }
  }, []);

  const filtered = useMemo(() => {
    if (!catalog) return [] as CliItem[];
    const q = search.trim().toLowerCase();
    let list = catalog.items;
    if (category !== 'all') list = list.filter(i => i.category === category);
    if (lang !== 'all') list = list.filter(i => i.language === lang);
    if (q) {
      list = list.filter(i =>
        i.name.toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q) ||
        (i.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }
    if (sortBy === 'name') {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    }
    // catalog is already pre-sorted by stars desc — no resort needed for 'stars'
    return list;
  }, [catalog, search, category, lang, sortBy]);

  // Infinite scroll
  useEffect(() => {
    if (!sentinelRef.current) return;
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) {
          setVisibleCount(c => Math.min(c + PAGE_SIZE, filtered.length));
        }
      }
    }, { rootMargin: '400px' });
    io.observe(sentinelRef.current);
    return () => io.disconnect();
  }, [filtered.length]);

  const visibleItems = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);

  // Trigger translation only for currently-visible items (avoid translating 2k+ rows)
  useEffect(() => {
    if (!autoTranslate || language === 'en' || visibleItems.length === 0) return;
    const items = visibleItems.map(item => ({
      skill_key: `cli:${item.id}`,
      name: item.name || '',
      description: item.description || '',
    }));
    const timer = setTimeout(() => {
      const batchSize = 15;
      (async () => {
        for (let i = 0; i < items.length; i += batchSize) {
          const batch = items.slice(i, i + batchSize);
          if (batch.length > 0) {
            await translateBatch(language, batch, translateEngine || undefined);
          }
        }
      })();
    }, 500);
    return () => clearTimeout(timer);
  }, [autoTranslate, language, visibleItems, translateBatch, translateEngine]);

  const categoryOptions = useMemo(() => {
    if (!catalog) return [{ value: 'all', label: cli.filterAll || 'All' }];
    return [
      { value: 'all', label: cli.filterAll || 'All' },
      ...catalog.categories.map(c => ({ value: c, label: c })),
    ];
  }, [catalog, cli.filterAll]);

  const languageOptions = useMemo(() => {
    if (!catalog) return [{ value: 'all', label: cli.filterAll || 'All' }];
    return [
      { value: 'all', label: cli.filterAll || 'All' },
      ...catalog.languages.map(l => ({ value: l, label: l })),
    ];
  }, [catalog, cli.filterAll]);

  const handleCopyPrompt = useCallback(async (item: CliItem) => {
    const prompt = buildInstallPrompt(item, sk);
    try {
      await copyToClipboard(prompt);
      toast('success', cli.copyPromptCopied || 'Copied');
    } catch {
      toast('error', sk.copyFailed || 'Copy failed');
    }
  }, [sk, cli.copyPromptCopied, toast]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-[#0f1115]">
      {/* Toolbar */}
      <div className="p-3 flex items-center gap-2 border-b border-slate-200 dark:border-white/5 theme-panel shrink-0">
        <div className="relative flex-1 min-w-0">
          <span className="material-symbols-outlined absolute start-3 top-1/2 -translate-y-1/2 theme-text-muted text-[16px]">search</span>
          <input
            className="w-full h-9 ps-9 pe-4 theme-field rounded-lg text-xs placeholder:text-slate-400 dark:placeholder:text-white/20 focus:ring-1 focus:ring-primary outline-none sci-input"
            placeholder={cli.search || 'Search CLI tools...'}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="flex bg-slate-200 dark:bg-black/40 p-0.5 rounded-lg shadow-inner shrink-0">
          {([
            ['stars', cli.sortStars || 'Stars'],
            ['name', cli.sortName || 'Name'],
          ] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setSortBy(val as SortKey)}
              className={`px-2 py-1 rounded text-[10px] font-bold transition-all whitespace-nowrap ${
                sortBy === val
                  ? 'bg-white dark:bg-primary shadow-sm text-slate-900 dark:text-white'
                  : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <CustomSelect
          value={category}
          onChange={v => setCategory(v)}
          options={categoryOptions}
          className="h-9 px-2 theme-field rounded-lg text-[10px] font-bold theme-text-secondary outline-none shrink-0 min-w-[120px]"
        />
        <CustomSelect
          value={lang}
          onChange={v => setLang(v)}
          options={languageOptions}
          className="h-9 px-2 theme-field rounded-lg text-[10px] font-bold theme-text-secondary outline-none shrink-0 min-w-[100px]"
        />

        {/* Auto-translate controls (mirrors Skills tab) */}
        {language !== 'en' && (
          <>
            <button
              onClick={() => setAutoTranslate(!autoTranslate)}
              className={`h-9 px-3 flex items-center gap-1.5 border rounded-lg text-[11px] font-bold transition-all shrink-0 ${
                autoTranslate
                  ? 'bg-primary/10 dark:bg-primary/20 border-primary/30 text-primary hover:bg-primary/20'
                  : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20'
              }`}
              title={autoTranslate ? sk.autoTranslateOn : sk.autoTranslateOff}
            >
              <span className="material-symbols-outlined text-[16px]">{autoTranslate ? 'translate' : 'g_translate'}</span>
              {sk.autoTranslate || 'Auto Translate'}
            </button>
            {autoTranslate && (
              <button
                onClick={() => { setTranslateEngine(prev => prev === 'free' ? '' : 'free'); setTranslations({}); }}
                className={`h-9 w-9 flex items-center justify-center border rounded-lg shrink-0 transition-all ${
                  translateEngine === 'free'
                    ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-500/20'
                    : 'bg-violet-50 dark:bg-violet-500/10 border-violet-200 dark:border-violet-500/30 text-violet-600 dark:text-violet-400 hover:bg-violet-100 dark:hover:bg-violet-500/20'
                }`}
                title={translateEngine === 'free' ? 'Google Translate (Free)' : 'LLM (AI)'}
              >
                <span className="material-symbols-outlined text-[16px]">{translateEngine === 'free' ? 'g_translate' : 'smart_toy'}</span>
              </button>
            )}
            {autoTranslate && translateEngine !== 'free' && <TranslateModelPicker sk={sk} compact />}
            {/* Progress indicator */}
            {autoTranslate && (() => {
              const total = visibleItems.length;
              const cliEntries = Object.entries(translations).filter(([k]) => k.startsWith('cli:'));
              const translating = cliEntries.filter(([, t]) => t.status === 'translating').length;
              const cached = cliEntries.filter(([, t]) => t.status === 'cached').length;
              if (translating > 0) {
                return (
                  <span
                    className="h-9 px-2 flex items-center gap-1 text-[10px] text-primary bg-primary/5 border border-primary/20 rounded-lg shrink-0"
                    title={`${sk.translating || 'Translating'}: ${translating}/${total}`}
                  >
                    <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                    {translating}/{total}
                  </span>
                );
              }
              if (cached > 0 && cached < total) {
                return (
                  <span
                    className="h-9 px-2 flex items-center gap-1 text-[10px] theme-text-secondary theme-field rounded-lg shrink-0"
                    title={`${sk.translated || 'Translated'}: ${cached}/${total}`}
                  >
                    <span className="material-symbols-outlined text-[12px]">{translateEngine === 'free' ? 'g_translate' : 'smart_toy'}</span>
                    {cached}/{total}
                  </span>
                );
              }
              return null;
            })()}
          </>
        )}

        <button
          onClick={() => fetchCatalog(true)}
          disabled={loading}
          className="h-9 w-9 flex items-center justify-center theme-field hover:bg-slate-200 dark:hover:bg-white/10 rounded-lg shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
          title={sk.refresh || 'Refresh'}
        >
          <span className={`material-symbols-outlined text-[16px] theme-text-secondary ${loading ? 'animate-spin' : ''}`}>
            {loading ? 'progress_activity' : 'refresh'}
          </span>
        </button>
      </div>

      {/* Meta strip */}
      {catalog && (
        <div className="px-4 py-1.5 border-b border-slate-200/50 dark:border-white/5 theme-panel flex items-center gap-3 text-[10px] theme-text-muted shrink-0">
          <span>
            {(cli.totalCount || '{count} tools').replace('{count}', String(filtered.length))}
            {filtered.length !== catalog.items.length && ` / ${catalog.items.length}`}
          </span>
          <span className="opacity-60">·</span>
          <span>
            {(cli.generatedAt || 'Updated {date}').replace(
              '{date}',
              new Date(catalog.generatedAt).toLocaleDateString()
            )}
          </span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar neon-scrollbar">
        <div className="max-w-6xl mx-auto">
          {loading && !catalog && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="theme-panel rounded-2xl p-4 animate-pulse">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-10 h-10 rounded-xl bg-slate-200 dark:bg-white/10" />
                    <div className="flex-1">
                      <div className="h-4 w-24 bg-slate-200 dark:bg-white/10 rounded mb-1" />
                      <div className="h-3 w-16 bg-slate-100 dark:bg-white/5 rounded" />
                    </div>
                  </div>
                  <div className="h-3 w-full bg-slate-100 dark:bg-white/5 rounded mb-1" />
                  <div className="h-3 w-2/3 bg-slate-100 dark:bg-white/5 rounded" />
                </div>
              ))}
            </div>
          )}

          {error && !loading && !catalog && (
            <EmptyState
              icon="error"
              title={cli.loadFailed || 'Failed to load CLI catalog'}
              description={error}
              action={{ label: cli.retry || 'Retry', icon: 'refresh', onClick: () => fetchCatalog(true) }}
            />
          )}

          {catalog && filtered.length === 0 && !loading && (
            <EmptyState icon="search_off" title={cli.empty || 'No matching tools'} />
          )}

          {visibleItems.length > 0 && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {visibleItems.map(item => (
                  <CLIToolCard
                    key={item.id}
                    item={item}
                    sk={sk}
                    onCopyPrompt={handleCopyPrompt}
                    translation={translations[`cli:${item.id}`]}
                    showTranslated={autoTranslate && language !== 'en'}
                  />
                ))}
              </div>
              {visibleCount < filtered.length && (
                <div ref={sentinelRef} className="h-10 flex items-center justify-center mt-4">
                  <span className="material-symbols-outlined text-[18px] animate-spin theme-text-muted">progress_activity</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default CLICenter;
