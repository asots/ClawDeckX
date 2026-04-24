// QuestionsPanel —— v0.7 未决问题（Open Questions）面板
//
// 用途：记录讨论中出现但还没有答案的问题。比直接在聊天里发问更结构化，避免
// 后面几十条消息把问题冲掉没人回答。每条可以绑定议程项、可标记 answered/deferred。

import React, { useEffect, useState } from 'react';
import type { Member, OpenQuestion, OpenQuestionStatus } from '../types';
import {
  listQuestions, createQuestion, updateQuestion, deleteQuestion, roomEvents,
  extractQuestions,
} from '../service';
import { useConfirm } from '../../../components/ConfirmDialog';

interface Props {
  roomId: string;
  members: Map<string, Member>;
  activeAgendaItemId?: string;
  onJump?: (messageId: string) => void;
}

const STATUS_META: Record<OpenQuestionStatus, { label: string; tone: string }> = {
  open:     { label: '未答', tone: 'border-amber-500/40 bg-amber-500/5 text-amber-600 dark:text-amber-300' },
  answered: { label: '已答', tone: 'border-emerald-500/40 bg-emerald-500/5 text-emerald-600 dark:text-emerald-300' },
  deferred: { label: '延后', tone: 'border-slate-400/40 bg-slate-500/5 text-text-muted' },
};

