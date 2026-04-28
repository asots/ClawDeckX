import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { MeetingSchedule, RoomTemplate } from '../types';
import { listSchedules, createSchedule, updateSchedule, deleteSchedule, runScheduleNow, listTemplates } from '../service';
import { useBusy } from '../useBusy';
import { useConfirm } from '../../../components/ConfirmDialog';
import CustomSelect from '../../../components/CustomSelect';
import NumberStepper from '../../../components/NumberStepper';

const FALLBACK_TZ = [
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
  'Asia/Bangkok', 'Asia/Kolkata', 'Asia/Dubai',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Australia/Sydney', 'Pacific/Auckland', 'UTC',
];

interface Props { onOpenRoom?: (roomId: string) => void; }

export default function SchedulePanel({ onOpenRoom }: Props) {
  const [items, setItems] = useState<MeetingSchedule[]>([]);
  const [tpls, setTpls] = useState<RoomTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editItem, setEditItem] = useState<MeetingSchedule | null>(null);
  const { confirm } = useConfirm();
  const busy = useBusy();

  const load = useCallback(async () => {
    try { const [s, t] = await Promise.all([listSchedules(), listTemplates()]); setItems(s); setTpls(t); } catch {}
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="p-8 text-center text-text-muted text-sm">加载中…</div>;

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-y-auto neon-scrollbar">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text flex items-center gap-2">
          <span className="material-symbols-outlined text-lg">schedule</span>定时会议
        </h2>
        <button type="button" onClick={() => { setFormOpen(true); setEditItem(null); }}
          className="h-7 px-3 rounded-lg text-xs font-medium bg-info/20 text-info hover:bg-info/30 flex items-center gap-1">
          <span className="material-symbols-outlined text-sm">add</span>新建
        </button>
      </div>

      {formOpen && <ScheduleForm tpls={tpls} initial={editItem} busy={busy.busy}
        onSave={async d => { await busy.run(async () => { editItem ? await updateSchedule(editItem.id, d as any) : await createSchedule(d as any); setFormOpen(false); setEditItem(null); await load(); }); }}
        onCancel={() => { setFormOpen(false); setEditItem(null); }} />}

      {items.length === 0 && !formOpen && <div className="text-center text-text-muted text-sm py-10">暂无定时会议</div>}

      {items.map(s => <ScheduleCard key={s.id} s={s} tpls={tpls} onOpenRoom={onOpenRoom}
        onEdit={() => { setEditItem(s); setFormOpen(true); }}
        onToggle={async () => { await updateSchedule(s.id, { enabled: !s.enabled } as any); load(); }}
        onTrigger={async () => { await busy.run(() => runScheduleNow(s.id)); setTimeout(load, 2000); }}
        onDelete={async () => { if (await confirm({ title: '删除', message: '确认删除？', confirmText: '删除', danger: true })) { await deleteSchedule(s.id); load(); } }}
      />)}
    </div>
  );
}

