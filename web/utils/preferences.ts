
import { readStorage, writeStorage } from './storage';

export type WindowControlsPosition = 'left' | 'right';
export type WallpaperSource = 'gradient' | 'picsum' | 'custom';

export interface WallpaperConfig {
  enabled: boolean;
  source: WallpaperSource;
  customUrl: string;
  cachedUrl: string;
  cachedAt: number;
}

export interface Preferences {
  windowControlsPosition: WindowControlsPosition;
  wallpaper: WallpaperConfig;
}

const PREFS_KEY = 'clawdeck-preferences';

const DEFAULT_WALLPAPER: WallpaperConfig = {
  enabled: false,
  source: 'gradient',
  customUrl: '',
  cachedUrl: '',
  cachedAt: 0,
};

const DEFAULT_PREFS: Preferences = {
  windowControlsPosition: 'left',
  wallpaper: { ...DEFAULT_WALLPAPER },
};

export function loadPreferences(): Preferences {
  const raw = readStorage<Partial<Preferences>>(PREFS_KEY);
  if (!raw) return { ...DEFAULT_PREFS, wallpaper: { ...DEFAULT_WALLPAPER } };
  return {
    windowControlsPosition: raw.windowControlsPosition || DEFAULT_PREFS.windowControlsPosition,
    wallpaper: { ...DEFAULT_WALLPAPER, ...(raw.wallpaper || {}) },
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

export async function fetchWallpaperUrl(source: WallpaperSource, customUrl: string): Promise<string> {
  if (source === 'custom' && customUrl) return customUrl;
  if (source === 'picsum') {
    // Picsum returns a random image; add cache-busting timestamp
    return `https://picsum.photos/1920/1080?t=${Date.now()}`;
  }
  return '';
}

export async function fetchAndCacheWallpaper(url: string): Promise<string> {
  const response = await fetch(url);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const maxW = 1920;
      const scale = Math.min(1, maxW / img.width);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('no canvas ctx')); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      setCachedWallpaper(dataUrl);
      resolve(dataUrl);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}
