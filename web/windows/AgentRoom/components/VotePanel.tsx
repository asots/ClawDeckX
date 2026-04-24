// VotePanel —— v0.7 投票面板
//
// 支持：
//   - 发起投票：题目 + 2~6 选项 + 模式（过半 / 全票）
//   - 投票：人类 / agent（每人一票，重投覆盖）
//   - 实时显示得票条；关票后显示结果
//   - 投票关联议程项（可选）
//
// UX：投票是"达成共识"的硬工具，所以给强视觉：紫色系 + 进度条 + 关票状态。

import React, { useEffect, useMemo, useState } from 'react';
import type { Member, Vote, VoteMode, AgendaItem } from '../types';
import {
  listVotes, createVote, castBallot, tallyVote, deleteVote, roomEvents,
} from '../service';
import CustomSelect from '../../../components/CustomSelect';

interface Props {
  roomId: string;
  meId: string;
  members: Map<string, Member>;
  activeAgendaItem?: AgendaItem | null;
}

const MODE_LABEL: Record<VoteMode, string> = {
  majority:  '过半数',
  unanimous: '一致通过',
};

const VotePanel: React.FC<Props> = ({ roomId, meId, members, activeAgendaItem }) => {
  const [items, setItems] = useState<Vote[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setLoading(true);
    listVotes(roomId).then(setItems).finally(() => setLoading(false));
  }, [roomId]);

  useEffect(() => {
    const off1 = roomEvents.on('room.vote.append' as any, (ev: any) => {
      if (ev?.roomId === roomId && ev.vote) {
        setItems(prev => prev.some(x => x.id === ev.vote.id) ? prev : [ev.vote, ...prev]);
      }
    });
    const off2 = roomEvents.on('room.vote.update' as any, (ev: any) => {
      if (ev?.roomId === roomId) {
        setItems(prev => prev.map(x => x.id === ev.voteId
          ? (ev.vote ? ev.vote : ev.ballots ? { ...x, ballots: ev.ballots } : x)
          : x));
      }
    });
    const off3 = roomEvents.on('room.vote.delete' as any, (ev: any) => {
      if (ev?.roomId === roomId) setItems(prev => prev.filter(x => x.id !== ev.voteId));
    });
    return () => { off1?.(); off2?.(); off3?.(); };
  }, [roomId]);

  const sorted = useMemo(
    () => [...items].sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.createdAt - a.createdAt),
    [items],
  );
  const summary = useMemo(() => ({
    open: items.filter(v => v.status === 'open').length,
    closed: items.filter(v => v.status === 'closed').length,
    totalBallots: items.reduce((sum, v) => sum + v.ballots.length, 0),
  }), [items]);

  const refresh = async () => {
    const fresh = await listVotes(roomId);
    setItems(fresh);
  };

  return (
    <div className="flex flex-col gap-2">
      {items.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5 text-[10.5px]">
          <div className="rounded-md border border-purple-500/25 bg-purple-500/5 px-2 py-1.5">
            <div className="text-text-muted">进行中</div>
            <div className="font-bold text-purple-700 dark:text-purple-300">{summary.open}</div>
          </div>
          <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2 py-1.5">
            <div className="text-text-muted">已结束</div>
            <div className="font-bold text-emerald-700 dark:text-emerald-300">{summary.closed}</div>
          </div>
          <div className="rounded-md border border-slate-400/25 bg-slate-500/5 px-2 py-1.5">
            <div className="text-text-muted">总票数</div>
            <div className="font-bold text-text">{summary.totalBallots}</div>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="w-full h-7 px-3 rounded-md text-[11.5px] font-semibold bg-gradient-to-r from-purple-500 to-fuchsia-500 hover:from-purple-600 hover:to-fuchsia-600 text-white transition inline-flex items-center justify-center gap-1"
      >
        <span className="material-symbols-outlined text-[14px]">how_to_vote</span>
        发起投票
      </button>

      {creating && (
        <CreateVoteForm
          roomId={roomId}
          members={members}
          agendaItem={activeAgendaItem || null}
          onClose={() => setCreating(false)}
          onCreated={async v => {
            setItems(prev => prev.some(x => x.id === v.id) ? prev : [v, ...prev]);
            setCreating(false);
          }}
        />
      )}

      {loading ? (
        <div className="text-[11px] text-text-muted">加载中…</div>
      ) : sorted.length === 0 && !creating ? (
        <div className="px-2 py-3 text-[11px] text-text-muted text-center border border-dashed border-border rounded-md leading-relaxed">
          没有进行中的投票。讨论分歧收敛时，用投票替代"谁嗓门大谁赢"。
        </div>
      ) : (
        <ul className="space-y-2">
          {sorted.map(v => (
            <VoteCard key={v.id} vote={v} meId={meId} members={members} onRefresh={refresh} />
          ))}
        </ul>
      )}
    </div>
  );
};