function ScheduleCard({ s, tpls, onOpenRoom, onEdit, onToggle, onTrigger, onDelete }: {
  s: MeetingSchedule; tpls: RoomTemplate[]; onOpenRoom?: (id: string) => void;
  onEdit: () => void; onToggle: () => void; onTrigger: () => void; onDelete: () => void;
}) {
  const tn = tpls.find(t => t.id === s.templateId)?.name || s.templateId;
  return (
    <div className="sci-card p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full ${s.enabled ? 'bg-success' : 'bg-text-disabled'}`} />
          <span className="font-medium text-sm text-text truncate">{s.title}</span>
          <span className="text-xs text-text-muted">{tn}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {[
            { icon: s.enabled ? 'pause' : 'play_arrow', fn: onToggle, title: s.enabled ? '暂停' : '启用' },
            { icon: 'rocket_launch', fn: onTrigger, title: '立即触发' },
            { icon: 'edit', fn: onEdit, title: '编辑' },
            { icon: 'delete', fn: onDelete, title: '删除', cls: 'text-danger' },
          ].map(b => (
            <button key={b.icon} type="button" onClick={b.fn} title={b.title}
              className={`h-6 px-2 rounded text-[11px] hover:bg-surface-raised transition-colors ${b.cls || 'text-text-secondary'}`}>
              <span className="material-symbols-outlined text-sm">{b.icon}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-text-muted flex-wrap">
        <span>{s.cronExpr}</span><span>{s.timezone}</span>
        <span>轮次 {s.roundBudget}</span><span>¥{s.budgetCNY}</span>
        {s.autoCloseout && <span className="text-success">自动闭环</span>}
        {s.inheritFromLast && <span className="text-info">继承上次</span>}
      </div>
      {s.lastStatus && (
        <div className="flex items-center gap-3 text-xs flex-wrap">
          <span className={s.lastStatus === 'ok' ? 'text-success' : s.lastStatus === 'error' ? 'text-danger' : 'text-warning'}>
            {s.lastStatus === 'ok' ? '✅' : s.lastStatus === 'error' ? '❌' : '⏳'} {s.lastStatus}
          </span>
          {s.nextRunAt && <span className="text-text-muted">下次: {new Date(s.nextRunAt).toLocaleString()}</span>}
          <span className="text-text-muted">已执行 {s.runCount} 次</span>
          {s.lastRoomId && onOpenRoom && <button type="button" onClick={() => onOpenRoom(s.lastRoomId!)} className="text-info hover:underline">查看房间</button>}
        </div>
      )}
      {s.lastStatus === 'error' && s.lastError && <div className="text-xs text-danger/80 bg-danger/10 rounded p-2 truncate">{s.lastError}</div>}
    </div>
  );
}

function ScheduleForm({ tpls, initial, busy, onSave, onCancel }: {
  tpls: RoomTemplate[]; initial: MeetingSchedule | null; busy: boolean;
  onSave: (d: any) => Promise<void>; onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title || '');
  const [templateId, setTemplateId] = useState(initial?.templateId || tpls[0]?.id || '');
  const [cronExpr, setCronExpr] = useState(initial?.cronExpr || '09:00');
  const [timezone, setTimezone] = useState(initial?.timezone || 'Asia/Shanghai');
  const [prompt, setPrompt] = useState(initial?.initialPrompt || '');
  const [roundBudget, setRoundBudget] = useState(initial?.roundBudget || 12);
  const [budgetCNY, setBudgetCNY] = useState(initial?.budgetCNY || 1.0);
  const [autoCloseout, setAutoCloseout] = useState(initial?.autoCloseout ?? true);
  const [inherit, setInherit] = useState(initial?.inheritFromLast ?? true);

  const valid = title.trim() && templateId && cronExpr.trim();
  const tzOptions = useMemo(() => {
    try {
      const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
      if (typeof fn === 'function') return fn('timeZone');
    } catch { /* noop */ }
    return FALLBACK_TZ;
  }, []);

  const labelCls = 'text-xs font-medium text-text-secondary';
  const inputCls = 'sci-input h-8 px-2 text-sm rounded-lg w-full';

  return (
    <div className="sci-card p-4 flex flex-col gap-3 animate-card-enter">
      <h3 className="text-sm font-semibold text-text">{initial ? '编辑' : '新建'}定时会议</h3>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1"><span className={labelCls}>名称</span>
          <input className={inputCls} value={title} onChange={e => setTitle(e.target.value)} placeholder="每日站会" /></label>
        <label className="flex flex-col gap-1"><span className={labelCls}>模板</span>
          <CustomSelect
            value={templateId}
            onChange={setTemplateId}
            options={tpls.map(t => ({ value: t.id, label: t.name }))}
            className={inputCls}
          /></label>
        <label className="flex flex-col gap-1"><span className={labelCls}>执行时间</span>
          <input className={inputCls} value={cronExpr} onChange={e => setCronExpr(e.target.value)} placeholder="09:00 或 cron" /></label>
        <label className="flex flex-col gap-1"><span className={labelCls}>时区</span>
          <CustomSelect
            value={timezone}
            onChange={setTimezone}
            options={tzOptions.map(z => ({ value: z, label: z }))}
            className={inputCls}
          /></label>
        <label className="flex flex-col gap-1"><span className={labelCls}>轮次上限</span>
          <NumberStepper
            value={roundBudget}
            onChange={v => { const n = parseInt(v, 10); if (!Number.isNaN(n)) setRoundBudget(Math.max(1, Math.min(100, n))); else if (v === '') setRoundBudget(1); }}
            min={1}
            max={100}
            step={1}
            className="h-8"
          /></label>
        <label className="flex flex-col gap-1"><span className={labelCls}>预算 (¥)</span>
          <NumberStepper
            value={budgetCNY}
            onChange={v => { const n = Number(v); if (!Number.isNaN(n)) setBudgetCNY(Math.max(0.1, n)); }}
            min={0.1}
            step={0.1}
            className="h-8"
          /></label>
      </div>
      <label className="flex flex-col gap-1"><span className={labelCls}>初始提示词（可选）</span>
        <textarea className="sci-input px-2 py-1.5 text-sm rounded-lg w-full resize-none" rows={2} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="每次会议开始时注入的 prompt…" /></label>
      <div className="flex items-center gap-4 text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={autoCloseout} onChange={e => setAutoCloseout(e.target.checked)} className="accent-info" />
          <span className="text-text-secondary">自动闭环（轮次到达后自动纪要+复盘+关闭）</span></label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={inherit} onChange={e => setInherit(e.target.checked)} className="accent-info" />
          <span className="text-text-secondary">继承上次会议上下文</span></label>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="h-8 px-4 rounded-lg text-xs text-text-secondary hover:bg-surface-raised">取消</button>
        <button type="button" disabled={!valid || busy} onClick={() => onSave({
          title: title.trim(), templateId, cronExpr: cronExpr.trim(), timezone,
          initialPrompt: prompt.trim() || undefined, roundBudget, budgetCNY,
          autoCloseout, inheritFromLast: inherit, deadlineAction: autoCloseout ? 'closeout' : 'summarize',
        })} className="h-8 px-4 rounded-lg text-xs font-semibold bg-info text-white hover:bg-info/90 disabled:opacity-50">
          {busy ? '保存中…' : initial ? '保存' : '创建'}
        </button>
      </div>
    </div>
  );
}
