
import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { Preferences, WindowControlsPosition, WallpaperSource } from '../../utils/preferences';
import { updatePreferences, fetchWallpaperUrl, fetchAndCacheWallpaper, getCachedWallpaper } from '../../utils/preferences';

interface PreferencesTabProps {
  s: Record<string, any>;
  pref: Record<string, any>;
  prefs: Preferences;
  onPrefsChange: (prefs: Preferences) => void;
  inputCls: string;
  rowCls: string;
}

const PreferencesTab: React.FC<PreferencesTabProps> = ({ s, pref, prefs, onPrefsChange, inputCls, rowCls }) => {
  const [wallpaperLoading, setWallpaperLoading] = useState(false);
  const [wallpaperPreview, setWallpaperPreview] = useState<string>('');
  const [wallpaperError, setWallpaperError] = useState('');
  const customUrlRef = useRef(prefs.wallpaper.customUrl);

  useEffect(() => {
    const cached = getCachedWallpaper();
    if (cached && prefs.wallpaper.imageEnabled) setWallpaperPreview(cached);
  }, [prefs.wallpaper.imageEnabled]);

  const handleControlsPosition = useCallback((pos: WindowControlsPosition) => {
    const next = updatePreferences({ windowControlsPosition: pos });
    onPrefsChange(next);
  }, [onPrefsChange]);

  const handleGradientToggle = useCallback(() => {
    const next = updatePreferences({ wallpaper: { ...prefs.wallpaper, gradientEnabled: !prefs.wallpaper.gradientEnabled } });
    onPrefsChange(next);
  }, [prefs.wallpaper, onPrefsChange]);

  const handleImageToggle = useCallback(() => {
    const next = updatePreferences({ wallpaper: { ...prefs.wallpaper, imageEnabled: !prefs.wallpaper.imageEnabled } });
    onPrefsChange(next);
  }, [prefs.wallpaper, onPrefsChange]);

  const handleWallpaperSource = useCallback((source: WallpaperSource) => {
    const next = updatePreferences({ wallpaper: { ...prefs.wallpaper, source, resolvedSource: source === 'custom' ? 'custom' : prefs.wallpaper.resolvedSource } });
    onPrefsChange(next);
  }, [prefs.wallpaper, onPrefsChange]);

  const handleCustomUrlChange = useCallback((url: string) => {
    customUrlRef.current = url;
    const next = updatePreferences({ wallpaper: { ...prefs.wallpaper, customUrl: url } });
    onPrefsChange(next);
  }, [prefs.wallpaper, onPrefsChange]);

  const handleRefreshWallpaper = useCallback(async () => {
    setWallpaperLoading(true);
    setWallpaperError('');
    try {
      const resolved = await fetchWallpaperUrl(prefs.wallpaper.source, prefs.wallpaper.customUrl);
      if (!resolved) { setWallpaperLoading(false); return; }
      const dataUrl = await fetchAndCacheWallpaper(resolved.url);
      setWallpaperPreview(dataUrl);
      const next = updatePreferences({ wallpaper: { ...prefs.wallpaper, cachedUrl: dataUrl, cachedAt: Date.now(), resolvedSource: resolved.provider } });
      onPrefsChange(next);
    } catch {
      setWallpaperError(pref?.wallpaperFetchFail || 'Failed to load wallpaper');
    }
    setWallpaperLoading(false);
  }, [prefs.wallpaper, onPrefsChange, pref]);

  const labelCls = "text-[12px] font-medium text-slate-500 dark:text-white/40";
  const activeWallpaperSourceLabel =
    prefs.wallpaper.source === 'random'
      ? (prefs.wallpaper.resolvedSource === 'unsplash' ? (pref?.wallpaperUnsplash || 'Unsplash') : (pref?.wallpaperPicsum || 'Picsum'))
      : prefs.wallpaper.source === 'picsum'
        ? (pref?.wallpaperPicsum || 'Picsum')
        : prefs.wallpaper.source === 'unsplash'
          ? (pref?.wallpaperUnsplash || 'Unsplash')
          : (pref?.wallpaperCustom || 'Custom URL');

  return (
    <div className="space-y-5">
      <h2 className="text-[22px] font-bold text-slate-800 dark:text-white">{pref?.title || 'Preferences'}</h2>

      {/* Window Controls Position */}
      <div className={rowCls}>
        <div className="px-4 py-3">
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-[18px] text-blue-500">pip_exit</span>
            <p className="text-[13px] font-semibold text-slate-700 dark:text-white/80">{pref?.windowControls || 'Window Controls Position'}</p>
          </div>
          <p className="text-[11px] text-slate-400 dark:text-white/30 mb-3">{pref?.windowControlsDesc || 'Choose where the close, minimize, and maximize buttons appear on windows.'}</p>
          <div className="flex gap-3">
            {(['left', 'right'] as const).map(pos => (
              <button key={pos} onClick={() => handleControlsPosition(pos)}
                className={`flex-1 flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all ${
                  prefs.windowControlsPosition === pos
                    ? 'border-primary bg-primary/5 dark:bg-primary/10'
                    : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
                }`}>
                {/* Mini window preview */}
                <div className="w-full h-10 rounded-lg bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center px-2 gap-1.5">
                  {pos === 'left' ? (
                    <>
                      <div className="flex gap-1 shrink-0">
                        <div className="w-2 h-2 rounded-full bg-mac-red" />
                        <div className="w-2 h-2 rounded-full bg-mac-yellow" />
                        <div className="w-2 h-2 rounded-full bg-mac-green" />
                      </div>
                      <div className="flex-1" />
                    </>
                  ) : (
                    <>
                      <div className="flex-1" />
                      <div className="flex gap-1 shrink-0">
                        <div className="w-2 h-2 rounded-full bg-mac-yellow" />
                        <div className="w-2 h-2 rounded-full bg-mac-green" />
                        <div className="w-2 h-2 rounded-full bg-mac-red" />
                      </div>
                    </>
                  )}
                </div>
                <span className={`text-[11px] font-bold ${
                  prefs.windowControlsPosition === pos ? 'text-primary' : 'text-slate-500 dark:text-white/40'
                }`}>
                  {pos === 'left' ? (pref?.windowControlsLeft || 'Left (macOS)') : (pref?.windowControlsRight || 'Right (Windows)')}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Desktop Wallpaper */}
      <div className={rowCls}>
        <div className="px-4 py-3">
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-[18px] text-purple-500">wallpaper</span>
            <p className="text-[13px] font-semibold text-slate-700 dark:text-white/80">{pref?.wallpaper || 'Desktop Wallpaper'}</p>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-xl border border-slate-200 dark:border-white/10 px-3 py-2.5 bg-slate-50/70 dark:bg-white/[0.03]">
              <div>
                <p className="text-[12px] font-semibold text-slate-700 dark:text-white/80">{pref?.wallpaperGradient || 'Default Gradient'}</p>
                <p className="text-[10px] text-slate-400 dark:text-white/25">{pref?.wallpaperGradientDesc || 'Use the built-in desktop gradient background.'}</p>
              </div>
              <button
                onClick={handleGradientToggle}
                className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${prefs.wallpaper.gradientEnabled ? 'bg-primary' : 'bg-slate-300 dark:bg-white/15'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${prefs.wallpaper.gradientEnabled ? 'translate-x-4' : ''}`} />
              </button>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-slate-200 dark:border-white/10 px-3 py-2.5 bg-slate-50/70 dark:bg-white/[0.03]">
              <div>
                <p className="text-[12px] font-semibold text-slate-700 dark:text-white/80">{pref?.wallpaperImage || 'Image Wallpaper'}</p>
                <p className="text-[10px] text-slate-400 dark:text-white/25">{pref?.wallpaperImageDesc || 'Overlay a remote image on top of the desktop gradient.'}</p>
              </div>
              <button
                onClick={handleImageToggle}
                className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${prefs.wallpaper.imageEnabled ? 'bg-primary' : 'bg-slate-300 dark:bg-white/15'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${prefs.wallpaper.imageEnabled ? 'translate-x-4' : ''}`} />
              </button>
            </div>
          </div>

          {prefs.wallpaper.imageEnabled && (
            <div className="space-y-3 mt-3">
              <div>
                <label className={labelCls}>{pref?.wallpaperSource || 'Source'}</label>
                <div className="flex flex-wrap gap-2 mt-1.5">
                  {([
                    { id: 'random' as const, label: pref?.wallpaperRandom || 'Random', icon: 'shuffle' },
                    { id: 'picsum' as const, label: pref?.wallpaperPicsum || 'Picsum', icon: 'photo_library' },
                    { id: 'unsplash' as const, label: pref?.wallpaperUnsplash || 'Unsplash', icon: 'image' },
                    { id: 'custom' as const, label: pref?.wallpaperCustom || 'Custom URL', icon: 'link' },
                  ]).map(src => (
                    <button key={src.id} onClick={() => handleWallpaperSource(src.id)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all border ${
                        prefs.wallpaper.source === src.id
                          ? 'bg-primary/10 text-primary border-primary/30'
                          : 'bg-slate-50 dark:bg-white/5 text-slate-500 dark:text-white/40 border-slate-200 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/10'
                      }`}>
                      <span className="material-symbols-outlined text-[14px]">{src.icon}</span>
                      {src.label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[10px] text-slate-400 dark:text-white/25">
                  {prefs.wallpaper.source === 'random'
                    ? (pref?.wallpaperRandomDesc || 'Randomly pick from Picsum and Unsplash each time you refresh.')
                    : prefs.wallpaper.source === 'picsum'
                      ? (pref?.wallpaperPicsumDesc || 'Always use Picsum as the wallpaper source.')
                      : prefs.wallpaper.source === 'unsplash'
                        ? (pref?.wallpaperUnsplashDesc || 'Always use Unsplash as the wallpaper source.')
                        : (pref?.wallpaperCustomDesc || 'Use the image URL you provide below.')}
                </p>
              </div>

              {prefs.wallpaper.source === 'custom' && (
                <div>
                  <label className={labelCls}>{pref?.wallpaperUrl || 'Image URL'}</label>
                  <input
                    type="url"
                    value={prefs.wallpaper.customUrl}
                    onChange={e => handleCustomUrlChange(e.target.value)}
                    className={`${inputCls} mt-1.5`}
                    placeholder="https://example.com/wallpaper.jpg"
                  />
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-1">
                    <label className={labelCls}>{pref?.wallpaperPreview || 'Preview'}</label>
                    <p className="text-[10px] text-slate-400 dark:text-white/25">
                      {(pref?.wallpaperUsing || 'Current source') + ': ' + activeWallpaperSourceLabel}
                    </p>
                  </div>
                  <button
                    onClick={handleRefreshWallpaper}
                    disabled={wallpaperLoading || (prefs.wallpaper.source === 'custom' && !prefs.wallpaper.customUrl)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold text-primary hover:bg-primary/5 transition-colors disabled:opacity-40"
                  >
                    <span className={`material-symbols-outlined text-[14px] ${wallpaperLoading ? 'animate-spin' : ''}`}>
                      {wallpaperLoading ? 'progress_activity' : 'refresh'}
                    </span>
                    {pref?.wallpaperRefresh || 'Refresh'}
                  </button>
                </div>
                {wallpaperPreview ? (
                  <div className="w-full aspect-[16/9] min-h-52 rounded-xl overflow-hidden border border-slate-200 dark:border-white/10 bg-slate-100 dark:bg-white/5">
                    <img src={wallpaperPreview} alt="Wallpaper preview" className="w-full h-full object-contain" />
                  </div>
                ) : (
                  <div className="w-full aspect-[16/9] min-h-52 rounded-xl border border-dashed border-slate-300 dark:border-white/15 flex items-center justify-center bg-slate-50 dark:bg-white/5">
                    <span className="text-[12px] text-slate-400 dark:text-white/20">
                      {pref?.wallpaperClickRefresh || 'Click Refresh to load wallpaper'}
                    </span>
                  </div>
                )}
                {wallpaperError && (
                  <p className="text-[11px] text-mac-red">{wallpaperError}</p>
                )}
                <p className="text-[10px] text-slate-400 dark:text-white/20">
                  {pref?.wallpaperCacheHint || 'Wallpaper is cached locally. It refreshes automatically every 24 hours.'}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PreferencesTab;