// ─── 创建投票表单 ───
const CreateVoteForm: React.FC<{
  roomId: string;
  members: Map<string, Member>;
  agendaItem: AgendaItem | null;
  onClose: () => void;
  onCreated: (v: Vote) => void;
}> = ({ roomId, members, agendaItem, onClose, onCreated }) => {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [mode, setMode] = useState<VoteMode>('majority');
  const [voterIds, setVoterIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = question.trim().length > 0
    && options.filter(o => o.trim()).length >= 2
    && !submitting;

  const addOption = () => {
    if (options.length >= 6) return;
    setOptions([...options, '']);
  };

  const removeOption = (i: number) => {
    if (options.length <= 2) return;
    setOptions(options.filter((_, ix) => ix !== i));
  };

  const toggleVoter = (mid: string) => {
    setVoterIds(prev => prev.includes(mid) ? prev.filter(x => x !== mid) : [...prev, mid]);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const v = await createVote(roomId, {
        question: question.trim(),
        options: options.map(o => o.trim()).filter(Boolean),
        mode,
        voterIds: voterIds.length > 0 ? voterIds : undefined,
        agendaItemId: agendaItem?.id,
      });
      onCreated(v);
    } finally { setSubmitting(false); }
  };

  const eligibleMembers = Array.from(members.values()).filter(m => !m.isKicked && !m.isMuted);

  return (
    <div className="sci-card p-3 rounded-lg border border-purple-500/30 bg-purple-500/5 space-y-2.5 animate-card-enter">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-purple-600 dark:text-purple-300">
        <span className="material-symbols-outlined text-[15px]">how_to_vote</span>
        发起投票
        {agendaItem && (
          <span className="ms-auto text-[10px] font-normal text-text-muted truncate max-w-[140px]">
            关联议程：{agendaItem.title}
          </span>
        )}
      </div>

      <textarea
        value={question}
        onChange={e => setQuestion(e.target.value)}
        placeholder="投什么？（如：本季度主推方向）"
        rows={2}
        className="sci-input w-full px-2 py-1.5 rounded-md text-[12px] bg-surface border border-border resize-none"
      />

      <div className="space-y-1">
        <div className="text-[11px] text-text-muted">选项（至少 2 个，最多 6 个）</div>
        {options.map((o, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-5 h-5 rounded-full bg-purple-500/20 flex items-center justify-center text-[10px] font-mono shrink-0">{i + 1}</span>
            <input
              value={o}
              onChange={e => { const n = [...options]; n[i] = e.target.value; setOptions(n); }}
              placeholder={`选项 ${i + 1}`}
              className="sci-input flex-1 h-7 px-2 rounded-md text-[12px] bg-surface border border-border"
            />
            {options.length > 2 && (
              <button type="button" onClick={() => removeOption(i)}
                className="w-7 h-7 rounded hover:bg-danger/10 flex items-center justify-center text-text-muted hover:text-danger">
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            )}
          </div>
        ))}
        {options.length < 6 && (
          <button type="button" onClick={addOption}
            className="h-7 px-2 rounded border border-dashed border-border text-[11px] text-text-muted hover:bg-surface-sunken inline-flex items-center gap-1">
            <span className="material-symbols-outlined text-[13px]">add</span> 添加选项
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[11px] text-text-muted">模式</span>
        <div className="w-28">
          <CustomSelect
            value={mode}
            onChange={v => setMode(v as VoteMode)}
            options={[
              { value: 'majority', label: MODE_LABEL.majority },
              { value: 'unanimous', label: MODE_LABEL.unanimous },
            ]}
            className="h-7 px-2 rounded text-[11.5px] bg-surface border border-border"
          />
        </div>
      </div>

      {eligibleMembers.length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-text-muted hover:text-text select-none">
            投票权限（留空 = 所有 agent + 主持）
          </summary>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {eligibleMembers.map(m => {
              const on = voterIds.includes(m.id);
              return (
                <button type="button" key={m.id} onClick={() => toggleVoter(m.id)}
                  className={`h-6 px-2 rounded-full border text-[11px] transition ${
                    on ? 'bg-purple-500/20 border-purple-500/50 text-purple-700 dark:text-purple-200'
                       : 'border-border text-text-muted hover:bg-surface-sunken'
                  }`}>
                  {on ? '✓ ' : ''}{m.name}
                </button>
              );
            })}
          </div>
        </details>
      )}

      <div className="flex justify-end gap-1.5 pt-1">
        <button type="button" onClick={onClose}
          className="h-7 px-3 rounded-md text-[11.5px] border border-border text-text-muted hover:bg-surface-sunken">
          取消
        </button>
        <button type="button" onClick={submit} disabled={!canSubmit}
          className="h-7 px-3 rounded-md text-[11.5px] font-semibold bg-gradient-to-r from-purple-500 to-fuchsia-500 hover:from-purple-600 hover:to-fuchsia-600 text-white disabled:opacity-50 disabled:cursor-not-allowed">
          {submitting ? '创建中…' : '开启投票'}
        </button>
      </div>
    </div>
  );
};

// ─── 单个投票卡片 ───
const VoteCard: React.FC<{
  vote: Vote;
  meId: string;
  members: Map<string, Member>;
  onRefresh: () => void;
}> = ({ vote, meId, members, onRefresh }) => {
  const [busy, setBusy] = useState(false);

  const totalVotes = vote.ballots.length;
  const counts: Record<string, number> = {};
  for (const b of vote.ballots) counts[b.choice] = (counts[b.choice] || 0) + 1;
  const myBallot = vote.ballots.find(b => b.voterId === meId || b.voterId.startsWith('human-'));

  const canVote = vote.status === 'open' && (
    vote.voterIds.length === 0 || vote.voterIds.includes(meId) || vote.voterIds.some(v => v.startsWith('human-'))
  );

  const cast = async (choice: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await castBallot(vote.id, choice);
      await onRefresh();
    } finally { setBusy(false); }
  };

  const tally = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await tallyVote(vote.id);
      await onRefresh();
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (busy) return;
    if (!confirm('删除这次投票？')) return;
    setBusy(true);
    try {
      await deleteVote(vote.id);
      await onRefresh();
    } finally { setBusy(false); }
  };

  const initiatorName = vote.initiatorId
    ? (vote.initiatorId.startsWith('human-') ? '你' : members.get(vote.initiatorId)?.name || vote.initiatorId)
    : '';

  return (
    <li className="sci-card p-2.5 rounded-lg border border-purple-500/25 bg-gradient-to-b from-purple-500/[0.04] to-transparent">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-text leading-snug">{vote.question}</div>
          <div className="mt-0.5 flex items-center flex-wrap gap-1.5 text-[10px] text-text-muted">
            <span className={`px-1.5 py-[1px] rounded font-mono ${
              vote.status === 'open' ? 'bg-purple-500/20 text-purple-700 dark:text-purple-200' : 'bg-slate-500/20 text-text-muted'
            }`}>
              {vote.status === 'open' ? '进行中' : '已关闭'}
            </span>
            <span>{MODE_LABEL[vote.mode]}</span>
            <span>·</span>
            <span>{totalVotes} 票</span>
            {initiatorName && <><span>·</span><span>@{initiatorName}</span></>}
          </div>
        </div>
        <button type="button" onClick={remove} disabled={busy}
          className="w-6 h-6 rounded hover:bg-danger/10 flex items-center justify-center text-text-muted hover:text-danger opacity-0 group-hover:opacity-100 transition shrink-0"
          title="删除">
          <span className="material-symbols-outlined text-[14px]">close</span>
        </button>
      </div>

      {/* 选项列表 */}
      <div className="mt-2 space-y-1">
        {vote.options.map(opt => {
          const cnt = counts[opt] || 0;
          const pct = totalVotes > 0 ? (cnt / totalVotes) * 100 : 0;
          const chosen = myBallot?.choice === opt;
          const winner = vote.status === 'closed' && vote.result && vote.result.split(' / ').includes(opt);
          return (
            <button
              key={opt}
              type="button"
              disabled={!canVote || busy || vote.status === 'closed'}
              onClick={() => canVote && cast(opt)}
              className={`w-full text-left relative h-8 px-2.5 rounded-md border transition overflow-hidden disabled:cursor-default ${
                winner ? 'border-emerald-500/50 bg-emerald-500/10' :
                chosen ? 'border-purple-500/50 bg-purple-500/10' :
                'border-border bg-surface hover:bg-surface-sunken'
              }`}
            >
              <div
                className={`absolute inset-y-0 start-0 ${
                  winner ? 'bg-emerald-500/15' : chosen ? 'bg-purple-500/15' : 'bg-surface-sunken'
                } transition-all`}
                style={{ width: `${pct}%` }}
              />
              <div className="relative flex items-center gap-2 h-full text-[12px]">
                <span className={`${chosen ? 'font-semibold text-purple-700 dark:text-purple-200' : 'text-text'} truncate`}>
                  {chosen && '✓ '}{winner && !chosen && '🏆 '}{opt}
                </span>
                <span className="ms-auto font-mono text-[11px] text-text-muted shrink-0">
                  {cnt} · {pct.toFixed(0)}%
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* 关票按钮 / 结果 */}
      {vote.status === 'open' ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[10.5px] text-text-muted">
            {canVote ? '点选项投票 · 可改票' : '你没有本次投票权限'}
          </span>
          <button type="button" onClick={tally} disabled={busy || totalVotes === 0}
            className="h-7 px-3 rounded-md text-[11.5px] font-semibold border border-purple-500/40 text-purple-700 dark:text-purple-200 hover:bg-purple-500/10 disabled:opacity-50">
            关票并计票
          </button>
        </div>
      ) : (
        <div className="mt-2 px-2 py-1.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-[11.5px] text-emerald-700 dark:text-emerald-200 font-semibold">
          ✅ 结果：{vote.result || '（无人投票）'}
        </div>
      )}
    </li>
  );
};

export default VotePanel;
