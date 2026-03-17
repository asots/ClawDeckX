
import { readStorage, writeStorage } from './storage';
import { wallpaperApi } from '../services/api';
import type { WindowID } from '../types';

export type WindowControlsPosition = 'left' | 'right';
export type WallpaperSource = 'random' | 'wallhaven' | 'picsum' | 'unsplash' | 'custom';
export type WallpaperProvider = 'wallhaven' | 'picsum' | 'unsplash' | 'custom';

export type WallpaperCategory = 'general' | 'anime' | 'people';

export interface WallpaperCategoryState {
  general: boolean;
  anime: boolean;
  people: boolean;
}

export interface WallpaperConfig {
  gradientEnabled: boolean;
  imageEnabled: boolean;
  source: WallpaperSource;
  customUrl: string;
  cachedUrl: string;
  cachedAt: number;
  fitMode: 'cover' | 'contain' | 'fill';
  brightness: number;
  overlayOpacity: number;
  blur: number;
  query: string;
  minResolution: string;
  ratios: string;
  apiKey: string;
  categories: WallpaperCategoryState;
  purity: 'sfw' | 'sketchy';
  lockEnabled: boolean;
  history: string[];
  historyIndex: number;
  favorites: string[];
  prefetchedUrls: string[];
  resolvedSource?: WallpaperProvider;
}

export type StartupWindowMode = 'none' | WindowID;

export interface Preferences {
  windowControlsPosition: WindowControlsPosition;
  wallpaper: WallpaperConfig;
  startupWindow: StartupWindowMode;
}

const PREFS_KEY = 'clawdeck-preferences';

const DEFAULT_WALLPAPER: WallpaperConfig = {
  gradientEnabled: true,
  imageEnabled: false,
  source: 'random',
  customUrl: '',
  cachedUrl: '',
  cachedAt: 0,
  fitMode: 'cover',
  brightness: 100,
  overlayOpacity: 0,
  blur: 0,
  query: 'landscape scenery',
  minResolution: '1920x1080',
  ratios: '16x9,16x10,21x9',
  apiKey: '',
  categories: {
    general: true,
    anime: true,
    people: false,
  },
  purity: 'sfw',
  lockEnabled: false,
  history: [],
  historyIndex: -1,
  favorites: [],
  prefetchedUrls: [],
  resolvedSource: 'wallhaven',
};

const DEFAULT_PREFS: Preferences = {
  windowControlsPosition: 'left',
  wallpaper: { ...DEFAULT_WALLPAPER, categories: { ...DEFAULT_WALLPAPER.categories } },
  startupWindow: 'dashboard',
};

export function loadPreferences(): Preferences {
  const raw = readStorage<Partial<Preferences>>(PREFS_KEY);
  if (!raw) return { ...DEFAULT_PREFS, wallpaper: { ...DEFAULT_WALLPAPER, categories: { ...DEFAULT_WALLPAPER.categories } } };

  const rawWallpaper = raw.wallpaper as Partial<WallpaperConfig> & {
    enabled?: boolean;
    source?: string;
  } | undefined;
  const legacyWallpaper = raw.wallpaper as {
    enabled?: boolean;
    source?: string;
  } | undefined;

  const legacySource = legacyWallpaper?.source;
  const migratedWallpaper: WallpaperConfig = {
    ...DEFAULT_WALLPAPER,
    ...(rawWallpaper || {}),
    categories: {
      ...DEFAULT_WALLPAPER.categories,
      ...(rawWallpaper?.categories || {}),
    },
    gradientEnabled: typeof rawWallpaper?.gradientEnabled === 'boolean'
      ? rawWallpaper.gradientEnabled
      : true,
    imageEnabled: typeof rawWallpaper?.imageEnabled === 'boolean'
      ? rawWallpaper.imageEnabled
      : Boolean(legacyWallpaper?.enabled && legacySource && legacySource !== 'gradient'),
    source:
      legacySource === 'custom'
        ? 'custom'
        : legacySource === 'wallhaven' || legacySource === 'picsum' || legacySource === 'unsplash' || legacySource === 'random'
          ? legacySource
          : 'random',
    resolvedSource:
      rawWallpaper?.resolvedSource === 'wallhaven' || rawWallpaper?.resolvedSource === 'unsplash' || rawWallpaper?.resolvedSource === 'custom'
        ? rawWallpaper.resolvedSource
        : 'wallhaven',
  };

  return {
    windowControlsPosition: raw.windowControlsPosition || DEFAULT_PREFS.windowControlsPosition,
    wallpaper: migratedWallpaper,
    startupWindow: raw.startupWindow ?? DEFAULT_PREFS.startupWindow,
  };
}

