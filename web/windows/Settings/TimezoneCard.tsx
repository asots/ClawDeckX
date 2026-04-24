// TimezoneCard —— UI_TIMEZONE 偏好卡
//
// UI_TIMEZONE 是用户级、浏览器本地偏好（不走后端），影响所有 AgentRoom 时间戳渲染。
// 为空 = 跟随浏览器 Intl 默认（Intl.DateTimeFormat().resolvedOptions().timeZone）。
// 典型值：Asia/Shanghai、Asia/Tokyo、UTC、America/Los_Angeles。

import React, { useMemo, useState } from 'react';
import { getUITimezone, setUITimezone } from '../AgentRoom/shared';
import CustomSelect from '../../components/CustomSelect';

// 常用时区候选。非穷举；用户可手动输入任意 IANA 时区。
const COMMON_TZ: string[] = [
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Asia/Taipei', 'Asia/Hong_Kong',
  'Asia/Kolkata', 'Asia/Dubai',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
  'UTC',
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo',
  'Australia/Sydney',
];

const TimezoneCard: React.FC<{ s: Record<string, any>; pref?: Record<string, any> }> = ({ s, pref }) => {
  const p = pref || {};
  const [tz, setTz] = useState<string>(() => getUITimezone() || '');
  const browserTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  }, []);
  const effective = tz.trim() || browserTz;
  const sample = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, timeZone: effective,
      }).format(new Date());
    } catch {
      return 'Invalid timezone';
    }
  }, [effective]);

  const commit = (next: string) => {
    setTz(next);
    setUITimezone(next.trim() ? next : null);
  };

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-white/95 dark:bg-white/5 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-[18px] text-primary">schedule</span>
        <h4 className="text-[13px] font-semibold text-slate-900 dark:text-white">
          {p.uiTimezoneTitle || s.uiTimezoneTitle || 'Display Timezone'}
        </h4>
      </div>
      <p className="text-[11px] text-slate-500 dark:text-white/50 leading-relaxed">
        {p.uiTimezoneDesc || s.uiTimezoneDesc || 'Affects how timestamps are rendered in AgentRoom. Leave empty to follow your browser.'}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <CustomSelect
          value={tz && COMMON_TZ.includes(tz) ? tz : (tz ? '__custom__' : '')}
          onChange={v => {
            if (v === '__custom__') return; // 保留当前自定义值，不清空
            commit(v);
          }}
          options={[
            { value: '', label: `${p.uiTimezoneFollowBrowser || s.uiTimezoneFollowBrowser || 'Follow browser'} (${browserTz})` },
            ...COMMON_TZ.map(z => ({ value: z, label: z })),
            ...(tz && !COMMON_TZ.includes(tz) ? [{ value: '__custom__', label: `${tz} (custom)` }] : []),
          ]}
          className="min-w-[200px] px-2 h-8 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900 text-[12px] text-slate-700 dark:text-white/80"
        />
        <input
          type="text"
          value={tz}
          onChange={e => setTz(e.target.value)}
          onBlur={e => commit(e.target.value)}
          placeholder="IANA, e.g. Asia/Shanghai"
          className="flex-1 min-w-[160px] px-2 h-8 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900 text-[12px] font-mono"
        />
        {tz && (
          <button
            type="button"
            onClick={() => commit('')}
            className="px-2 h-8 rounded-lg text-[11px] bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-700 dark:text-white/80"
          >
            {p.uiTimezoneReset || s.reset || 'Reset'}
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-white/5 text-[11px] text-slate-600 dark:text-white/60">
        <span className="material-symbols-outlined text-[14px] text-primary">preview</span>
        <span className="font-mono tabular-nums">{sample}</span>
        <span className="text-slate-400 dark:text-white/30">· {effective}</span>
      </div>
    </div>
  );
};

export default TimezoneCard;
