import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Language } from '../types';
import { getTranslation } from '../locales';
import { skillHubApi, skillHubRemoteApi, SkillHubSkill, SkillHubPageResponse } from '../services/api';
import { useToast } from '../components/Toast';
import EmptyState from '../components/EmptyState';
import CustomSelect from '../components/CustomSelect';
import { copyToClipboard } from '../utils/clipboard';
import { idbGet, idbSet } from '../utils/idbCache';
import { pickLocalizedField } from '../utils/localizedContent';

interface SkillHubProps { language: Language; }

const BANNER_DISMISSED_KEY = 'skillhub_banner_dismissed';
const TOP_CACHE_KEY = 'skillhub_top_cache';
const TOP_CACHE_EXPIRY_HOURS = 6;
const TOP_CACHE_VERSION = 1;
const REMOTE_SKILLHUB_CATEGORIES = [
  'ai-intelligence',
  'developer-tools',
  'productivity',
  'data-analysis',
  'content-creation',
  'security-compliance',
  'communication-collaboration',
] as const;

const REMOTE_SKILLHUB_CATEGORY_LABELS: Record<(typeof REMOTE_SKILLHUB_CATEGORIES)[number], { zh: string; en: string }> = {
  'ai-intelligence': { zh: 'AI 智能', en: 'AI Intelligence' },
  'developer-tools': { zh: '开发工具', en: 'Developer Tools' },
  'productivity': { zh: '效率提升', en: 'Productivity' },
  'data-analysis': { zh: '数据分析', en: 'Data Analysis' },
  'content-creation': { zh: '内容创作', en: 'Content Creation' },
  'security-compliance': { zh: '安全合规', en: 'Security & Compliance' },
  'communication-collaboration': { zh: '通讯协作', en: 'Communication & Collaboration' },
};

// 可展开描述组件（与 Skills.tsx 中的 ExpandableDesc 保持一致）
const ExpandableDesc: React.FC<{ text: string; moreLabel: string }> = ({ text, moreLabel }) => {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  const needsExpand = text.length > 80;
  return (
    <div className="mb-3">
      <p className={`text-[11px] text-slate-500 dark:text-white/40 leading-relaxed ${needsExpand ? 'cursor-pointer' : ''} ${expanded ? '' : 'line-clamp-2'}`}
        onClick={(e) => { e.stopPropagation(); needsExpand && setExpanded(!expanded); }}>
        {text}
      </p>
      {needsExpand && !expanded && (
        <button onClick={(e) => { e.stopPropagation(); setExpanded(true); }} className="text-[11px] text-primary/70 hover:text-primary font-medium mt-0.5">...{moreLabel}</button>
      )}
    </div>
  );
};

interface TopCacheData {
  skills: SkillHubSkill[];
  timestamp: number;
  version: number;
}