const QuestionsPanel: React.FC<Props> = ({ roomId, members, activeAgendaItemId, onJump }) => {
  const { confirm } = useConfirm();
  const [items, setItems] = useState<OpenQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // v0.9 一键抽取状态（LLM 扫近 60 条消息输出 JSON）
  const [extracting, setExtracting] = useState(false);

  useEffect(() => {
    setLoading(true);
    listQuestions(roomId).then(setItems).finally(() => setLoading(false));
  }, [roomId]);

  // WS：增/改/删
  useEffect(() => {
    const off1 = roomEvents.on('room.question.append' as any, (ev: any) => {
      if (ev?.roomId === roomId && ev.question) {
        setItems(prev => prev.some(x => x.id === ev.question.id) ? prev : [ev.question, ...prev]);
      }
    });
    const off2 = roomEvents.on('room.question.update' as any, (ev: any) => {
      if (ev?.roomId === roomId && ev.patch) {
        setItems(prev => prev.map(x => x.id === ev.questionId ? { ...x, ...ev.patch } : x));
      }
    });
    const off3 = roomEvents.on('room.question.delete' as any, (ev: any) => {
      if (ev?.roomId === roomId) {
        setItems(prev => prev.filter(x => x.id !== ev.questionId));
      }
    });
    return () => { off1?.(); off2?.(); off3?.(); };
  }, [roomId]);

  const add = async () => {
    const t = text.trim();
    if (!t || submitting) return;
    setSubmitting(true);
    try {
      const q = await createQuestion(roomId, t, { agendaItemId: activeAgendaItemId });
      setItems(prev => prev.some(x => x.id === q.id) ? prev : [q, ...prev]);
      setText('');
    } finally {
      setSubmitting(false);
    }
  };

  const setStatus = async (id: string, status: OpenQuestionStatus) => {
    // 乐观更新
    setItems(prev => prev.map(x => x.id === id ? { ...x, status } : x));
    try {
      await updateQuestion(id, { status });
    } catch {
      // 失败 WS 会 refresh，不手动回滚
    }
  };

  const remove = async (id: string) => {
    setItems(prev => prev.filter(x => x.id !== id));
    try { await deleteQuestion(id); } catch { /* WS 会兜 */ }
  };

  // v0.9 从讨论里自动抽取开放问题
  //   先弹确认框避免误触 —— 这会触发 LLM 调用（耗 token/时间），不该即点即执行。
  //   通过后后端会广播 room.question.append，列表会通过 WS 自动增基，
  //   这里不再手动合并避免双增。
  const extract = async () => {
    if (extracting) return;
    const ok = await confirm({
      title: '从讨论里抽取开放问题',
      message: '将由主持 agent（或第一个存活 agent）扫描最近 60 条消息，最多产出 6 条未决问题。\n\n这次调用会消耗 tokens，请确认继续。',
      confirmText: '抽取',
      cancelText: '取消',
    });
    if (!ok) return;
    setExtracting(true);
    try { await extractQuestions(roomId); } catch { /* toast 由 withToast 发 */ }
    finally { setExtracting(false); }
  };

  const authorName = (q: OpenQuestion) =>
    q.raisedById ? (members.get(q.raisedById)?.name || q.raisedById) : '—';

  return (
    <div className="flex flex-col gap-2">
      {/* 新增输入 */}
      <div className="flex items-stretch gap-1.5">
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') add(); }}
          placeholder="记录一个悬而未决的问题…"
          className="sci-input flex-1 min-w-0 h-7 px-2 rounded-md text-[11.5px] bg-surface border border-border"
          disabled={submitting}
        />
        <button
          type="button"
          onClick={add}
          disabled={!text.trim() || submitting}
          className="h-7 px-2.5 rounded-md text-[11.5px] font-semibold bg-amber-500 hover:bg-amber-600 text-white transition disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-[14px]">help</span>
          挂起
        </button>
      </div>

      {/* v0.9 一键从讨论抽取。LLM 扫最近 60 条，删减昨天手动点逐条录。 */}
      <button
        type="button"
        onClick={extract}
        disabled={extracting}
        className="self-start h-7 px-2.5 rounded-md text-[11.5px] font-semibold bg-surface hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-300 border border-border text-text-secondary transition disabled:opacity-50 disabled:cursor-wait inline-flex items-center gap-1"
        title="让 AI 从最近讨论里找出没人回答的问题"
      >
        <span className={`material-symbols-outlined text-[14px] ${extracting ? 'animate-spin' : ''}`}>
          {extracting ? 'progress_activity' : 'auto_awesome'}
        </span>
        {extracting ? '抽取中…' : '从讨论里抽取'}
      </button>

      {loading ? (
        <div className="text-[11px] text-text-muted">加载中…</div>
      ) : items.length === 0 ? (
        <div className="px-2 py-3 text-[11px] text-text-muted text-center border border-dashed border-border rounded-md leading-relaxed">
          没有未决问题。发现问题但需要后续 check 时，挂在这里不会被讨论洪流冲掉。
        </div>
      ) : (
        <ul className="space-y-1.5">
          {items.map(q => {
            const meta = STATUS_META[q.status];
            return (
              <li
                key={q.id}
                className={`group flex items-start gap-2 px-2 py-1.5 rounded-md border ${meta.tone} transition`}
              >
                <span className="material-symbols-outlined text-[14px] mt-0.5 shrink-0">
                  {q.status === 'answered' ? 'check_circle' : q.status === 'deferred' ? 'schedule' : 'help'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-text leading-snug">{q.text}</div>
                  <div className="mt-0.5 flex items-center flex-wrap gap-1.5 text-[10px] text-text-muted">
                    <span className={`px-1.5 py-[1px] rounded text-[10px] font-mono ${meta.tone}`}>
                      {meta.label}
                    </span>
                    <span>{authorName(q)}</span>
                    <span>·</span>
                    <span className="font-mono">{new Date(q.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition shrink-0">
                  {q.status !== 'answered' && (
                    <button type="button" onClick={() => setStatus(q.id, 'answered')}
                      className="w-6 h-6 rounded hover:bg-emerald-500/15 flex items-center justify-center text-text-muted hover:text-emerald-500"
                      title="标记已答">
                      <span className="material-symbols-outlined text-[14px]">check</span>
                    </button>
                  )}
                  {q.status !== 'deferred' && q.status !== 'answered' && (
                    <button type="button" onClick={() => setStatus(q.id, 'deferred')}
                      className="w-6 h-6 rounded hover:bg-surface-sunken flex items-center justify-center text-text-muted"
                      title="延后">
                      <span className="material-symbols-outlined text-[14px]">snooze</span>
                    </button>
                  )}
                  {onJump && q.answerMessageId && (
                    <button type="button" onClick={() => onJump(q.answerMessageId!)}
                      className="w-6 h-6 rounded hover:bg-surface-sunken flex items-center justify-center text-text-muted hover:text-text"
                      title="查看答复">
                      <span className="material-symbols-outlined text-[14px]">arrow_outward</span>
                    </button>
                  )}
                  <button type="button" onClick={() => remove(q.id)}
                    className="w-6 h-6 rounded hover:bg-danger/10 flex items-center justify-center text-text-muted hover:text-danger"
                    title="删除">
                    <span className="material-symbols-outlined text-[14px]">close</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default QuestionsPanel;
