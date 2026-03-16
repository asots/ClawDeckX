
import { readStorage, writeStorage } from './storage';

export type WindowControlsPosition = 'left' | 'right';
export type WallpaperSource = 'random' | 'picsum' | 'unsplash' | 'custom';
export type WallpaperProvider = 'picsum' | 'unsplash' | 'custom';

export interface WallpaperConfig {
  gradientEnabled: boolean;
  imageEnabled: boolean;
  source: WallpaperSource;
  customUrl: string;
  cachedUrl: string;
  cachedAt: number;
  resolvedSource?: WallpaperProvider;
}

export interface Preferences {
  windowControlsPosition: WindowControlsPosition;
  wallpaper: WallpaperConfig;
}

const PREFS_KEY = 'clawdeck-preferences';

const DEFAULT_WALLPAPER: WallpaperConfig = {
  gradientEnabled: true,
  imageEnabled: false,
  source: 'random',
  customUrl: '',
  cachedUrl: '',
  cachedAt: 0,
  resolvedSource: 'picsum',
};

const DEFAULT_PREFS: Preferences = {
  windowControlsPosition: 'left',
  wallpaper: { ...DEFAULT_WALLPAPER },
};

export function loadPreferences(): Preferences {
  const raw = readStorage<Partial<Preferences>>(PREFS_KEY);
  if (!raw) return { ...DEFAULT_PREFS, wallpaper: { ...DEFAULT_WALLPAPER } };

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
    gradientEnabled: typeof rawWallpaper?.gradientEnabled === 'boolean'
      ? rawWallpaper.gradientEnabled
      : true,
    imageEnabled: typeof rawWallpaper?.imageEnabled === 'boolean'
      ? rawWallpaper.imageEnabled
      : Boolean(legacyWallpaper?.enabled && legacySource && legacySource !== 'gradient'),
    source:
      legacySource === 'custom'
        ? 'custom'
        : legacySource === 'picsum' || legacySource === 'unsplash' || legacySource === 'random'
          ? legacySource
          : 'random',
    resolvedSource:
      rawWallpaper?.resolvedSource === 'unsplash' || rawWallpaper?.resolvedSource === 'custom'
        ? rawWallpaper.resolvedSource
        : 'picsum',
  };

  return {
    windowControlsPosition: raw.windowControlsPosition || DEFAULT_PREFS.windowControlsPosition,
    wallpaper: migratedWallpaper,
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

export function isWallpaperCacheStale(cachedAt: number): boolean {
  return Date.now() - cachedAt > CACHE_TTL;
}

export function getWallpaperProviderLabel(provider: WallpaperProvider): string {
  switch (provider) {
    case 'picsum':
      return 'Picsum';
    case 'unsplash':
      return 'Unsplash';
    case 'custom':
      return 'Custom URL';
  }
}

export async function fetchWallpaperUrl(
  source: WallpaperSource,
  customUrl: string,
): Promise<{ url: string; provider: WallpaperProvider } | null> {
  if (source === 'custom' && customUrl) {
    return { url: customUrl, provider: 'custom' };
  }

  const provider: WallpaperProvider =
    source === 'random'
      ? (Math.random() < 0.5 ? 'picsum' : 'unsplash')
      : source === 'unsplash'
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

export async function fetchAndCacheWallpaper(url: string): Promise<string> {
  // Use <img> element instead of fetch() to bypass CSP connect-src restrictions.
  // img-src already allows "https:" so any HTTPS image URL works.
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
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
    img.src = url;
  });
}