export function savePreferences(prefs: Preferences): void {
  writeStorage(PREFS_KEY, prefs);
}

export function updatePreferences(patch: Partial<Preferences>): Preferences {
  const current = loadPreferences();
  const next: Preferences = {
    ...current,
    ...patch,
    wallpaper: patch.wallpaper ? { ...current.wallpaper, ...patch.wallpaper } : current.wallpaper,
  };
  savePreferences(next);
  return next;
}

const WALLPAPER_CACHE_KEY = 'clawdeck-wallpaper-cache';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export function getCachedWallpaper(): string | null {
  return readStorage<string>(WALLPAPER_CACHE_KEY);
}

export function setCachedWallpaper(dataUrl: string): void {
  try {
    writeStorage(WALLPAPER_CACHE_KEY, dataUrl);
  } catch {
    // localStorage quota exceeded — silently fail
  }
}

function dedupeUrls(urls: string[], max = 20): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of urls) {
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= max) break;
  }
  return result;
}

export function pushWallpaperHistoryEntry(wallpaper: WallpaperConfig, url: string): WallpaperConfig {
  const trimmed = url.trim();
  if (!trimmed) return wallpaper;
  const beforeCurrent = wallpaper.historyIndex >= 0
    ? wallpaper.history.slice(0, wallpaper.historyIndex + 1)
    : wallpaper.history;
  const nextHistory = dedupeUrls([...beforeCurrent, trimmed], 30);
  return {
    ...wallpaper,
    history: nextHistory,
    historyIndex: Math.max(0, nextHistory.length - 1),
    cachedUrl: trimmed,
    cachedAt: Date.now(),
  };
}

function getCurrentWallpaperHistoryIndex(wallpaper: WallpaperConfig): number {
  if (!wallpaper.history.length) return -1;
  const currentUrl = wallpaper.cachedUrl.trim();
  const matchedIndex = currentUrl ? wallpaper.history.indexOf(currentUrl) : -1;
  if (matchedIndex >= 0) return matchedIndex;
  if (wallpaper.historyIndex >= 0 && wallpaper.historyIndex < wallpaper.history.length) return wallpaper.historyIndex;
  return wallpaper.history.length - 1;
}

export function getWallpaperHistoryUrl(wallpaper: WallpaperConfig, direction: -1 | 1): string | null {
  if (!wallpaper.history.length) return null;
  const nextIndex = getCurrentWallpaperHistoryIndex(wallpaper) + direction;
  if (nextIndex < 0 || nextIndex >= wallpaper.history.length) return null;
  return wallpaper.history[nextIndex] || null;
}

export function stepWallpaperHistory(wallpaper: WallpaperConfig, direction: -1 | 1): WallpaperConfig {
  if (!wallpaper.history.length) return wallpaper;
  const nextIndex = getCurrentWallpaperHistoryIndex(wallpaper) + direction;
  if (nextIndex < 0 || nextIndex >= wallpaper.history.length) return wallpaper;
  return {
    ...wallpaper,
    historyIndex: nextIndex,
    cachedUrl: wallpaper.history[nextIndex] || wallpaper.cachedUrl,
    cachedAt: Date.now(),
  };
}

export function toggleWallpaperFavorite(wallpaper: WallpaperConfig, url?: string): WallpaperConfig {
  const target = (url || wallpaper.cachedUrl).trim();
  if (!target) return wallpaper;
  const exists = wallpaper.favorites.includes(target);
  return {
    ...wallpaper,
    favorites: exists
      ? wallpaper.favorites.filter(item => item !== target)
      : dedupeUrls([target, ...wallpaper.favorites], 50),
  };
}

export function setWallpaperPrefetchedUrls(wallpaper: WallpaperConfig, urls: string[]): WallpaperConfig {
  return {
    ...wallpaper,
    prefetchedUrls: dedupeUrls(urls, 8),
  };
}

export function shiftPrefetchedWallpaper(wallpaper: WallpaperConfig): { wallpaper: WallpaperConfig; url: string | null } {
  const [nextUrl, ...rest] = wallpaper.prefetchedUrls;
  return {
    wallpaper: {
      ...wallpaper,
      prefetchedUrls: rest,
    },
    url: nextUrl || null,
  };
}

export function isWallpaperFavorite(wallpaper: WallpaperConfig, url?: string): boolean {
  const target = (url || wallpaper.cachedUrl).trim();
  return target ? wallpaper.favorites.includes(target) : false;
}

