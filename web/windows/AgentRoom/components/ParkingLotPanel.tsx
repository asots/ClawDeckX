// ParkingLotPanel —— v0.7 跑题"停车场"面板
//
// 设计心智：讨论跑题时不该假装没听到、也不该全量展开。把想法放在这里，会议结束时
// 统一处理：转任务 / 下次会议议程 / 丢弃。这是收敛会议的关键工具。

import React, { useEffect, useMemo, useState } from 'react';
import type { Member, ParkingLotItem, ParkingResolution } from '../types';
import {
  listParking, createParkingItem, updateParkingItem, deleteParkingItem, roomEvents,
} from '../service';

interface Props {
  roomId: string;
  members: Map<string, Member>;
}

const RESOLUTION_META: Record<ParkingResolution, { label: string; tone: string; icon: string }> = {
  pending:         { label: '待处理',     tone: 'border-slate-400/40 bg-slate-500/5 text-text-muted',                              icon: 'pending' },
  task:            { label: '转任务',     tone: 'border-cyan-500/40 bg-cyan-500/5 text-cyan-600 dark:text-cyan-300',                icon: 'check_box' },
  'next-meeting':  { label: '下次议题',   tone: 'border-indigo-500/40 bg-indigo-500/5 text-indigo-600 dark:text-indigo-300',        icon: 'event_repeat' },
  discarded:       { label: '已丢弃',     tone: 'border-red-500/40 bg-red-500/5 text-red-600 dark:text-red-300 opacity-60',          icon: 'delete' },
};