// 技能详情弹窗组件
const SkillDetailModal: React.FC<{
  skill: SkillHubSkill | null;
  onClose: () => void;
  onCopyPrompt: (skill: SkillHubSkill) => void;
  onCopyCLI: (skill: SkillHubSkill) => void;
  language: Language;
  sk: any;
}> = ({ skill, onClose, onCopyPrompt, onCopyCLI, language, sk }) => {
  if (!skill) return null;

  const desc = pickLocalizedField(language, skill, { base: 'description', zh: 'description_zh' });
  const updatedDate = new Date(skill.updated_at).toLocaleDateString();

  const promptCode = (sk.skillHubInstallPrompt || 'Please first check whether the SkillHub store is installed. If it is not installed, install SkillHub following {url}, then install the {slug} skill.\n\nIf SkillHub is already installed, install the {slug} skill directly.')
    .replace(/\{url\}/g, 'https://skillhub-1251783334.cos.ap-guangzhou.myqcloud.com/install/skillhub.md')
    .replace(/\{slug\}/g, skill.slug);

  const cliCode = `skillhub install ${skill.slug}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-[#1a1c22] rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start gap-4 p-6 border-b border-slate-200 dark:border-white/10">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/15 to-purple-500/15 flex items-center justify-center shrink-0 border border-slate-200/50 dark:border-white/5">
            <span className="text-3xl">📦</span>
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-bold text-slate-800 dark:text-white mb-1">{skill.name}</h2>
            <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-white/50">
              <span className="font-mono">v{skill.version}</span>
              <span>•</span>
              <span>{sk.lastUpdated || 'Updated'}: {updatedDate}</span>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-white/10 transition-colors shrink-0">
            <span className="material-symbols-outlined text-slate-500">close</span>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar neon-scrollbar">
          {/* Description */}
          <div className="mb-6">
            <h3 className="text-sm font-bold text-slate-600 dark:text-white/60 uppercase tracking-wider mb-2">{sk.description || 'Description'}</h3>
            <p className="text-sm text-slate-700 dark:text-white/70 leading-relaxed whitespace-pre-wrap">{desc}</p>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-slate-50 dark:bg-white/5 rounded-xl p-3 border border-slate-200 dark:border-white/10">
              <div className="flex items-center gap-2 text-amber-500 mb-1">
                <span className="material-symbols-outlined text-[16px]">star</span>
                <span className="text-xs font-bold">{sk.stars || 'Stars'}</span>
              </div>
              <div className="text-lg font-bold text-slate-800 dark:text-white">{skill.stars}</div>
            </div>
            <div className="bg-slate-50 dark:bg-white/5 rounded-xl p-3 border border-slate-200 dark:border-white/10">
              <div className="flex items-center gap-2 text-blue-500 mb-1">
                <span className="material-symbols-outlined text-[16px]">download</span>
                <span className="text-xs font-bold">{sk.downloads || 'Downloads'}</span>
              </div>
              <div className="text-lg font-bold text-slate-800 dark:text-white">
                {skill.downloads >= 1000 ? `${(skill.downloads / 1000).toFixed(1)}k` : skill.downloads}
              </div>
            </div>
            <div className="bg-slate-50 dark:bg-white/5 rounded-xl p-3 border border-slate-200 dark:border-white/10">
              <div className="flex items-center gap-2 text-green-500 mb-1">
                <span className="material-symbols-outlined text-[16px]">check_circle</span>
                <span className="text-xs font-bold">{sk.installs || 'Installs'}</span>
              </div>
              <div className="text-lg font-bold text-slate-800 dark:text-white">{skill.installs}</div>
            </div>
          </div>

          {/* Tags */}
          {skill.tags.length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-bold text-slate-600 dark:text-white/60 uppercase tracking-wider mb-2">{sk.tags || 'Tags'}</h3>
              <div className="flex flex-wrap gap-2">
                {skill.tags.map(tag => (
                  <span key={tag} className="px-3 py-1 rounded-full bg-slate-100 dark:bg-white/10 text-slate-600 dark:text-white/60 text-xs font-medium border border-slate-200 dark:border-white/10">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Installation Methods */}
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-slate-600 dark:text-white/60 uppercase tracking-wider">{sk.installMethods || 'Installation Methods'}</h3>
            
            {/* Method 1: Prompt */}
            <div className="bg-slate-50 dark:bg-white/5 rounded-xl p-4 border border-slate-200 dark:border-white/10">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-bold text-slate-700 dark:text-white/80">{sk.installViaPrompt || 'Install via AI Assistant'}</h4>
                <button onClick={() => onCopyPrompt(skill)} className="h-7 px-3 bg-primary/15 text-primary hover:bg-primary/25 text-xs font-bold rounded-lg transition-colors flex items-center gap-1">
                  <span className="material-symbols-outlined text-[12px]">content_copy</span>
                  {sk.copyPrompt || 'Copy'}
                </button>
              </div>
              <pre className="text-[11px] text-slate-600 dark:text-white/60 bg-white dark:bg-black/20 p-3 rounded-lg overflow-x-auto border border-slate-200 dark:border-white/10 font-mono whitespace-pre-wrap break-words">
                {promptCode}
              </pre>
            </div>

            {/* Method 2: CLI */}
            <div className="bg-slate-50 dark:bg-white/5 rounded-xl p-4 border border-slate-200 dark:border-white/10">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-bold text-slate-700 dark:text-white/80">{sk.installViaCLI || 'Install via CLI'}</h4>
                <button onClick={() => onCopyCLI(skill)} className="h-7 px-3 bg-slate-100 dark:bg-white/10 text-slate-600 dark:text-white/60 hover:bg-slate-200 dark:hover:bg-white/20 text-xs font-bold rounded-lg transition-colors flex items-center gap-1">
                  <span className="material-symbols-outlined text-[12px]">content_copy</span>
                  {sk.copyCLI || 'Copy'}
                </button>
              </div>
              <pre className="text-[11px] text-slate-600 dark:text-white/60 bg-white dark:bg-black/20 p-3 rounded-lg overflow-x-auto border border-slate-200 dark:border-white/10 font-mono">
                {cliCode}
              </pre>
            </div>
          </div>

          {/* Homepage Link */}
          {skill.homepage && (
            <div className="mt-6">
              <a href={skill.homepage} target="_blank" rel="noopener noreferrer" 
                className="inline-flex items-center gap-2 text-sm text-primary hover:text-primary/80 font-medium transition-colors">
                <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                {sk.viewHomepage || 'View Homepage'}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// CLI 安装 Banner 组件
const CLIBanner: React.FC<{
  status: 'checking' | 'not-installed' | 'installing' | 'installed' | 'error' | 'dismissed';
  onInstall: () => void;
  onDismiss: () => void;
  error?: string;
  sk: any;
}> = ({ status, onInstall, onDismiss, error, sk }) => {
  if (status === 'installed' || status === 'dismissed' || status === 'checking') return null;

  if (status === 'installing') {
    return (
      <div className="mb-4 p-4 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded-xl">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-blue-500 animate-spin">progress_activity</span>
          <div className="flex-1">
            <p className="text-sm font-bold text-blue-700 dark:text-blue-400">{sk.installing || 'Installing SkillHub CLI...'}</p>
            <p className="text-xs text-blue-600 dark:text-blue-300 mt-1">{sk.pleaseWait || 'Please wait, this may take a few minutes...'}</p>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="mb-4 p-4 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-xl">
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined text-red-500 text-xl">error</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-red-700 dark:text-red-400">{sk.installFailed || 'Installation Failed'}</p>
            <p className="text-xs text-red-600 dark:text-red-300 mt-1 break-words">{error}</p>
            <div className="flex gap-2 mt-3">
              <button onClick={onInstall} className="h-7 px-3 bg-red-500 text-white text-xs font-bold rounded-lg hover:bg-red-600">
                {sk.retry || 'Retry'}
              </button>
              <button onClick={onDismiss} className="h-7 px-3 bg-white dark:bg-white/10 text-red-700 dark:text-red-400 text-xs font-bold rounded-lg border border-red-300 dark:border-red-500/30 hover:bg-red-50 dark:hover:bg-white/20">
                {sk.close || 'Close'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // not-installed
  return (
    <div className="mb-4 p-4 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl">
      <div className="flex items-start gap-3">
        <span className="text-2xl">💡</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-amber-800 dark:text-amber-300">{sk.skillHubBannerNotInstalled || 'SkillHub CLI Not Installed'}</p>
          <p className="text-xs text-amber-700 dark:text-amber-200 mt-1">{sk.skillHubBannerDesc || 'Install SkillHub CLI to use skill installation features'}</p>
          <div className="flex gap-2 mt-3">
            <button onClick={onInstall} className="h-7 px-4 bg-primary text-white text-xs font-bold rounded-lg hover:bg-primary/90 flex items-center gap-1">
              {sk.oneClickInstall || 'One-Click Install'}
            </button>
            <button onClick={onDismiss} className="h-7 px-3 text-amber-600 dark:text-amber-400 text-xs font-bold hover:underline">
              {sk.close || 'Close'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const SkillHub: React.FC<SkillHubProps> = ({ language }) => {
  const t = useMemo(() => getTranslation(language), [language]);
  const sk = (t as any).sk || {};
  const skRef = useRef(sk);
  skRef.current = sk;
  const { toast } = useToast();

  const [cliStatus, setCLIStatus] = useState<'checking' | 'not-installed' | 'installing' | 'installed' | 'error' | 'dismissed'>('checking');
  const [cliError, setCLIError] = useState<string>('');

  const [skills, setSkills] = useState<SkillHubSkill[]>([]);
  const [totalSkills, setTotalSkills] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'score' | 'downloads' | 'stars' | 'installs' | 'name'>('score');
  const [showFeatured, setShowFeatured] = useState(false);
  const [topSkills, setTopSkills] = useState<SkillHubSkill[]>([]);
  const [topLoading, setTopLoading] = useState(false);
  const [detailSkill, setDetailSkill] = useState<SkillHubSkill | null>(null);
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [confirmSkill, setConfirmSkill] = useState<SkillHubSkill | null>(null);
  const [installedSkillNames, setInstalledSkillNames] = useState<Set<string>>(new Set());

  const searchRef = useRef<HTMLInputElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadTopCache = useCallback(async (): Promise<TopCacheData | null> => {
    try {
      const cached = await idbGet<TopCacheData>(TOP_CACHE_KEY);
      if (!cached || cached.version !== TOP_CACHE_VERSION) return null;
      const age = Date.now() - cached.timestamp;
      const maxAge = TOP_CACHE_EXPIRY_HOURS * 60 * 60 * 1000;
      if (age > maxAge) return null;
      return cached;
    } catch {
      return null;
    }
  }, []);

  const saveTopCache = useCallback((skills: SkillHubSkill[]) => {
    const cacheData: TopCacheData = {
      skills,
      timestamp: Date.now(),
      version: TOP_CACHE_VERSION,
    };
    idbSet(TOP_CACHE_KEY, cacheData);
  }, []);

  // Apply paginated response to state
  const applyPageResponse = useCallback((res: SkillHubPageResponse, append: boolean) => {
    if (append) {
      setSkills(prev => [...prev, ...res.skills]);
    } else {
      setSkills(res.skills);
    }
    setTotalSkills(res.total);
    setHasMore(res.hasMore);
    setCurrentPage(res.page);
  }, []);

  // Map UI sort to remote API sortBy parameter
  const mapSortToRemote = (sort: string): { sortBy: 'score' | 'downloads' | 'stars' | 'installs' | 'name'; order: 'asc' | 'desc' } => {
    if (sort === 'score') return { sortBy: 'score', order: 'desc' };
    if (sort === 'downloads') return { sortBy: 'downloads', order: 'desc' };
    if (sort === 'stars') return { sortBy: 'stars', order: 'desc' };
    if (sort === 'installs') return { sortBy: 'installs', order: 'desc' };
    if (sort === 'name') return { sortBy: 'name', order: 'asc' };
    return { sortBy: 'score', order: 'desc' };
  };

  // Fetch page from remote proxy API
  const fetchPage = useCallback(async (page = 1, append = false) => {
    if (page === 1 && !append) { setLoading(true); setLoadError(false); }
    else setLoadingMore(true);

    try {
      const { sortBy: remoteSortBy, order } = mapSortToRemote(sortBy);
      const res = await skillHubRemoteApi.listSkills(page, 24, remoteSortBy, order, category);
      applyPageResponse(res, append);
      setLoading(false);
      setLoadingMore(false);
      return;
    } catch (err) {
      console.warn('[SkillHub] Remote API failed:', err);
      setLoadingMore(false);
      setLoading(false);
      setLoadError(true);
      toast('error', `${skRef.current.loadFailed || 'Load failed'}: ${(err as any)?.message || ''}`);
    }
  }, [sortBy, category, applyPageResponse, toast]);

  // Server-side search via remote proxy API
  const fetchSearch = useCallback(async (q: string) => {
    setLoading(true);
    setLoadError(false);

    try {
      const res = await skillHubRemoteApi.searchSkills(q, 24, category);
      setSkills(res.skills);
      setTotalSkills(res.total);
      setHasMore(false);
      setLoading(false);
      return;
    } catch (err) {
      console.warn('[SkillHub] Remote search failed:', err);
      setLoading(false);
      setLoadError(true);
    }
  }, [category]);

  const fetchData = useCallback(async () => {
    await fetchPage(1);
  }, [fetchPage]);

  const fetchTopSkills = useCallback(async (force = false) => {
    if (!force) {
      const cached = await loadTopCache();
      if (cached && cached.skills.length > 0) {
        setTopSkills(cached.skills);
      }
    }

    setTopLoading(true);
    try {
      const remoteTopSkills = await skillHubRemoteApi.topSkills();
      setTopSkills(remoteTopSkills);
      saveTopCache(remoteTopSkills);
    } catch (err) {
      if (force || topSkills.length === 0) {
        const cached = await loadTopCache();
        if (cached?.skills?.length) {
          setTopSkills(cached.skills);
        }
      }
      console.debug('Failed to fetch top skills:', err);
    } finally {
      setTopLoading(false);
    }
  }, [loadTopCache, saveTopCache, topSkills.length]);

  // Check CLI status
  const CLI_INSTALLED_KEY = 'skillhub_cli_installed';
  const checkCLI = useCallback(async () => {
    try {
      const status = await skillHubApi.cliStatus();
      if (status.installed) {
        setCLIStatus('installed');
        localStorage.setItem(CLI_INSTALLED_KEY, 'true');
      } else {
        setCLIStatus('not-installed');
        localStorage.removeItem(CLI_INSTALLED_KEY);
      }
    } catch {
      setCLIStatus('not-installed');
      localStorage.removeItem(CLI_INSTALLED_KEY);
    }
  }, []);

  // Install CLI
  const handleInstallCLI = useCallback(async () => {
    setCLIStatus('installing');
    setCLIError('');
    try {
      const result = await skillHubApi.install();
      if (result.success) {
        toast('success', skRef.current.installSuccess || 'SkillHub CLI installed successfully!');
        setCLIStatus('installed');
        localStorage.setItem('skillhub_cli_installed', 'true');
      } else {
        setCLIError(result.output || 'Unknown error');
        setCLIStatus('error');
      }
    } catch (err: any) {
      const errorMsg = err?.message || 'Installation failed';
      let localizedError = errorMsg;
      if (errorMsg.includes('PERMISSION_DENIED')) {
        localizedError = skRef.current.permissionDenied || 'Permission denied. Please run with sudo.';
      } else if (errorMsg.includes('PLATFORM_NOT_SUPPORTED')) {
        localizedError = skRef.current.platformNotSupported || 'Platform not supported. Please install manually.';
      }
      setCLIError(localizedError);
      setCLIStatus('error');
      toast('error', `${skRef.current.installFailed || 'Install failed'}: ${localizedError}`);
    }
  }, [toast]);

  // Dismiss banner
  const handleDismissBanner = useCallback(() => {
    localStorage.setItem(BANNER_DISMISSED_KEY, 'true');
    setCLIStatus('dismissed');
  }, []);

  // Fetch installed skills from backend (merges Gateway skills.status RPC + skillhub list CLI)
  const fetchInstalledSkills = useCallback(async () => {
    try {
      const result = await skillHubApi.getInstalledSkills();
      setInstalledSkillNames(new Set(result.skills));
    } catch (err) {
      // Silently fail - installed status is not critical
      console.debug('Failed to fetch installed skills:', err);
      setInstalledSkillNames(new Set());
    }
}, []);

// Initial load
useEffect(() => {
  const dismissed = localStorage.getItem(BANNER_DISMISSED_KEY);
  const wasInstalled = localStorage.getItem('skillhub_cli_installed') === 'true';
  if (dismissed === 'true' || wasInstalled) {
    setCLIStatus(wasInstalled ? 'installed' : 'dismissed');
  } else {
    checkCLI();
  }
  fetchData();
  fetchTopSkills();
  fetchInstalledSkills();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []); // Only run once on mount

// Unified rendered skills list
const featuredRenderedSkills = useMemo(() => {
  let list = topSkills;
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    list = list.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.slug.toLowerCase().includes(q) ||
      pickLocalizedField(language, s, { base: 'description', zh: 'description_zh' }).toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.description_zh?.toLowerCase().includes(q)
    );
  }
  return list;
}, [topSkills, searchQuery, language]);

const renderedSkills = useMemo(() => {
  if (showFeatured) return featuredRenderedSkills;
  return skills;
}, [showFeatured, featuredRenderedSkills, skills]);

// Re-fetch when sort/category/featured change (paginated mode)
useEffect(() => {
  if (showFeatured) {
    if (topSkills.length === 0) fetchTopSkills();
    setHasMore(false);
    setCurrentPage(1);
    return;
  }
  if (searchQuery.trim()) return; // search has its own handler
  fetchPage(1);
}, [sortBy, category, showFeatured, fetchPage, fetchTopSkills, searchQuery, topSkills.length]);

// Debounced server-side search
useEffect(() => {
  if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
  if (!searchQuery.trim()) {
    if (showFeatured) {
      if (topSkills.length === 0) fetchTopSkills();
      setHasMore(false);
      setCurrentPage(1);
      return;
    }
    fetchPage(1);
    return;
  }
  if (showFeatured) {
    setTotalSkills(featuredRenderedSkills.length);
    setHasMore(false);
    return;
  }
  searchDebounceRef.current = setTimeout(() => {
    fetchSearch(searchQuery.trim());
  }, 300);
  return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
}, [searchQuery, showFeatured, fetchPage, fetchSearch, featuredRenderedSkills.length, fetchTopSkills, topSkills.length]);

useEffect(() => {
  if (!showFeatured) return;
  setTotalSkills(featuredRenderedSkills.length || topSkills.length || 50);
}, [showFeatured, featuredRenderedSkills.length, topSkills.length]);

// Copy prompt
const handleCopyPrompt = useCallback((skill: SkillHubSkill) => {
  const prompt = (skRef.current.skillHubInstallPrompt || 'Please first check whether the SkillHub store is installed. If it is not installed, install SkillHub following {url}, then install the {slug} skill.\n\nIf SkillHub is already installed, install the {slug} skill directly.')
    .replace(/\{url\}/g, 'https://skillhub-1251783334.cos.ap-guangzhou.myqcloud.com/install/skillhub.md')
    .replace(/\{slug\}/g, skill.slug);
  copyToClipboard(prompt).then(() => {
    toast('success', skRef.current.copiedHint || 'Copied to clipboard');
  }).catch(() => {
    toast('error', skRef.current.copyFailed || 'Copy failed');
  });
}, [toast]);

// Copy CLI command
const handleCopyCLI = useCallback((skill: SkillHubSkill) => {
  const command = `skillhub install ${skill.slug}`;
  copyToClipboard(command).then(() => {
    toast('success', skRef.current.copiedHint || 'Copied to clipboard');
  }).catch(() => {
    toast('error', skRef.current.copyFailed || 'Copy failed');
  });
}, [toast]);

// Right button action: only available when SkillHub CLI is installed
const handleRightButton = useCallback((skill: SkillHubSkill) => {
  if (cliStatus === 'installed') {
    setConfirmSkill(skill);
  }
}, [cliStatus]);

const isSkillHubCLIInstalled = cliStatus === 'installed';

// Install skill via API (called after confirmation)
const handleInstallSkill = useCallback(async (skill: SkillHubSkill) => {
  if (installingSlug) return;
  setConfirmSkill(null);
  setInstallingSlug(skill.slug);
  try {
    const result = await skillHubApi.installSkill(skill.slug);
    if (result.success) {
      toast('success', `${skill.name} ${skRef.current.installSuccess || 'installed successfully'}`);
      fetchInstalledSkills();
    }
  } catch (err: any) {
    const msg = err?.message || 'Install failed';
    if (msg.includes('CLI_NOT_INSTALLED')) {
      toast('error', skRef.current.skillHubBannerNotInstalled || 'SkillHub CLI not installed');
    } else if (msg.includes('PLATFORM_NOT_SUPPORTED')) {
      toast('error', skRef.current.platformNotSupported || 'Platform not supported. Please install manually.');
    } else {
      toast('error', `${skRef.current.installFailed || 'Install failed'}: ${msg}`);
    }
  } finally {
    setInstallingSlug(null);
  }
}, [installingSlug, toast, fetchInstalledSkills]);

const categories = useMemo(() => {
  return [...REMOTE_SKILLHUB_CATEGORIES];
}, []);

const categoryOptions = useMemo(() => {
  const isChinese = language === 'zh' || language === 'zh-TW';
  return [
    { value: 'all', label: sk.categoryAll || 'All Categories' },
    ...categories.map(cat => ({
      value: cat,
      label: REMOTE_SKILLHUB_CATEGORY_LABELS[cat]?.[isChinese ? 'zh' : 'en'] || cat,
    })),
  ];
}, [language, sk.categoryAll, categories]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-[#0f1115]">
      {/* Toolbar */}
      <div className="flex flex-col border-b border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-black/20 shrink-0">
        <div className="p-3 flex flex-row items-center gap-2">
          {/* Search */}
          <div className="relative flex-1 min-w-0">
            <span className="material-symbols-outlined absolute start-3 top-1/2 -translate-y-1/2 text-slate-400 text-[16px]">search</span>
            <input ref={searchRef} className="w-full h-9 ps-9 pe-4 bg-white dark:bg-[#1a1c22] border border-slate-200 dark:border-white/10 rounded-lg text-xs text-slate-800 dark:text-white placeholder:text-slate-400 focus:ring-1 focus:ring-primary outline-none"
              placeholder={`${sk.search || 'Search'} (Ctrl+K)`} value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          </div>

          {/* Category filter */}
          <CustomSelect
            value={category}
            onChange={(v) => setCategory(v)}
            options={categoryOptions}
            className="h-9 px-2 bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg text-[10px] font-bold text-slate-600 dark:text-white/60 outline-none shrink-0"
          />

          {/* Featured toggle */}
          <button onClick={() => setShowFeatured(!showFeatured)}
            className={`h-9 px-3 flex items-center gap-1.5 border rounded-lg text-[11px] font-bold transition-all shrink-0 ${showFeatured
              ? 'bg-primary/10 dark:bg-primary/20 border-primary/30 text-primary'
              : 'bg-slate-100 dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-600 dark:text-white/60'
            }`}>
            <span className="material-symbols-outlined text-[14px]">star</span>
            {sk.featuredSkills || 'Featured'}
          </button>

          {/* Sort */}
          <div className="flex bg-slate-200 dark:bg-black/40 p-0.5 rounded-lg shadow-inner shrink-0">
            {([
              ['score', sk.sortScore || '综合'],
              ['downloads', sk.sortDownloads || '下载'],
              ['stars', sk.sortStars || '星数'],
              ['installs', sk.sortInstalls || '安装'],
              ['name', sk.sortName || '名称'],
            ] as const).map(([val, label]) => (
              <button key={val} onClick={() => setSortBy(val as any)}
                className={`px-2 py-1 rounded text-[10px] font-bold transition-all whitespace-nowrap ${sortBy === val ? 'bg-white dark:bg-primary shadow-sm text-slate-900 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}>
                {label}
              </button>
            ))}
          </div>

          {/* Refresh */}
          <button onClick={() => showFeatured ? fetchTopSkills(true) : fetchData()} disabled={loading || (showFeatured && topLoading)}
            className="h-9 w-9 flex items-center justify-center bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg shrink-0 disabled:opacity-50"
            title={sk.forceRefresh || 'Force Refresh'}>
            <span className={`material-symbols-outlined text-[16px] text-slate-500 ${(loading || (showFeatured && topLoading)) ? 'animate-spin' : ''}`}>{(loading || (showFeatured && topLoading)) ? 'progress_activity' : 'refresh'}</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar neon-scrollbar">
        <div className="max-w-6xl mx-auto">
          {/* CLI Banner */}
          <CLIBanner status={cliStatus} onInstall={handleInstallCLI} onDismiss={handleDismissBanner} error={cliError} sk={sk} />

          {/* Loading */}
          {(loading || (showFeatured && topLoading)) && renderedSkills.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400">
              <span className="material-symbols-outlined text-4xl animate-spin mb-3">progress_activity</span>
              <span className="text-xs">{sk.loading || 'Loading...'}</span>
              <span className="text-[10px] mt-2 text-slate-400">{sk.pleaseWait || 'Please wait, this may take a few minutes...'}</span>
            </div>
          )}

          {/* Error - no data at all and not loading */}
          {!loading && !(showFeatured && topLoading) && loadError && renderedSkills.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400">
              <span className="material-symbols-outlined text-4xl mb-3 text-red-500">error</span>
              <span className="text-xs mb-3">{sk.loadFailed || 'Failed to load data'}</span>
              <button onClick={() => showFeatured ? fetchTopSkills(true) : fetchData()} className="h-8 px-4 bg-primary text-white text-xs font-bold rounded-lg hover:bg-primary/90">
                {sk.retry || 'Retry'}
              </button>
            </div>
          )}

          {/* Empty */}
          {!loading && !loadError && renderedSkills.length === 0 && (
            <EmptyState icon="search_off" title={sk.noResults || 'No skills found'} />
          )}

          {/* Skills grid */}
          {renderedSkills.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {renderedSkills.map(skill => {
                const desc = pickLocalizedField(language, skill, { base: 'description', zh: 'description_zh' });
                return (
                  <div key={skill.slug} className="bg-slate-50 dark:bg-white/[0.02] border border-slate-200 dark:border-white/5 rounded-2xl p-4 hover:border-primary/30 transition-all group shadow-sm flex flex-col cursor-pointer" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 220px' }} onClick={() => setDetailSkill(skill)}>
                    {/* Header */}
                    <div className="flex items-start gap-3 mb-2">
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/15 to-purple-500/15 flex items-center justify-center shrink-0 border border-slate-200/50 dark:border-white/5">
                        <span className="text-lg">📦</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <h4 className="font-bold text-[13px] text-slate-800 dark:text-white truncate">{skill.name}</h4>
                          {installedSkillNames.has(skill.slug) && (
                            <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-bold">
                              {sk.alreadyInstalled || 'Installed'}
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] font-mono text-slate-400 dark:text-white/40">v{skill.version}</span>
                      </div>
                    </div>

                    {/* Description */}
                    <ExpandableDesc text={desc} moreLabel={sk.expandMore || 'more'} />

                    {/* Tags */}
                    {skill.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {skill.tags.slice(0, 3).map(tag => (
                          <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-white/40">{tag}</span>
                        ))}
                      </div>
                    )}

                    {/* Stats */}
                    <div className="flex items-center gap-2 mt-auto text-[10px] text-slate-400 dark:text-white/35">
                      {skill.stars > 0 && (
                        <span className="flex items-center gap-0.5">
                          <span className="material-symbols-outlined text-[10px]">star</span>{skill.stars}
                        </span>
                      )}
                      {skill.downloads > 0 && (
                        <span className="flex items-center gap-0.5">
                          <span className="material-symbols-outlined text-[10px]">download</span>
                          {skill.downloads >= 1000 ? `${(skill.downloads / 1000).toFixed(1)}k` : skill.downloads}
                        </span>
                      )}
                      {skill.installs > 0 && (
                        <span className="flex items-center gap-0.5">
                          <span className="material-symbols-outlined text-[10px]">check_circle</span>
                          {skill.installs >= 1000 ? `${(skill.installs / 1000).toFixed(1)}k` : skill.installs}
                        </span>
                      )}
                      {skill.updated_at && (
                        <span className="flex items-center gap-0.5 shrink-0">
                          <span className="material-symbols-outlined text-[10px]">calendar_today</span>
                          {new Date(skill.updated_at).toLocaleDateString()}
                        </span>
                      )}
                      <a href={skill.homepage} target="_blank" rel="noopener noreferrer" className="ms-auto flex items-center text-primary/60 hover:text-primary transition-colors">
                        <span className="material-symbols-outlined text-[12px]">open_in_new</span>
                      </a>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 mt-2 pt-2 border-t border-slate-100 dark:border-white/5">
                      <button onClick={(e) => { e.stopPropagation(); handleCopyPrompt(skill); }}
                        className={`h-7 text-[10px] font-bold rounded-lg transition-colors flex items-center justify-center gap-1 ${isSkillHubCLIInstalled ? 'flex-1 bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-white/50 hover:bg-slate-200 dark:hover:bg-white/10' : 'w-full bg-primary/15 text-primary hover:bg-primary/25'}`}>
                        <span className="material-symbols-outlined text-[12px]">content_copy</span>
                        <span className="truncate">{sk.copyPrompt || '复制提示词'}</span>
                      </button>
                      {isSkillHubCLIInstalled && (
                        <button onClick={(e) => { e.stopPropagation(); handleRightButton(skill); }}
                          disabled={installingSlug === skill.slug}
                          className={`h-7 px-3 text-[10px] font-bold rounded-lg transition-colors flex items-center gap-1 shrink-0 ${installingSlug === skill.slug ? 'bg-primary/20 text-primary cursor-wait' : 'bg-primary text-white hover:bg-primary/90'}`}
                          title={`${sk.installSkill || 'Install'} ${skill.slug}`}>
                          <span className={`material-symbols-outlined text-[12px] ${installingSlug === skill.slug ? 'animate-spin' : ''}`}>
                            {installingSlug === skill.slug ? 'progress_activity' : 'download'}
                          </span>
                          <span className="truncate">{sk.installSkill || '安装'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Load More Button */}
          {!showFeatured && hasMore && (
            <div className="flex justify-center mt-6">
              <button 
                onClick={() => fetchPage(currentPage + 1, true)}
                disabled={loadingMore}
                className="h-10 px-6 bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg text-sm font-bold text-slate-700 dark:text-white/70 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                {loadingMore ? (
                  <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>
                ) : (
                  <span className="material-symbols-outlined text-[18px]">expand_more</span>
                )}
                {sk.loadMore || 'Load More'} ({totalSkills - renderedSkills.length} {sk.remaining || 'remaining'})
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Install Confirmation Dialog */}
      {confirmSkill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => setConfirmSkill(null)}>
          <div className="bg-white dark:bg-[#1a1c22] rounded-2xl shadow-2xl max-w-sm w-full p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center">
                <span className="material-symbols-outlined text-primary">download</span>
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-800 dark:text-white">{sk.confirmInstallTitle || 'Install Skill'}</h3>
                <p className="text-xs text-slate-500 dark:text-white/50">{confirmSkill.name}</p>
              </div>
            </div>
            <p className="text-xs text-slate-600 dark:text-white/60 mb-1">
              {sk.confirmInstallDesc || 'This will execute the following command:'}
            </p>
            <pre className="text-[11px] text-slate-700 dark:text-white/70 bg-slate-50 dark:bg-black/20 p-2 rounded-lg mb-4 font-mono border border-slate-200 dark:border-white/10">
              skillhub install {confirmSkill.slug}
            </pre>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmSkill(null)}
                className="h-8 px-4 text-xs font-bold rounded-lg bg-slate-100 dark:bg-white/10 text-slate-600 dark:text-white/60 hover:bg-slate-200 dark:hover:bg-white/20 transition-colors">
                {sk.cancel || 'Cancel'}
              </button>
              <button onClick={() => handleInstallSkill(confirmSkill)}
                className="h-8 px-4 text-xs font-bold rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">download</span>
                {sk.confirmInstallBtn || 'Install'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      <SkillDetailModal 
        skill={detailSkill} 
        onClose={() => setDetailSkill(null)} 
        onCopyPrompt={handleCopyPrompt} 
        onCopyCLI={handleCopyCLI} 
        language={language} 
        sk={sk} 
      />
    </div>
  );
};

export default SkillHub;
