// OutcomeBundleView —— v0.7 会议产出总包查看器
//
// 以 artifact kind='outcome_bundle' 为数据源，按 tab 组织：
//   - 概览（markdown 大报告）
//   - 决策台账（跳回原消息）
//   - 行动项（复用 TasksPanel 视图的只读版）
//   - 复盘（嵌入 RetroView）
//
// 支持下载 markdown / 复制 / 在新窗口打开。

import React, { useEffect, useMemo, useState } from 'react';
import type { Member, Message, NextMeetingDraft, OpenQuestion, PlaybookHighlightContext, RoomTask, Retro } from '../types';
import {
  getOutcome, listDecisions, getRoom, listQuestions, updateTask,
} from '../service';
import MarkdownView from './MarkdownView';
import RetroView from './RetroView';

interface Props {
  roomId: string;
  members: Map<string, Member>;
  /** 点击消息跳转时触发 —— 会把聊天流滚到对应位置。 */
  onJump?: (messageId: string) => void;
  onStartNextMeeting?: (draft: NextMeetingDraft) => void;
  forcedTab?: Tab;
  onOpenPlaybook?: (playbookId: string, context: PlaybookHighlightContext) => void;
}

type Tab = 'overview' | 'decisions' | 'tasks' | 'questions' | 'retro';

