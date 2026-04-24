// RisksPanel —— v0.7 风险登记面板
//
// 把讨论中识别的"可能出问题"条目结构化登记：严重程度 + 负责人 + 状态。
// 会议结束生成 OutcomeBundle 时会打包进去，以便会后跟进。

import React, { useEffect, useMemo, useState } from 'react';
import type { Member, Risk, RiskSeverity, RiskStatus } from '../types';
import {
  listRisks, createRisk, updateRisk, deleteRisk, roomEvents,
  extractRisks,
} from '../service';
import CustomSelect from '../../../components/CustomSelect';
import { useConfirm } from '../../../components/ConfirmDialog';

interface Props {
  roomId: string;
  members: Map<string, Member>;
}

const SEVERITY_META: Record<RiskSeverity, { label: string; tone: string; icon: string }> = {
  high: { label: '高',   tone: 'border-red-500/40 bg-red-500/5 text-red-600 dark:text-red-300',           icon: 'error' },
  mid:  { label: '中',   tone: 'border-amber-500/40 bg-amber-500/5 text-amber-600 dark:text-amber-300',   icon: 'warning' },
  low:  { label: '低',   tone: 'border-slate-400/40 bg-slate-500/5 text-text-muted',                        icon: 'info' },
};

const STATUS_META: Record<RiskStatus, { label: string; tone: string }> = {
  open:      { label: '开放',     tone: 'border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-300' },
  mitigated: { label: '已缓解',   tone: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-300' },
  accepted:  { label: '接受',     tone: 'border-slate-400/30 bg-slate-500/5 text-text-muted' },
};

const RisksPanel: React.FC<Props> = ({ roomId, members }) => {
  const { confirm } = useConfirm();
  const [items, setItems] = useState<Risk[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [severity, setSeverity] = useState<RiskSeverity>('mid');
  const [submitting, setSubmitting] = useState(false);
  // v0.9 一键抽取状态
  const [extracting, setExtracting] = useState(false);

  useEffect(() => {
    setLoading(true);
    listRisks(roomId).then(setItems).finally(() => setLoading(false));
  }, [roomId]);

  useEffect(() => {
    const off1 = roomEvents.on('room.risk.append' as any, (ev: any) => {
      if (ev?.roomId === roomId && ev.risk) {
        setItems(prev => prev.some(x => x.id === ev.risk.id) ? prev : [ev.risk, ...prev]);
      }
    });
    const off2 = roomEvents.on('room.risk.update' as any, (ev: any) => {
      if (ev?.roomId === roomId && ev.patch) {
        setItems(prev => prev.map(x => x.id === ev.riskId ? { ...x, ...ev.patch } : x));
      }
    });
    const off3 = roomEvents.on('room.risk.delete' as any, (ev: any) => {
      if (ev?.roomId === roomId) setItems(prev => prev.filter(x => x.id !== ev.riskId));
    });
    return () => { off1?.(); off2?.(); off3?.(); };
  }, [roomId]);

  const add = async () => {
    const t = text.trim();
    if (!t || submitting) return;
    setSubmitting(true);
    try {
      const r = await createRisk(roomId, { text: t, severity });
      setItems(prev => prev.some(x => x.id === r.id) ? prev : [r, ...prev]);
      setText('');
      setSeverity('mid');
    } finally { setSubmitting(false); }
  };

  const setStatus = async (id: string, status: RiskStatus) => {
    setItems(prev => prev.map(x => x.id === id ? { ...x, status } : x));
    try { await updateRisk(id, { status }); } catch { /* WS 兜底 */ }
  };

  const setOwner = async (id: string, ownerId: string) => {
    setItems(prev => prev.map(x => x.id === id ? { ...x, ownerId } : x));
    try { await updateRisk(id, { ownerId }); } catch { /* WS 兜底 */ }
  };

  const remove = async (id: string) => {
    setItems(prev => prev.filter(x => x.id !== id));
    try { await deleteRisk(id); } catch { /* WS 兜底 */ }
  };

  // v0.9 让 AI 从近 60 条讨论里扰出风险。
  //   先弹确认框避免误触 —— 这会触发 LLM 调用（耗 token/时间），不该即点即执行。
  //   返回后后端会逐条广播 room.risk.append，列表通过 WS 自动加新，
  //   不在这里手动合并避免重复。
  const extract = async () => {
    if (extracting) return;
    const ok = await confirm({
      title: '从讨论里抽取风险',
      message: '将由主持 agent（或第一个存活 agent）扫描最近 60 条消息，最多产出 6 条风险。\n\n这次调用会消耗 tokens，请确认继续。',
      confirmText: '抽取',
      cancelText: '取消',
    });
    if (!ok) return;
    setExtracting(true);
    try { await extractRisks(roomId); } catch { /* toast 由 withToast 发 */ }
    finally { setExtracting(false); }
  };

  const sorted = useMemo(() => {
    const order: Record<RiskSeverity, number> = { high: 0, mid: 1, low: 2 };
    return [...items].sort((a, b) => (order[a.severity] - order[b.severity]) || b.createdAt - a.createdAt);
  }, [items]);
  const riskSummary = useMemo(() => ({
    open: items.filter(r => r.status === 'open').length,
    mitigated: items.filter(r => r.status === 'mitigated').length,
    high: items.filter(r => r.severity === 'high' && r.status === 'open').length,
  }), [items]);

  const memberOptions = useMemo(() => [
    { value: '', label: '未分配' },
    ...Array.from(members.values())
      .filter(m => !m.isKicked)
      .map(m => ({ value: m.id, label: m.name })),
  ], [members]);

  const severityOptions = [
    { value: 'high', label: '高' },
    { value: 'mid',  label: '中' },
    { value: 'low',  label: '低' },
  ];

  return (
    <div className="flex flex-col gap-2">
      {items.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5 text-[10.5px]">
          <div className="rounded-md border border-red-500/25 bg-red-500/5 px-2 py-1.5">
            <div className="text-text-muted">开放风险</div>
            <div className="font-bold text-red-600 dark:text-red-300">{riskSummary.open}</div>
          </div>
          <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-2 py-1.5">
            <div className="text-text-muted">高风险</div>
            <div className="font-bold text-amber-600 dark:text-amber-300">{riskSummary.high}</div>
          </div>
          <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2 py-1.5">
            <div className="text-text-muted">已缓解</div>
            <div className="font-bold text-emerald-600 dark:text-emerald-300">{riskSummary.mitigated}</div>
          </div>
        </div>
      )}
      {/* 新增 */}
      <div className="flex flex-wrap items-stretch gap-1.5">
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') add(); }}
          placeholder="描述一个风险或阻塞…"
          className="sci-input flex-1 min-w-[180px] h-7 px-2 rounded-md text-[11.5px] bg-surface border border-border"
          disabled={submitting}
        />
        <div className="w-20">
          <CustomSelect
            value={severity}
            onChange={v => setSeverity(v as RiskSeverity)}
            options={severityOptions}
            className="h-7 px-2 rounded-md text-[11.5px] bg-surface border border-border"
          />
        </div>
        <button
          type="button"
          onClick={add}
          disabled={!text.trim() || submitting}
          className="h-7 px-2.5 rounded-md text-[11.5px] font-semibold bg-red-500 hover:bg-red-600 text-white transition disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-[14px]">warning</span>
          登记
        </button>
      </div>

      {/* v0.9 一键从讨论抽取风险 */}
      <button
        type="button"
        onClick={extract}
        disabled={extracting}
        className="self-start h-7 px-2.5 rounded-md text-[11.5px] font-semibold bg-surface hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-300 border border-border text-text-secondary transition disabled:opacity-50 disabled:cursor-wait inline-flex items-center gap-1"
        title="让 AI 从最近讨论里扰出可能导致目标失败的风险"
      >
        <span className={`material-symbols-outlined text-[14px] ${extracting ? 'animate-spin' : ''}`}>
          {extracting ? 'progress_activity' : 'auto_awesome'}
        </span>
        {extracting ? '抽取中…' : '从讨论里抽取'}
      </button>

      {loading ? (
        <div className="text-[11px] text-text-muted">加载中…</div>
      ) : sorted.length === 0 ? (
        <div className="px-2 py-3 text-[11px] text-text-muted text-center border border-dashed border-border rounded-md leading-relaxed">
          没有已登记风险。讨论里听到「如果……可能……」时，就该记在这里。
        </div>
      ) : (
        <ul className="space-y-1.5">
          {sorted.map(r => {
            const sMeta = SEVERITY_META[r.severity];
            const stMeta = STATUS_META[r.status];
            const owner = r.ownerId ? members.get(r.ownerId)?.name || r.ownerId : '';
            return (
              <li key={r.id}
                className={`group flex items-start gap-2 px-2 py-1.5 rounded-md border ${sMeta.tone} ${r.status === 'mitigated' ? 'opacity-75' : ''} transition`}
              >
                <span className="material-symbols-outlined text-[14px] mt-0.5 shrink-0">{sMeta.icon}</span>
                <div className="flex-1 min-w-0 space-y-1">
                  <div className={`text-[12px] text-text leading-snug ${r.status === 'mitigated' ? 'line-through decoration-1 decoration-text-muted' : ''}`}>
                    {r.text}
                  </div>
                  <div className="flex items-center flex-wrap gap-1.5 text-[10px] text-text-muted">
                    <span className={`px-1.5 py-[1px] rounded text-[10px] font-mono border ${sMeta.tone}`}>{sMeta.label}</span>
                    <span className={`px-1.5 py-[1px] rounded text-[10px] font-mono border ${stMeta.tone}`}>{stMeta.label}</span>
                    {owner && <span>@{owner}</span>}
                    <span className="font-mono">{new Date(r.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="flex items-center flex-wrap gap-1 pt-0.5" onClick={e => e.stopPropagation()}>
                    <div className="min-w-0 w-32">
                      <CustomSelect
                        value={r.ownerId || ''}
                        onChange={v => setOwner(r.id, v)}
                        options={memberOptions}
                        placeholder="未分配"
                        className="h-6 px-1.5 rounded text-[11px] bg-surface/60 border border-border"
                      />
                    </div>
                    {r.status !== 'mitigated' && (
                      <button type="button" onClick={() => setStatus(r.id, 'mitigated')}
                        className="h-6 px-2 rounded text-[11px] border border-emerald-500/30 text-emerald-600 dark:text-emerald-300 hover:bg-emerald-500/10">
                        已缓解
                      </button>
                    )}
                    {r.status !== 'accepted' && r.status !== 'mitigated' && (
                      <button type="button" onClick={() => setStatus(r.id, 'accepted')}
                        className="h-6 px-2 rounded text-[11px] border border-border text-text-muted hover:bg-surface-sunken">
                        接受
                      </button>
                    )}
                    {r.status !== 'open' && (
                      <button type="button" onClick={() => setStatus(r.id, 'open')}
                        className="h-6 px-2 rounded text-[11px] border border-red-500/30 text-red-600 dark:text-red-300 hover:bg-red-500/10">
                        重开
                      </button>
                    )}
                  </div>
                </div>
                <button type="button" onClick={() => remove(r.id)}
                  className="w-6 h-6 rounded hover:bg-danger/10 flex items-center justify-center text-text-muted hover:text-danger opacity-0 group-hover:opacity-100 transition shrink-0"
                  title="删除">
                  <span className="material-symbols-outlined text-[14px]">close</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default RisksPanel;