export function isWallpaperCacheStale(cachedAt: number): boolean {
  return Date.now() - cachedAt > CACHE_TTL;
}

function encodeWallhavenCategories(categories: WallpaperCategoryState | undefined): string {
  const safe = categories || DEFAULT_WALLPAPER.categories;
  const flags = [safe.general, safe.anime, safe.people].map(v => (v ? '1' : '0')).join('');
  return flags === '000' ? '110' : flags;
}

function encodeWallhavenPurity(purity: WallpaperConfig['purity'] | undefined): string {
  return purity === 'sketchy' ? '110' : '100';
}

export async function fetchWallpaperUrl(
  wallpaper: WallpaperConfig,
): Promise<{ url: string; provider: WallpaperProvider } | null> {
  if (wallpaper.source === 'custom' && wallpaper.customUrl) {
    return { url: wallpaper.customUrl, provider: 'custom' };
  }

  const tryWallhaven = async (): Promise<{ url: string; provider: WallpaperProvider } | null> => {
    const item = await wallpaperApi.wallhavenRandom({
      q: wallpaper.query.trim() || DEFAULT_WALLPAPER.query,
      atleast: wallpaper.minResolution.trim() || DEFAULT_WALLPAPER.minResolution,
      ratios: wallpaper.ratios.trim() || DEFAULT_WALLPAPER.ratios,
      categories: encodeWallhavenCategories(wallpaper.categories),
      purity: encodeWallhavenPurity(wallpaper.purity),
      apiKey: wallpaper.apiKey.trim() || undefined,
    });
    if (!item.image_url) return null;
    return { url: item.image_url, provider: 'wallhaven' };
  };

  if (wallpaper.source === 'wallhaven' || wallpaper.source === 'random') {
    try {
      const wallhaven = await tryWallhaven();
      if (wallhaven) return wallhaven;
    } catch {
      if (wallpaper.source === 'wallhaven') {
        // fall through to legacy providers as a soft fallback for now
      }
    }
  }

  const provider: WallpaperProvider =
    wallpaper.source === 'unsplash'
      ? 'unsplash'
      : 'picsum';

  if (provider === 'picsum') {
    return {
      url: `https://picsum.photos/1920/1080?t=${Date.now()}`,
      provider,
    };
  }

  return {
    url: `https://source.unsplash.com/random/1920x1080/?wallpaper,landscape&t=${Date.now()}`,
    provider,
  };
}

export async function resolveWallpaperData(
  wallpaper: WallpaperConfig,
): Promise<{ dataUrl: string; provider: WallpaperProvider } | null> {
  const resolved = await fetchWallpaperUrl(wallpaper);
  if (!resolved) return null;
  const dataUrl = await fetchAndCacheWallpaper(resolved.url);
  return {
    dataUrl,
    provider: resolved.provider,
  };
}

export function applyResolvedWallpaper(
  wallpaper: WallpaperConfig,
  dataUrl: string,
  provider?: WallpaperProvider,
): WallpaperConfig {
  return pushWallpaperHistoryEntry({
    ...wallpaper,
    resolvedSource: provider || wallpaper.resolvedSource,
  }, dataUrl);
}

/**
 * Rewrite Wallhaven CDN URLs to go through our backend image proxy so that
 * the server can add the required Referer / User-Agent headers. Other URLs
 * are used directly.
 */
function proxyWallhavenUrl(url: string): string {
  try {
    const u = new URL(url, window.location.href);
    if (u.host === 'w.wallhaven.cc' || u.host === 'th.wallhaven.cc') {
      return `/api/v1/wallpaper/proxy?url=${encodeURIComponent(url)}`;
    }
  } catch { /* use original */ }
  return url;
}

export async function fetchAndCacheWallpaper(url: string): Promise<string> {
  const effectiveUrl = proxyWallhavenUrl(url);

  // Use <img> element instead of fetch() to bypass CSP connect-src restrictions.
  // img-src already allows "https:" so any HTTPS image URL works.
  return new Promise((resolve, reject) => {
    const img = new Image();
    let host = '';
    try {
      host = new URL(url, window.location.href).host;
    } catch {
      host = '';
    }
    // For proxied URLs (same-origin) and picsum we need crossOrigin to read canvas
    if (effectiveUrl.startsWith('/') || host === 'picsum.photos') {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const maxW = 1920;
      const scale = Math.min(1, maxW / img.width);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('no canvas ctx')); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      try {
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        setCachedWallpaper(dataUrl);
        resolve(dataUrl);
      } catch {
        // CORS tainted canvas — fall back to using the URL directly
        resolve(url);
      }
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = effectiveUrl;
  });
}
