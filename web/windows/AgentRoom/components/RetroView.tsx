// RetroView —— v0.7 会议复盘视图
//
// 展示：5 维评分 (bar) + 综合评分 + highlights / lowlights + 摘要 + 下次会议建议。
// 编辑：所有字段均可手动修改（前端编辑 → 保存 → 后端覆盖）；也可一键"重新生成"。
// 下次会议草稿：提供「一键基于此草稿新开房间」按钮。

import React, { useEffect, useMemo, useState } from 'react';
import { useConfirm } from '../../../components/ConfirmDialog';
import type { Retro, NextMeetingDraft, PlaybookHighlightContext } from '../types';
import { createPlaybook, getPlaybookV7, getRetro, regenerateRetro, updatePlaybookV7, updateRetro } from '../service';
import { useBusy } from '../useBusy';
import NumberStepper from '../../../components/NumberStepper';

interface Props {
  roomId: string;
  /** 可选：外部已预加载好的 retro；否则组件自行 fetch。 */
  initialRetro?: Retro | null;
  onStartNextMeeting?: (draft: NextMeetingDraft) => void;
  onOpenPlaybook?: (playbookId: string, context: PlaybookHighlightContext) => void;
}

const DIM: { key: keyof Retro; label: string; tone: string }[] = [
  { key: 'scoreGoal',            label: '目标达成',    tone: 'from-cyan-400 to-cyan-600' },
  { key: 'scoreQuality',         label: '讨论质量',    tone: 'from-indigo-400 to-indigo-600' },
  { key: 'scoreDecisionClarity', label: '决策明确度',  tone: 'from-emerald-400 to-emerald-600' },
  { key: 'scoreEfficiency',      label: '效率',        tone: 'from-amber-400 to-amber-600' },
];