const ParkingLotPanel: React.FC<Props> = ({ roomId }) => {
  const [items, setItems] = useState<ParkingLotItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setLoading(true);
    listParking(roomId).then(setItems).finally(() => setLoading(false));
  }, [roomId]);

  useEffect(() => {
    const off1 = roomEvents.on('room.parking.append' as any, (ev: any) => {
      if (ev?.roomId === roomId && ev.item) {
        setItems(prev => prev.some(x => x.id === ev.item.id) ? prev : [ev.item, ...prev]);
      }
    });
    const off2 = roomEvents.on('room.parking.update' as any, (ev: any) => {
      if (ev?.roomId === roomId && ev.patch) {
        setItems(prev => prev.map(x => x.id === ev.itemId ? { ...x, ...ev.patch } : x));
      }
    });
    const off3 = roomEvents.on('room.parking.delete' as any, (ev: any) => {
      if (ev?.roomId === roomId) setItems(prev => prev.filter(x => x.id !== ev.itemId));
    });
    return () => { off1?.(); off2?.(); off3?.(); };
  }, [roomId]);

  const add = async () => {
    const t = text.trim();
    if (!t || submitting) return;
    setSubmitting(true);
    try {
      const it = await createParkingItem(roomId, t);
      setItems(prev => prev.some(x => x.id === it.id) ? prev : [it, ...prev]);
      setText('');
    } finally { setSubmitting(false); }
  };

  const setResolution = async (id: string, resolution: ParkingResolution) => {
    setItems(prev => prev.map(x => x.id === id ? { ...x, resolution } : x));
    try { await updateParkingItem(id, { resolution }); } catch { /* WS 兜底 */ }
  };

  const remove = async (id: string) => {
    setItems(prev => prev.filter(x => x.id !== id));
    try { await deleteParkingItem(id); } catch { /* WS 兜底 */ }
  };
  const summary = useMemo(() => ({
    pending: items.filter(x => x.resolution === 'pending').length,
    task: items.filter(x => x.resolution === 'task').length,
    nextMeeting: items.filter(x => x.resolution === 'next-meeting').length,
  }), [items]);

  return (
    <div className="flex flex-col gap-2">
      {items.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5 text-[10.5px]">
          <div className="rounded-md border border-slate-400/25 bg-slate-500/5 px-2 py-1.5">
            <div className="text-text-muted">待处理</div>
            <div className="font-bold text-text">{summary.pending}</div>
          </div>
          <div className="rounded-md border border-cyan-500/25 bg-cyan-500/5 px-2 py-1.5">
            <div className="text-text-muted">转任务</div>
            <div className="font-bold text-cyan-700 dark:text-cyan-300">{summary.task}</div>
          </div>
          <div className="rounded-md border border-indigo-500/25 bg-indigo-500/5 px-2 py-1.5">
            <div className="text-text-muted">下次会议</div>
            <div className="font-bold text-indigo-700 dark:text-indigo-300">{summary.nextMeeting}</div>
          </div>
        </div>
      )}
      <div className="flex items-stretch gap-1.5">
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') add(); }}
          placeholder="一句话记下跑题的想法，稍后一起处理…"
          className="sci-input flex-1 min-w-0 h-7 px-2 rounded-md text-[11.5px] bg-surface border border-border"
          disabled={submitting}
        />
        <button
          type="button"
          onClick={add}
          disabled={!text.trim() || submitting}
          className="h-7 px-2.5 rounded-md text-[11.5px] font-semibold bg-indigo-500 hover:bg-indigo-600 text-white transition disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-[14px]">local_parking</span>
          停车
        </button>
      </div>

      {loading ? (
        <div className="text-[11px] text-text-muted">加载中…</div>
      ) : items.length === 0 ? (
        <div className="px-2 py-3 text-[11px] text-text-muted text-center border border-dashed border-border rounded-md leading-relaxed">
          空。讨论跑题时别硬拽回来 —— 先停在这里，会议结束前集体处理。
        </div>
      ) : (
        <ul className="space-y-1.5">
          {items.map(it => {
            const meta = RESOLUTION_META[it.resolution];
            return (
              <li key={it.id}
                className={`group flex items-start gap-2 px-2 py-1.5 rounded-md border ${meta.tone} transition`}
              >
                <span className="material-symbols-outlined text-[14px] mt-0.5 shrink-0">{meta.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className={`text-[12px] text-text leading-snug ${it.resolution === 'discarded' ? 'line-through' : ''}`}>
                    {it.text}
                  </div>
                  <div className="mt-0.5 flex items-center flex-wrap gap-1.5 text-[10px] text-text-muted">
                    <span className={`px-1.5 py-[1px] rounded text-[10px] font-mono ${meta.tone}`}>{meta.label}</span>
                    <span className="font-mono">{new Date(it.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition shrink-0">
                  {it.resolution !== 'task' && (
                    <button type="button" onClick={() => setResolution(it.id, 'task')}
                      className="w-6 h-6 rounded hover:bg-cyan-500/15 flex items-center justify-center text-text-muted hover:text-cyan-500"
                      title="转任务"><span className="material-symbols-outlined text-[14px]">check_box</span></button>
                  )}
                  {it.resolution !== 'next-meeting' && (
                    <button type="button" onClick={() => setResolution(it.id, 'next-meeting')}
                      className="w-6 h-6 rounded hover:bg-indigo-500/15 flex items-center justify-center text-text-muted hover:text-indigo-500"
                      title="下次会议再议"><span className="material-symbols-outlined text-[14px]">event_repeat</span></button>
                  )}
                  {it.resolution !== 'discarded' && (
                    <button type="button" onClick={() => setResolution(it.id, 'discarded')}
                      className="w-6 h-6 rounded hover:bg-red-500/15 flex items-center justify-center text-text-muted hover:text-red-500"
                      title="丢弃"><span className="material-symbols-outlined text-[14px]">delete</span></button>
                  )}
                  <button type="button" onClick={() => remove(it.id)}
                    className="w-6 h-6 rounded hover:bg-danger/10 flex items-center justify-center text-text-muted hover:text-danger"
                    title="移除"><span className="material-symbols-outlined text-[14px]">close</span></button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default ParkingLotPanel;