const OutcomeBundleView: React.FC<Props> = ({ roomId, members, onJump, onStartNextMeeting, forcedTab, onOpenPlaybook }) => {
  const [loading, setLoading] = useState(true);
  const [bundle, setBundle] = useState<{ content: string; title: string } | null>(null);
  const [retro, setRetro] = useState<Retro | null>(null);
  const [decisions, setDecisions] = useState<Message[]>([]);
  const [tasks, setTasks] = useState<RoomTask[]>([]);
  const [questions, setQuestions] = useState<OpenQuestion[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [hasBundle, setHasBundle] = useState(false);

  const refetch = React.useCallback(async () => {
    setLoading(true);
    try {
      const [outcome, dec, room, qs] = await Promise.all([
        getOutcome(roomId),
        listDecisions(roomId),
        getRoom(roomId),
        listQuestions(roomId),
      ]);
      setHasBundle(outcome.hasBundle);
      setBundle(outcome.bundle ? { content: outcome.bundle.content, title: outcome.bundle.title } : null);
      setRetro(outcome.retro || null);
      setDecisions(dec);
      setTasks(room?.tasks || []);
      setQuestions(qs || []);
    } finally { setLoading(false); }
  }, [roomId]);

  useEffect(() => { refetch(); }, [refetch]);

  useEffect(() => {
    if (forcedTab) setTab(forcedTab);
  }, [forcedTab]);

  const copyMd = async () => {
    if (!bundle) return;
    try { await navigator.clipboard.writeText(bundle.content); } catch { /* noop */ }
  };

  const downloadMd = () => {
    if (!bundle) return;
    const blob = new Blob([bundle.content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${bundle.title || 'outcome'}.md`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const memberName = (id: string) => members.get(id)?.name || id;

  const openTasks = useMemo(() => tasks.filter(t => t.status !== 'done'), [tasks]);
  const doneTasks = useMemo(() => tasks.filter(t => t.status === 'done'), [tasks]);
  const answeredQuestions = useMemo(() => questions.filter(q => q.status === 'answered' || q.answerMessageId), [questions]);

  if (loading) return <div className="text-[11px] text-text-muted">加载产出中…</div>;

  if (!hasBundle) {
    return (
      <div className="px-3 py-6 text-[12px] text-text-muted text-center border border-dashed border-border rounded-lg leading-relaxed">
        尚未生成产出总包。点顶栏「关闭会议」按钮即可一键产出纪要 / Todo / Playbook / 复盘。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border overflow-x-auto no-scrollbar">
        {[
          { id: 'overview',  label: '概览', count: 0 },
          { id: 'decisions', label: '决策', count: decisions.length },
          { id: 'tasks',     label: '行动', count: tasks.length },
          { id: 'questions', label: '问答', count: answeredQuestions.length },
          { id: 'retro',     label: '复盘', count: retro ? 1 : 0 },
        ].map(t => {
          const active = tab === t.id;
          return (
            <button key={t.id} type="button"
              onClick={() => setTab(t.id as Tab)}
              className={`h-8 px-3 text-[11.5px] font-semibold inline-flex items-center gap-1 shrink-0 transition border-b-2 ${
                active ? 'border-cyan-500 text-cyan-700 dark:text-cyan-200' : 'border-transparent text-text-muted hover:text-text'
              }`}>
              {t.label}
              {t.count > 0 && (
                <span className={`px-1.5 py-[1px] rounded-full font-mono text-[10px] ${active ? 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-200' : 'bg-surface-sunken text-text-muted'}`}>
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === 'overview' && bundle && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-2">
              <div className="text-[10px] text-text-muted">决策</div>
              <div className="text-[14px] font-bold text-emerald-700 dark:text-emerald-300">{decisions.length}</div>
            </div>
            <div className="rounded-md border border-cyan-500/25 bg-cyan-500/5 px-2.5 py-2">
              <div className="text-[10px] text-text-muted">行动</div>
              <div className="text-[14px] font-bold text-cyan-700 dark:text-cyan-300">{tasks.length}</div>
            </div>
            <div className="rounded-md border border-indigo-500/25 bg-indigo-500/5 px-2.5 py-2">
              <div className="text-[10px] text-text-muted">问答</div>
              <div className="text-[14px] font-bold text-indigo-700 dark:text-indigo-300">{answeredQuestions.length}</div>
            </div>
            <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-2.5 py-2">
              <div className="text-[10px] text-text-muted">复盘</div>
              <div className="text-[14px] font-bold text-amber-700 dark:text-amber-300">{retro ? '已生成' : '无'}</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={copyMd}
              className="h-7 px-2.5 rounded-md text-[11.5px] border border-border text-text-muted hover:bg-surface-sunken inline-flex items-center gap-1">
              <span className="material-symbols-outlined text-[13px]">content_copy</span>
              复制 markdown
            </button>
            <button type="button" onClick={downloadMd}
              className="h-7 px-2.5 rounded-md text-[11.5px] border border-border text-text-muted hover:bg-surface-sunken inline-flex items-center gap-1">
              <span className="material-symbols-outlined text-[13px]">download</span>
              下载 .md
            </button>
          </div>
          <div className="sci-card rounded-lg border border-border bg-surface/70 p-3 overflow-y-auto neon-scrollbar max-h-[60vh]">
            <MarkdownView content={bundle.content} />
          </div>
        </div>
      )}

      {tab === 'decisions' && (
        decisions.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-text-muted text-center border border-dashed border-border rounded-md">
            没有记录决策。
          </div>
        ) : (
          <ol className="space-y-1.5">
            {decisions.map((m, i) => (
              <li key={m.id}
                className="group flex items-start gap-2 px-2 py-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10 transition">
                <span className="w-5 h-5 rounded-full bg-emerald-500/30 flex items-center justify-center text-[10px] font-mono shrink-0">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-text leading-snug">
                    {m.decisionSummary?.trim() || m.content?.slice(0, 200)}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted">
                    <span>{memberName(m.authorId)}</span>
                    <span>·</span>
                    <span className="font-mono">{new Date(m.timestamp).toLocaleString()}</span>
                  </div>
                </div>
                {onJump && (
                  <button type="button" onClick={() => onJump(m.id)}
                    className="w-6 h-6 rounded hover:bg-surface-sunken flex items-center justify-center text-text-muted hover:text-text opacity-0 group-hover:opacity-100 transition shrink-0"
                    title="跳转到原消息">
                    <span className="material-symbols-outlined text-[14px]">arrow_outward</span>
                  </button>
                )}
              </li>
            ))}
          </ol>
        )
      )}

      {tab === 'tasks' && (
        tasks.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-text-muted text-center border border-dashed border-border rounded-md">
            没有抽取到行动项。
          </div>
        ) : (
          <div className="space-y-3">
            <TaskGroup title="未完成" tasks={openTasks} memberName={memberName}
              onToggle={async t => {
                const next = t.status === 'done' ? 'todo' : 'done';
                setTasks(prev => prev.map(x => x.id === t.id ? { ...x, status: next } : x));
                try { await updateTask(roomId, t.id, { status: next }); } catch { /* noop */ }
              }}
              onJump={onJump}
            />
            <TaskGroup title="已完成" tasks={doneTasks} memberName={memberName}
              onToggle={async t => {
                const next = t.status === 'done' ? 'todo' : 'done';
                setTasks(prev => prev.map(x => x.id === t.id ? { ...x, status: next } : x));
                try { await updateTask(roomId, t.id, { status: next }); } catch { /* noop */ }
              }}
              onJump={onJump}
            />
          </div>
        )
      )}

      {tab === 'questions' && (
        answeredQuestions.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-text-muted text-center border border-dashed border-border rounded-md">
            没有可追溯的问答锚点。
          </div>
        ) : (
          <ul className="space-y-1.5">
            {answeredQuestions.map((q, i) => (
              <li key={q.id} className="group flex items-start gap-2 px-2 py-1.5 rounded-md border border-cyan-500/25 bg-cyan-500/5 hover:bg-cyan-500/10 transition">
                <span className="w-5 h-5 rounded-full bg-cyan-500/25 flex items-center justify-center text-[10px] font-mono shrink-0">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-text leading-snug">{q.text}</div>
                  <div className="mt-0.5 text-[10.5px] text-text-muted leading-snug">
                    {q.answerText?.trim() || '已在讨论中给出回答，可跳回原消息查看上下文'}
                  </div>
                </div>
                {q.answerMessageId && onJump && (
                  <button
                    type="button"
                    onClick={() => onJump(q.answerMessageId!)}
                    className="w-6 h-6 rounded hover:bg-surface-sunken flex items-center justify-center text-text-muted hover:text-text opacity-0 group-hover:opacity-100 transition shrink-0"
                    title="跳转到回答消息"
                  >
                    <span className="material-symbols-outlined text-[14px]">arrow_outward</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )
      )}

      {tab === 'retro' && (
        <RetroView roomId={roomId} initialRetro={retro} onStartNextMeeting={onStartNextMeeting} onOpenPlaybook={onOpenPlaybook} />
      )}
    </div>
  );
};

const TaskGroup: React.FC<{
  title: string;
  tasks: RoomTask[];
  memberName: (id: string) => string;
  onToggle: (t: RoomTask) => void;
  onJump?: (messageId: string) => void;
}> = ({ title, tasks, memberName, onToggle, onJump }) => {
  if (tasks.length === 0) return null;
  return (
    <div>
      <div className="text-[11px] text-text-muted mb-1">{title} · {tasks.length}</div>
      <ul className="space-y-1">
        {tasks.map(t => (
          <li key={t.id}
            className="flex items-start gap-2 px-2 py-1.5 rounded-md border border-border bg-surface hover:bg-surface-sunken transition">
            <button type="button" onClick={() => onToggle(t)}
              className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 mt-[1px] ${
                t.status === 'done' ? 'border-emerald-500 bg-emerald-500 text-white'
                                    : 'border-border hover:border-emerald-500'
              }`}>
              {t.status === 'done' && <span className="material-symbols-outlined text-[13px]">check</span>}
            </button>
            <div className="flex-1 min-w-0">
              <div className={`text-[12px] leading-snug ${t.status === 'done' ? 'line-through text-text-muted' : 'text-text'}`}>
                {t.text}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted">
                {t.assigneeId && <span>@{memberName(t.assigneeId)}</span>}
                <span className="font-mono">{new Date(t.createdAt).toLocaleDateString()}</span>
                {t.refMessageId && (
                  <>
                    <span>·</span>
                    <button
                      type="button"
                      onClick={() => onJump?.(t.refMessageId!)}
                      className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-300 hover:underline"
                      title="跳回来源消息"
                    >
                      <span className="material-symbols-outlined text-[12px]">link</span>
                      来源讨论
                    </button>
                  </>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default OutcomeBundleView;