const RetroView: React.FC<Props> = ({ roomId, initialRetro, onStartNextMeeting, onOpenPlaybook }) => {
  const { confirm } = useConfirm();
  const { busy: promotingBusy, run: runPromoting } = useBusy();
  const [retro, setRetro] = useState<Retro | null>(initialRetro ?? null);
  const [loading, setLoading] = useState(!initialRetro);
  const [editing, setEditing] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [saving, setSaving] = useState(false);

  // draft 形态（编辑中）
  const [draft, setDraft] = useState<Retro | null>(null);

  useEffect(() => {
    if (initialRetro !== undefined) {
      setRetro(initialRetro);
      setLoading(false);
      return;
    }
    setLoading(true);
    getRetro(roomId).then(setRetro).finally(() => setLoading(false));
  }, [roomId, initialRetro]);

  const shown = editing ? draft! : retro;

  const startEdit = () => {
    if (!retro) return;
    setDraft(JSON.parse(JSON.stringify(retro)));
    setEditing(true);
  };

  const cancel = () => {
    setDraft(null);
    setEditing(false);
  };

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      const updated = await updateRetro(roomId, {
        scoreOverall: draft.scoreOverall,
        scoreGoal: draft.scoreGoal,
        scoreQuality: draft.scoreQuality,
        scoreDecisionClarity: draft.scoreDecisionClarity,
        scoreEfficiency: draft.scoreEfficiency,
        offTopicRate: draft.offTopicRate,
        highlights: draft.highlights,
        lowlights: draft.lowlights,
        summary: draft.summary,
        nextMeetingDraft: draft.nextMeetingDraft,
      });
      setRetro(updated);
      setEditing(false);
      setDraft(null);
    } finally { setSaving(false); }
  };

  const regenerate = async () => {
    if (regenerating) return;
    // v0.9 复盘重算会整条覆盖当前 Retro（包括用户可能手改过的 highlights/lowlights/
    // nextSteps），并会调用 LLM 烧 tokens。两个理由都值得加确认。
    const ok = await confirm({
      title: '重新生成复盘',
      message: '将由 agent 重新扫描本场会议内容，覆盖当前复盘的摘要、亮点、改进点和下次会议建议。\n\n如果你手动编辑过这些字段，将会被覆盖。这次调用也会消耗 tokens。\n\n确认继续？',
      confirmText: '重新生成',
      cancelText: '取消',
    });
    if (!ok) return;
    setRegenerating(true);
    try {
      const fresh = await regenerateRetro(roomId);
      setRetro(fresh);
    } finally { setRegenerating(false); }
  };

  const promoteToPlaybook = async () => {
    if (!retro || promotingBusy) return;
    const ok = await confirm({
      title: retro.playbookId ? '强化 Playbook' : '生成 Playbook',
      message: retro.playbookId
        ? '将把当前复盘摘要、亮点、改进点和下次会议建议合并进现有 Playbook。确认继续吗？'
        : '将基于当前会议与复盘内容生成一张新的 Playbook，并回写关联关系。确认继续吗？',
      confirmText: retro.playbookId ? '强化' : '生成',
    });
    if (!ok) return;
    await runPromoting(async () => {
      const context: PlaybookHighlightContext = {
        source: 'retro',
        roomId,
        roomTitle: retro.roomTitle,
        playbookId: retro.playbookId,
        summary: retro.summary,
        highlights: retro.highlights || [],
        lowlights: retro.lowlights || [],
        nextAgendaItems: retro.nextMeetingDraft?.agendaItems || [],
        generatedAt: retro.generatedAt,
      };
      if (!retro.playbookId) {
        const created = await createPlaybook({ fromRoomId: roomId, title: `${retro.roomTitle || '会议'}复盘行动手册` });
        const updatedRetro = await updateRetro(roomId, { playbookId: created.id });
        setRetro(updatedRetro);
        onOpenPlaybook?.(created.id, { ...context, playbookId: created.id });
        return;
      }
      const current = await getPlaybookV7(retro.playbookId);
      if (!current) return;
      const retroHighlights = retro.highlights?.filter(Boolean) || [];
      const retroLowlights = retro.lowlights?.filter(Boolean) || [];
      const nextSteps = [
        ...current.steps,
        ...retroHighlights.map((text, idx) => ({ id: `retro-hi-${idx}-${Date.now()}`, text: `保留：${text}` })),
        ...retroLowlights.map((text, idx) => ({ id: `retro-lo-${idx}-${Date.now()}`, text: `避免：${text}` })),
        ...((retro.nextMeetingDraft?.agendaItems || []).filter(Boolean).map((text, idx) => ({ id: `retro-next-${idx}-${Date.now()}`, text: `下次会议：${text}` }))),
      ];
      const mergedConclusion = [
        current.conclusion?.trim(),
        retro.summary?.trim() ? `Retro 摘要：${retro.summary.trim()}` : '',
      ].filter(Boolean).join('\n\n');
      const mergedTags = Array.from(new Set([
        ...(current.tags || []),
        'retro',
        ...(retro.scoreOverall >= 80 ? ['high-score'] : []),
        ...(retro.offTopicRate >= 40 ? ['focus-risk'] : []),
      ]));
      await updatePlaybookV7(current.id, {
        conclusion: mergedConclusion,
        tags: mergedTags,
        steps: nextSteps,
      });
      const refreshedRetro = await updateRetro(roomId, { playbookId: current.id });
      setRetro(refreshedRetro);
      onOpenPlaybook?.(current.id, { ...context, playbookId: current.id });
    });
  };

  const overallColor = useMemo(() => {
    const s = shown?.scoreOverall ?? 0;
    if (s >= 80) return 'text-emerald-500';
    if (s >= 60) return 'text-cyan-500';
    if (s >= 40) return 'text-amber-500';
    return 'text-red-500';
  }, [shown?.scoreOverall]);

  if (loading) return <div className="text-[11px] text-text-muted">加载中…</div>;
  if (!shown) {
    return (
      <div className="px-3 py-6 text-[12px] text-text-muted text-center border border-dashed border-border rounded-lg leading-relaxed">
        尚未生成复盘。关闭会议时会自动生成；也可手动触发。
        <button type="button" onClick={regenerate} disabled={regenerating}
          className="block mx-auto mt-3 h-8 px-4 rounded-md text-[12px] font-semibold bg-cyan-500 hover:bg-cyan-600 text-white disabled:opacity-50">
          {regenerating ? '生成中…' : '生成复盘'}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Overall + 操作
          v0.9.2：右栏很窄时，"圆形分数 + 文字 + 三个竖排按钮"三列会把中间文字挤成每行 2~3 字。
          改为两层布局：
            · 第一层：圆圈 + 文字（横排，文字自然换行）
            · 第二层：操作按钮（横排 flex-wrap，窄屏可换行；不再抢中间列的宽度）
       */}
      <div className="flex flex-col gap-2 p-3 rounded-lg sci-card border border-cyan-500/25 bg-gradient-to-br from-cyan-500/[0.05] via-indigo-500/[0.03] to-transparent">
        <div className="flex items-center gap-3">
          <div className="relative shrink-0">
            {editing ? (
              <NumberStepper
                min={0} max={100} step={1}
                value={String(draft!.scoreOverall)}
                onChange={s => setDraft({ ...draft!, scoreOverall: clamp(parseInt(s) || 0) })}
                className={`w-24 h-16 rounded-full border-2 border-cyan-500/40 ${overallColor}`}
                inputClassName="text-2xl font-bold text-center"
              />
            ) : (
              <div className={`w-16 h-16 rounded-full flex items-center justify-center border-2 border-cyan-500/40 bg-surface font-mono text-2xl font-bold ${overallColor}`}>
                {shown.scoreOverall}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-bold text-text">综合评分</div>
            <div className="text-[11px] text-text-muted leading-snug">
              {shown.scoreOverall >= 80 ? '高效会议 —— 目标达成且过程顺畅' :
               shown.scoreOverall >= 60 ? '基本达标，仍有可优化空间' :
               shown.scoreOverall >= 40 ? '勉强，建议改进会议流程' :
               '效率偏低，建议认真复盘'}
            </div>
            <div className="mt-1 text-[10.5px] text-text-muted leading-snug">
              跑题率 {shown.offTopicRate}% · {new Date(shown.generatedAt).toLocaleString()}
            </div>
            <div className="mt-0.5 text-[10.5px] text-text-muted truncate" title={shown.playbookId || ''}>
              {shown.playbookId ? `已关联 Playbook：${shown.playbookId}` : '尚未关联 Playbook'}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {editing ? (
            <>
              <button type="button" onClick={save} disabled={saving}
                className="h-7 px-3 rounded-md text-[11.5px] font-semibold bg-cyan-500 hover:bg-cyan-600 text-white disabled:opacity-50 inline-flex items-center gap-1">
                <span className="material-symbols-outlined text-[13px]">save</span>
                {saving ? '保存中…' : '保存'}
              </button>
              <button type="button" onClick={cancel}
                className="h-7 px-3 rounded-md text-[11.5px] border border-border text-text-muted hover:bg-surface-sunken">
                取消
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={startEdit}
                className="h-7 px-2.5 rounded-md text-[11.5px] border border-border text-text-muted hover:bg-surface-sunken inline-flex items-center gap-1">
                <span className="material-symbols-outlined text-[13px]">edit</span>
                编辑
              </button>
              <button type="button" onClick={regenerate} disabled={regenerating}
                className="h-7 px-2.5 rounded-md text-[11.5px] font-semibold border border-cyan-500/40 text-cyan-700 dark:text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-50 inline-flex items-center gap-1">
                <span className={`material-symbols-outlined text-[13px] ${regenerating ? 'animate-spin' : ''}`}>refresh</span>
                {regenerating ? '重新生成中…' : '重新生成'}
              </button>
              <button type="button" onClick={promoteToPlaybook} disabled={promotingBusy}
                className="h-7 px-2.5 rounded-md text-[11.5px] font-semibold border border-violet-500/40 text-violet-700 dark:text-violet-200 hover:bg-violet-500/10 disabled:opacity-50 inline-flex items-center gap-1">
                <span className={`material-symbols-outlined text-[13px] ${promotingBusy ? 'animate-spin' : ''}`}>menu_book</span>
                {promotingBusy ? '处理中…' : (shown.playbookId ? '强化 Playbook' : '生成 Playbook')}
              </button>
            </>
          )}
        </div>
      </div>

      {/* 5 维条 */}
      <div className="space-y-1.5">
        {DIM.map(({ key, label, tone }) => {
          const v = shown[key] as number;
          return (
            <div key={String(key)} className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-[11px] text-text-secondary">{label}</span>
              <div className="flex-1 h-6 rounded bg-surface-sunken relative overflow-hidden">
                <div className={`absolute inset-y-0 start-0 bg-gradient-to-r ${tone} rounded transition-all`} style={{ width: `${v}%` }} />
                <div className="absolute inset-0 flex items-center justify-end pe-2 font-mono text-[11px] text-text">{v}</div>
              </div>
              {editing && (
                <NumberStepper
                  min={0} max={100} step={1}
                  value={String(draft![key] as number)}
                  onChange={s => setDraft({ ...draft!, [key]: clamp(parseInt(s) || 0) } as Retro)}
                  className="w-24 h-6"
                />
              )}
            </div>
          );
        })}
        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[11px] text-text-secondary">跑题率</span>
          <div className="flex-1 h-6 rounded bg-surface-sunken relative overflow-hidden">
            <div className="absolute inset-y-0 start-0 bg-gradient-to-r from-rose-400 to-red-500 rounded transition-all" style={{ width: `${shown.offTopicRate}%` }} />
            <div className="absolute inset-0 flex items-center justify-end pe-2 font-mono text-[11px] text-text">{shown.offTopicRate}%</div>
          </div>
          {editing && (
            <NumberStepper
              min={0} max={100} step={1}
              value={String(draft!.offTopicRate)}
              onChange={s => setDraft({ ...draft!, offTopicRate: clamp(parseInt(s) || 0) })}
              className="w-24 h-6"
            />
          )}
        </div>
      </div>

      {/* 执行摘要 */}
      <section>
        <div className="text-[11px] text-text-muted font-semibold mb-1">执行摘要</div>
        {editing ? (
          <textarea value={draft!.summary || ''}
            onChange={e => setDraft({ ...draft!, summary: e.target.value })}
            rows={3}
            className="sci-input w-full p-2 rounded-md text-[12px] bg-surface border border-border resize-y leading-relaxed"
          />
        ) : (
          <div className="text-[12px] text-text-secondary leading-relaxed whitespace-pre-wrap px-2 py-1.5 rounded-md bg-surface-sunken/50">
            {shown.summary || '—'}
          </div>
        )}
      </section>

      {/* Highlights / Lowlights */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <HighLowList title="亮点"   color="emerald" icon="thumb_up"
          items={shown.highlights}
          editing={editing}
          onChange={next => setDraft(d => d ? ({ ...d, highlights: next }) : d)}
        />
        <HighLowList title="改进点" color="rose"    icon="psychology"
          items={shown.lowlights}
          editing={editing}
          onChange={next => setDraft(d => d ? ({ ...d, lowlights: next }) : d)}
        />
      </div>

      {/* 下次会议 */}
      {shown.nextMeetingDraft && (
        <section className="p-3 rounded-lg border border-indigo-500/30 bg-indigo-500/5">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-indigo-700 dark:text-indigo-200 mb-1.5">
            <span className="material-symbols-outlined text-[15px]">event_repeat</span>
            建议的下一次会议
          </div>
          <div className="space-y-1">
            {editing ? (
              <input value={draft!.nextMeetingDraft?.title || ''}
                onChange={e => setDraft({ ...draft!, nextMeetingDraft: { ...(draft!.nextMeetingDraft || emptyDraft()), title: e.target.value } })}
                placeholder="主题"
                className="sci-input w-full h-7 px-2 rounded-md text-[12px] font-semibold bg-surface border border-border"
              />
            ) : (
              <div className="text-[13px] font-semibold text-text">{shown.nextMeetingDraft.title}</div>
            )}
            {editing ? (
              <textarea value={draft!.nextMeetingDraft?.goal || ''}
                onChange={e => setDraft({ ...draft!, nextMeetingDraft: { ...(draft!.nextMeetingDraft || emptyDraft()), goal: e.target.value } })}
                placeholder="目标"
                rows={2}
                className="sci-input w-full p-1.5 rounded-md text-[12px] bg-surface border border-border resize-none"
              />
            ) : shown.nextMeetingDraft.goal ? (
              <div className="text-[11.5px] text-text-secondary">🎯 {shown.nextMeetingDraft.goal}</div>
            ) : null}
            {shown.nextMeetingDraft.agendaItems.length > 0 && (
              <div className="text-[11.5px] text-text-secondary">
                <div className="text-[10.5px] text-text-muted mb-0.5">议程草案：</div>
                <ul className="space-y-0.5">
                  {shown.nextMeetingDraft.agendaItems.map((a, i) => (
                    <li key={i} className="flex items-start gap-1">
                      <span className="text-indigo-400">{i + 1}.</span>
                      <span>{a}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!editing && onStartNextMeeting && (
              <button type="button" onClick={() => onStartNextMeeting(shown.nextMeetingDraft!)}
                className="mt-2 h-7 px-3 rounded-md text-[11.5px] font-semibold bg-indigo-500 hover:bg-indigo-600 text-white inline-flex items-center gap-1">
                <span className="material-symbols-outlined text-[13px]">rocket_launch</span>
                基于此建议开新会议
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
};

// 高亮 / 改进点列表
const HighLowList: React.FC<{
  title: string;
  color: 'emerald' | 'rose';
  icon: string;
  items: string[];
  editing: boolean;
  onChange: (next: string[]) => void;
}> = ({ title, color, icon, items, editing, onChange }) => {
  const [add, setAdd] = useState('');
  const tone = color === 'emerald'
    ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-200'
    : 'border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-200';
  return (
    <div className={`p-2 rounded-md border ${tone}`}>
      <div className="flex items-center gap-1 text-[11.5px] font-semibold mb-1">
        <span className="material-symbols-outlined text-[14px]">{icon}</span>
        {title}
      </div>
      {items.length === 0 && !editing && <div className="text-[11px] text-text-muted">—</div>}
      <ul className="space-y-0.5 text-[11.5px]">
        {items.map((x, i) => (
          <li key={i} className="flex items-start gap-1">
            {editing ? (
              <>
                <input value={x}
                  onChange={e => {
                    const next = [...items];
                    next[i] = e.target.value;
                    onChange(next);
                  }}
                  className="sci-input flex-1 h-6 px-1.5 rounded text-[11.5px] bg-surface border border-border"
                />
                <button type="button" onClick={() => onChange(items.filter((_, ix) => ix !== i))}
                  className="w-6 h-6 rounded hover:bg-danger/10 flex items-center justify-center text-text-muted hover:text-danger">
                  <span className="material-symbols-outlined text-[13px]">close</span>
                </button>
              </>
            ) : (
              <>
                <span className="mt-1 w-1 h-1 rounded-full bg-current shrink-0" />
                <span>{x}</span>
              </>
            )}
          </li>
        ))}
      </ul>
      {editing && (
        <div className="mt-1 flex items-center gap-1">
          <input value={add}
            onChange={e => setAdd(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && add.trim()) {
                onChange([...items, add.trim()]);
                setAdd('');
              }
            }}
            placeholder={`添加${title}…`}
            className="sci-input flex-1 h-6 px-1.5 rounded text-[11.5px] bg-surface border border-border"
          />
          <button type="button" onClick={() => {
            if (add.trim()) { onChange([...items, add.trim()]); setAdd(''); }
          }}
            className="w-6 h-6 rounded bg-surface-sunken hover:bg-surface flex items-center justify-center text-text">
            <span className="material-symbols-outlined text-[13px]">add</span>
          </button>
        </div>
      )}
    </div>
  );
};

const emptyDraft = (): NextMeetingDraft => ({
  title: '', goal: '', agendaItems: [], inviteRoles: [],
});

const clamp = (v: number) => Math.max(0, Math.min(100, v));

export default RetroView;
