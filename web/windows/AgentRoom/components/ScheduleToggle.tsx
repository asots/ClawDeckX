// ScheduleToggle —— 可嵌入任何建会流程的"设为定时会议"折叠选项。
// 展开后显示 cron / 时区 / 继承上次 等字段。
// 父组件通过 scheduleRef.current 读取配置并决定走 createSchedule 还是 createRoom。
import React, { useState, useImperativeHandle, forwardRef, useMemo } from 'react';
import CustomSelect from '../../../components/CustomSelect';

export interface ScheduleConfig {
  enabled: boolean;
  cronExpr: string;
  timezone: string;
  autoCloseout: boolean;
  inheritFromLast: boolean;
  validationError: string;
}

export interface ScheduleToggleRef {
  getConfig: () => ScheduleConfig;
}

export interface ScheduleToggleProps {
  defaultEnabled?: boolean;
  defaultCronExpr?: string;
  defaultTimezone?: string;
}

const FALLBACK_TZ = [
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
  'Asia/Bangkok', 'Asia/Kolkata', 'Asia/Dubai',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Australia/Sydney', 'Pacific/Auckland', 'UTC',
];

function validateCron(expr: string): string {
  const s = expr.trim();
  if (!s) return '请填写执行时间';
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(':').map(n => parseInt(n, 10));
    if (h < 0 || h > 23) return '小时超出 0-23';
    if (m < 0 || m > 59) return '分钟超出 0-59';
    return '';
  }
  if (s.split(/\s+/).length !== 5) return '格式需为 HH:MM 或 5-field cron（如 30 9 * * 1-5）';
  return '';
}

const ScheduleToggle = forwardRef<ScheduleToggleRef, ScheduleToggleProps>((props, ref) => {
  const tzOptions = useMemo(() => {
    try {
      const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
      if (typeof fn === 'function') return fn('timeZone');
    } catch { /* noop */ }
    return FALLBACK_TZ;
  }, []);
  const [enabled, setEnabled] = useState(!!props.defaultEnabled);
  const [cronExpr, setCronExpr] = useState(props.defaultCronExpr || '09:00');
  const [timezone, setTimezone] = useState(props.defaultTimezone || 'Asia/Shanghai');
  const [autoCloseout, setAutoCloseout] = useState(true);
  const [inheritFromLast, setInheritFromLast] = useState(true);
  const validationError = useMemo(() => (enabled ? validateCron(cronExpr) : ''), [enabled, cronExpr]);

  useImperativeHandle(ref, () => ({
    getConfig: () => ({ enabled, cronExpr: cronExpr.trim(), timezone, autoCloseout, inheritFromLast, validationError }),
  }), [enabled, cronExpr, timezone, autoCloseout, inheritFromLast, validationError]);

  return (
    <div className="rounded-lg border border-border bg-surface-raised/50 overflow-hidden">
      <button
        type="button"
        onClick={() => setEnabled(!enabled)}
        className="w-full flex items-center gap-2 px-3 py-2 text-start hover:bg-surface-sunken/50 transition-colors"
      >
        <span className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${enabled ? 'bg-info border-info' : 'border-text-muted/40'}`}>
          {enabled && <span className="material-symbols-outlined text-white text-[12px]">check</span>}
        </span>
        <span className="material-symbols-outlined text-[14px] text-info">schedule</span>
        <span className="text-[12px] font-medium text-text">设为定时会议</span>
        <span className="text-[10.5px] text-text-muted">（每天/按 cron 自动创建房间）</span>
      </button>
      {enabled && (
        <div className="px-3 pb-3 pt-1 flex flex-col gap-2 animate-fade-in border-t border-border/50">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-[10.5px] text-text-muted">执行时间</span>
              <input
                className="sci-input h-7 px-2 text-[11.5px] rounded-md w-full"
                value={cronExpr}
                onChange={e => setCronExpr(e.target.value)}
                placeholder="09:00 或 cron 5-field"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10.5px] text-text-muted">时区</span>
              <CustomSelect
                value={timezone}
                onChange={setTimezone}
                options={tzOptions.map(z => ({ value: z, label: z }))}
                className="sci-input h-7 px-2 text-[11.5px] rounded-md w-full"
              />
            </label>
          </div>
          <div className="flex items-center gap-4 text-[11px]">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={autoCloseout} onChange={e => setAutoCloseout(e.target.checked)} className="accent-info" />
              <span className="text-text-secondary">轮次到达后自动闭环</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={inheritFromLast} onChange={e => setInheritFromLast(e.target.checked)} className="accent-info" />
              <span className="text-text-secondary">继承上次会议上下文</span>
            </label>
          </div>
          {validationError && (
            <div className="text-[11px] text-danger inline-flex items-center gap-1">
              <span className="material-symbols-outlined text-[13px]">error</span>
              {validationError}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

ScheduleToggle.displayName = 'ScheduleToggle';
export default ScheduleToggle;
