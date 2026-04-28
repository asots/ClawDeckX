// 右栏·任务面板（v0.2 工作单升级）
//
// 较 v0.1：
//   1. 任务按状态分组：待办 / 进行中 / 待验收 / 阻塞 / 已完成
//   2. 每个任务卡可点击展开，展开后可编辑 reviewer / DoD / deliverable / executionMode / dueAt / 状态
//   3. 待验收的任务（status=review），若当前用户是 reviewer，会显示验收操作区
//      —— 通过 / 返工 / 阻塞 / 上升人类，含 passed/failed criteria + 备注 + 返工说明
//   4. 决策来源徽章 + 返工次数徽章 + 来源消息跳转
//   5. 卡片分组保留旧 UX（默认折叠），添加任务表单仍是单行简化版（深度编辑入展开后的卡片做）
//
// 与后端契约：依赖 internal/agentroom/types.go 的 Task 状态机：
//   todo / doing / assigned / in_progress / review / done / cancelled / blocked
//   acceptanceStatus: '' | accepted | rework | needs_human | blocked
//
// 设计原则：
//   - 旧任务（无 reviewer/DoD）自然回退为简单 TODO 视图
//   - 视觉风格沿用 sci-card / sci-input / surface-* token，浅深色双主题适配
//   - 文案中文 / 图标用 material-symbols-outlined，与 DecisionsPanel/AgendaRail 等保持一致

import React, { useEffect, useMemo, useState } from 'react';
import type { Member, RoomTask, TaskStatus, AcceptanceStatus, TaskExecution } from '../types';
import {
  acceptTask, updateTask,
  dispatchTask, listTaskExecutions, submitExecutionResult, cancelExecution,
  roomEvents,
} from '../service';
import CustomSelect from '../../../components/CustomSelect';
import { useToast } from '../../../components/Toast';

interface Props {
  roomId: string;
  tasks: RoomTask[];
  members: Map<string, Member>;
  meId: string;
  onAdd: (text: string, assigneeId?: string) => void;
  onToggle: (taskId: string) => void;
  onDelete: (taskId: string) => void;
  /** 点击源决策/源消息时跳转聊天流（可选） */
  onJumpMessage?: (messageId: string) => void;
}

// 状态分组顺序
const ACTIVE_STATUSES: TaskStatus[] = ['todo', 'doing', 'assigned', 'in_progress'];
const REVIEW_STATUSES: TaskStatus[] = ['review'];
const BLOCKED_STATUSES: TaskStatus[] = ['blocked'];
const DONE_STATUSES: TaskStatus[] = ['done'];

// 状态可视化
const STATUS_META: Record<TaskStatus, { label: string; tone: string; icon: string }> = {
  todo:        { label: '待办',   tone: 'text-text-muted',                       icon: 'circle' },
  doing:       { label: '处理中', tone: 'text-amber-500',                        icon: 'hourglass_top' },
  assigned:    { label: '已派发', tone: 'text-blue-500',                         icon: 'forward_to_inbox' },
  in_progress: { label: '执行中', tone: 'text-amber-500',                        icon: 'rocket_launch' },
  review:      { label: '待验收', tone: 'text-violet-500',                       icon: 'rule' },
  done:        { label: '已完成', tone: 'text-emerald-500',                      icon: 'task_alt' },
  cancelled:   { label: '已取消', tone: 'text-text-muted line-through',          icon: 'cancel' },
  blocked:     { label: '阻塞',   tone: 'text-rose-500',                         icon: 'block' },
};

const ACCEPTANCE_LABEL: Record<NonNullable<AcceptanceStatus>, string> = {
  '': '',
  accepted: '已通过',
  rework: '返工中',
  needs_human: '上升人工',
  blocked: '已阻塞',
};

const TasksPanel: React.FC<Props> = ({ roomId: _roomId, tasks, members, meId, onAdd, onToggle, onDelete, onJumpMessage }) => {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const memberOptions = useMemo(
    () => [
      { value: '', label: '（不指派）' },
      ...Array.from(members.values()).filter(m => !m.isKicked).map(m => ({ value: m.id, label: m.name })),
    ],
    [members],
  );

  const groups = useMemo(() => {
    const byStatus = (s: TaskStatus[]) => tasks.filter(t => s.includes(t.status));
    return {
      review:  byStatus(REVIEW_STATUSES),
      active:  byStatus(ACTIVE_STATUSES),
      blocked: byStatus(BLOCKED_STATUSES),
      done:    byStatus(DONE_STATUSES),
    };
  }, [tasks]);

  const save = () => {
    if (!draft.trim()) return;
    onAdd(draft.trim(), assignee || undefined);
    setDraft('');
    setAssignee(null);
    setAdding(false);
  };

  // v0.3 主题 D：DAG 信息——在 TaskCard 上显示 "依赖 N / 阻塞 M" 时不再要求向下查找
  const tasksById = useMemo(() => {
    const m = new Map<string, RoomTask>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  const renderCard = (t: RoomTask) => {
    const deps = t.dependsOn || [];
    let blockingDeps = 0;
    for (const id of deps) {
      const dep = tasksById.get(id);
      if (dep && dep.status !== 'done') blockingDeps++;
    }
    return (
      <TaskCard
        key={t.id}
        task={t}
        roomId={_roomId}
        members={members}
        meId={meId}
        memberOptions={memberOptions}
        isExpanded={expandedId === t.id}
        onToggleExpand={() => setExpandedId(expandedId === t.id ? null : t.id)}
        onToggle={onToggle}
        onDelete={onDelete}
        onJumpMessage={onJumpMessage}
        depsTotal={deps.length}
        depsBlocking={blockingDeps}
      />
    );
  };

  return (
    <div className="space-y-3">
      {/* 待验收：强势露出 */}
      {groups.review.length > 0 && (
        <SectionHeader
          icon="rule"
          tone="text-violet-500"
          label="待验收"
          count={groups.review.length}
          accent="bg-violet-500/10 border-violet-500/30"
        >
          {groups.review.map(renderCard)}
        </SectionHeader>
      )}

      {/* 进行中 + 待办（合并为「未完成」） */}
      {groups.active.length > 0 && (
        <div className="space-y-1">{groups.active.map(renderCard)}</div>
      )}

      {/* 阻塞 */}
      {groups.blocked.length > 0 && (
        <SectionHeader
          icon="block"
          tone="text-rose-500"
          label="阻塞"
          count={groups.blocked.length}
          accent="bg-rose-500/10 border-rose-500/30"
        >
          {groups.blocked.map(renderCard)}
        </SectionHeader>
      )}

      {/* 已完成 */}
      {groups.done.length > 0 && (
        <details className="group/done">
          <summary className="cursor-pointer text-[10px] text-text-muted hover:text-text inline-flex items-center gap-1 select-none">
            <span className="material-symbols-outlined text-[12px] group-open/done:rotate-90 transition-transform">chevron_right</span>
            已完成 ({groups.done.length})
          </summary>
          <div className="mt-1 space-y-0.5 opacity-70">{groups.done.map(renderCard)}</div>
        </details>
      )}

      {/* 添加 */}
      {adding ? (
        <div className="p-2 rounded-lg bg-surface-raised border border-cyan-500/30 sci-card">
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setAdding(false); }}
            placeholder="任务内容…（创建后展开卡片可补 reviewer / DoD）"
            className="w-full mb-1.5 px-1.5 py-1 rounded bg-surface border border-border sci-input text-[11.5px]"
            autoFocus
          />
          <div className="flex items-center gap-1 mb-1.5">
            <label className="text-[10px] text-text-muted shrink-0">指派</label>
            <div className="flex-1 min-w-0">
              <CustomSelect
                value={assignee || ''}
                onChange={v => setAssignee(v || null)}
                options={memberOptions}
                className="h-6 px-1 rounded bg-surface border border-border text-[11px]"
              />
            </div>
          </div>
          <div className="flex gap-1">
            <button onClick={save} className="flex-1 h-6 rounded-md text-[10px] font-bold bg-primary text-white hover:bg-primary/90">添加</button>
            <button onClick={() => setAdding(false)} className="flex-1 h-6 rounded-md text-[10px] font-semibold bg-surface hover:bg-surface-sunken border border-border">取消</button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="w-full h-7 px-3 rounded-md text-[11.5px] font-semibold border border-dashed border-border text-text-muted hover:border-cyan-500/40 hover:text-cyan-500 hover:bg-cyan-500/5 transition inline-flex items-center justify-center gap-1"
        >
          <span className="material-symbols-outlined text-[14px]">add</span>
          添加任务
        </button>
      )}

      {tasks.length === 0 && !adding && (
        <div className="px-2 py-3 text-[11px] text-text-muted text-center border border-dashed border-border rounded-md leading-relaxed">
          还没有任务。可以从「决策流」一键转任务，或手动添加。
        </div>
      )}
    </div>
  );
};

// ─────────── SectionHeader：分组容器 ───────────
const SectionHeader: React.FC<{
  icon: string;
  tone: string;
  label: string;
  count: number;
  accent: string;
  children: React.ReactNode;
}> = ({ icon, tone, label, count, accent, children }) => (
  <div className={`rounded-lg border ${accent} p-1.5`}>
    <div className={`mb-1 inline-flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide ${tone}`}>
      <span className="material-symbols-outlined text-[13px]">{icon}</span>
      {label}
      <span className="opacity-70">·</span>
      <span className="opacity-70">{count}</span>
    </div>
    <div className="space-y-1">{children}</div>
  </div>
);

// ─────────── TaskCard：单个任务卡 ───────────
const TaskCard: React.FC<{
  task: RoomTask;
  members: Map<string, Member>;
  meId: string;
  memberOptions: { value: string; label: string }[];
  roomId: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onToggle: (taskId: string) => void;
  onDelete: (taskId: string) => void;
  onJumpMessage?: (messageId: string) => void;
  // v0.3 主题 D：DAG 信息。depsTotal 0 时不显示 chip；depsBlocking>0 时高亮为红色"阻塞"。
  depsTotal?: number;
  depsBlocking?: number;
}> = ({ task, roomId, members, meId, memberOptions, isExpanded, onToggleExpand, onToggle, onDelete, onJumpMessage, depsTotal = 0, depsBlocking = 0 }) => {
  const meta = STATUS_META[task.status];
  const assignee = task.assigneeId ? members.get(task.assigneeId) : undefined;
  const reviewer = task.reviewerId ? members.get(task.reviewerId) : undefined;
  const accepted = task.status === 'done';
  const isReviewer = !!task.reviewerId && task.reviewerId === meId;

  return (
    <div
      className={`group rounded-md transition-colors ${
        isExpanded ? 'border border-cyan-500/40 bg-surface-raised sci-card' : 'border border-transparent hover:bg-surface-sunken'
      }`}
    >
      {/* 折叠态主行 */}
      <div className="flex items-start gap-2 p-1.5">
        <button
          type="button"
          onClick={() => onToggle(task.id)}
          className="mt-0.5 w-4 h-4 rounded border-2 border-border hover:border-cyan-500 flex items-center justify-center transition-colors shrink-0"
          title={accepted ? '取消完成' : '标记完成'}
        >
          {accepted && <span className="material-symbols-outlined text-[11px] text-emerald-500">check</span>}
          {(task.status === 'doing' || task.status === 'in_progress') && (
            <span className="material-symbols-outlined text-[12px] text-amber-500">hourglass_top</span>
          )}
        </button>
        <div className="flex-1 min-w-0 cursor-pointer" onClick={onToggleExpand}>
          <div className={`text-[11.5px] leading-snug break-words ${accepted ? 'text-text-muted line-through' : 'text-text'}`}>
            {task.text}
          </div>
          <div className="flex items-center flex-wrap gap-1.5 mt-0.5 text-[10px]">
            <span className={`inline-flex items-center gap-0.5 ${meta.tone}`} title={`status: ${task.status}`}>
              <span className="material-symbols-outlined text-[11px]">{meta.icon}</span>
              {meta.label}
            </span>
            {depsTotal > 0 && (
              <span
                className={`inline-flex items-center gap-0.5 font-semibold ${
                  depsBlocking > 0
                    ? 'text-red-500 dark:text-red-400'
                    : 'text-emerald-600 dark:text-emerald-400'
                }`}
                title={
                  depsBlocking > 0
                    ? `阻塞：等待 ${depsBlocking} / ${depsTotal} 个前置任务完成`
                    : `依赖 ${depsTotal} 个前置任务，已全部完成`
                }
              >
                <span className="material-symbols-outlined text-[11px]">
                  {depsBlocking > 0 ? 'block' : 'check_circle'}
                </span>
                {depsBlocking > 0 ? `阻塞 ${depsBlocking}/${depsTotal}` : `依赖 ${depsTotal}`}
              </span>
            )}
            {assignee && (
              <span className="inline-flex items-center gap-0.5 font-semibold text-cyan-600 dark:text-cyan-400" title="执行人">
                <span className="material-symbols-outlined text-[11px]">person</span>
                @{assignee.name}
              </span>
            )}
            {reviewer && (
              <span className="inline-flex items-center gap-0.5 font-semibold text-violet-500" title="验收人">
                <span className="material-symbols-outlined text-[11px]">verified_user</span>
                {reviewer.name}
              </span>
            )}
            {task.acceptanceStatus && (
              <AcceptanceBadge status={task.acceptanceStatus} reworkCount={task.reworkCount || 0} />
            )}
            {task.sourceDecisionId && (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onJumpMessage?.(task.sourceDecisionId!); }}
                className="inline-flex items-center gap-0.5 px-1 rounded text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20"
                title="来源决策"
              >
                <span className="material-symbols-outlined text-[11px]">bookmark</span>
                决策
              </button>
            )}
            {task.dueAt && (
              <span className="font-mono text-text-muted" title="截止">截止 {formatDueTime(task.dueAt)}</span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onToggleExpand}
          className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-text shrink-0 w-5 h-5 inline-flex items-center justify-center"
          title={isExpanded ? '收起' : '展开'}
        >
          <span className="material-symbols-outlined text-[14px]">
            {isExpanded ? 'keyboard_arrow_up' : 'keyboard_arrow_down'}
          </span>
        </button>
        {(task.creatorId === meId || task.assigneeId === meId) && (
          <button
            type="button"
            onClick={() => onDelete(task.id)}
            className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-rose-500 shrink-0 w-5 h-5 inline-flex items-center justify-center"
            title="取消任务"
          >
            <span className="material-symbols-outlined text-[14px]">close</span>
          </button>
        )}
      </div>

      {/* 展开态详情 + 编辑 */}
      {isExpanded && (
        <TaskDetailEditor
          task={task}
          roomId={roomId}
          members={members}
          memberOptions={memberOptions}
          isReviewer={isReviewer}
        />
      )}
    </div>
  );
};

// ─────────── 验收徽章 ───────────
const AcceptanceBadge: React.FC<{ status: AcceptanceStatus; reworkCount: number }> = ({ status, reworkCount }) => {
  if (!status) return null;
  const styles: Record<NonNullable<AcceptanceStatus>, string> = {
    '':           '',
    accepted:     'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    rework:       'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    needs_human:  'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400',
    blocked:      'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  };
  return (
    <span className={`inline-flex items-center gap-0.5 px-1 rounded ${styles[status]}`}>
      {ACCEPTANCE_LABEL[status]}
      {status === 'rework' && reworkCount > 0 && (
        <span className="font-mono opacity-80">×{reworkCount}</span>
      )}
    </span>
  );
};

// ─────────── 详情编辑器（展开后内容） ───────────
const TaskDetailEditor: React.FC<{
  task: RoomTask;
  roomId: string;
  members: Map<string, Member>;
  memberOptions: { value: string; label: string }[];
  isReviewer: boolean;
}> = ({ task, roomId, members: _members, memberOptions, isReviewer }) => {
  const { toast } = useToast();
  const [reviewerId, setReviewerId] = useState(task.reviewerId || '');
  const [deliverable, setDeliverable] = useState(task.deliverable || '');
  const [definitionOfDone, setDefinitionOfDone] = useState(task.definitionOfDone || '');
  const [executionMode, setExecutionMode] = useState(task.executionMode || '');
  const [, setSavingField] = useState<string | null>(null);
  const [showAcceptance, setShowAcceptance] = useState(task.status === 'review' && isReviewer);

  // 通用保存：仅在 blur / 主动确认时调用，避免每按一键就 patch
  const saveField = async (key: string, value: string | undefined) => {
    setSavingField(key);
    try {
      await updateTask(roomId, task.id, { [key]: value } as Partial<RoomTask>);
    } catch {
      toast('error', `保存 ${key} 失败`);
    } finally {
      setSavingField(null);
    }
  };

  return (
    <div className="px-2 pb-2 pt-1 border-t border-border/50 space-y-2 text-[11px]">
      {/* 上次验收备注（如果有） */}
      {task.acceptanceNote && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[10.5px] leading-relaxed whitespace-pre-wrap">
          <div className="text-amber-600 dark:text-amber-400 font-semibold mb-0.5 inline-flex items-center gap-1">
            <span className="material-symbols-outlined text-[12px]">history</span>
            上次验收备注
          </div>
          {task.acceptanceNote}
        </div>
      )}

      {/* reviewer / executionMode */}
      <div className="grid grid-cols-2 gap-1.5">
        <FieldLabel label="验收人">
          <CustomSelect
            value={reviewerId}
            onChange={v => { setReviewerId(v); saveField('reviewerId', v); }}
            options={memberOptions}
            className="h-6 px-1 rounded bg-surface border border-border text-[10.5px]"
          />
        </FieldLabel>
        <FieldLabel label="执行模式">
          <CustomSelect
            value={executionMode}
            onChange={v => { setExecutionMode(v as RoomTask['executionMode']); saveField('executionMode', v); }}
            options={[
              { value: '', label: '（未指定）' },
              { value: 'manual', label: '人工' },
              { value: 'member_agent', label: '成员 agent' },
              { value: 'subagent', label: '派子代理' },
            ]}
            className="h-6 px-1 rounded bg-surface border border-border text-[10.5px]"
          />
        </FieldLabel>
      </div>

      {/* deliverable */}
      <FieldLabel label="期望交付物">
        <textarea
          value={deliverable}
          onChange={e => setDeliverable(e.target.value)}
          onBlur={() => deliverable !== (task.deliverable || '') && saveField('deliverable', deliverable)}
          rows={2}
          placeholder="一句话描述要交付的产物（文档、代码、决议、数据等）"
          className="w-full px-1.5 py-1 rounded bg-surface border border-border sci-input text-[10.5px] resize-y leading-snug"
        />
      </FieldLabel>

      {/* DoD */}
      <FieldLabel label="完成标准（DoD，每行一项）">
        <textarea
          value={definitionOfDone}
          onChange={e => setDefinitionOfDone(e.target.value)}
          onBlur={() => definitionOfDone !== (task.definitionOfDone || '') && saveField('definitionOfDone', definitionOfDone)}
          rows={3}
          placeholder={`例如：\n- 文档已发到团队群\n- 至少 2 名成员审阅`}
          className="w-full px-1.5 py-1 rounded bg-surface border border-border sci-input text-[10.5px] font-mono resize-y leading-snug"
        />
      </FieldLabel>

      {/* 派发 / 执行子面板（v0.2 GAP G4） */}
      {task.status !== 'done' && task.status !== 'cancelled' && (
        <ExecutionSection
          task={task}
          roomId={roomId}
          memberOptions={memberOptions}
          members={_members}
        />
      )}

      {/* 验收入口（仅 review 状态 + reviewer） */}
      <div className="flex flex-wrap gap-1.5">
        {task.status === 'review' && isReviewer && !showAcceptance && (
          <button
            type="button"
            onClick={() => setShowAcceptance(true)}
            className="h-6 px-2 rounded-md text-[10px] font-semibold bg-violet-500 text-white hover:bg-violet-600 inline-flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-[12px]">verified</span>
            进入验收
          </button>
        )}
        {task.status === 'review' && !isReviewer && (
          <span className="text-[10px] text-text-muted inline-flex items-center gap-1">
            <span className="material-symbols-outlined text-[11px]">info</span>
            等待
            {task.reviewerId
              ? <span className="font-semibold text-violet-500">@{_members.get(task.reviewerId)?.name || '验收人'}</span>
              : '验收人'}
            提交验收
          </span>
        )}
      </div>

      {/* 验收操作面板 */}
      {showAcceptance && task.status === 'review' && isReviewer && (
        <AcceptancePanel
          task={task}
          onDone={() => setShowAcceptance(false)}
        />
      )}
    </div>
  );
};

// ─────────── FieldLabel ───────────
const FieldLabel: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block">
    <span className="block mb-0.5 text-[10px] uppercase tracking-wide text-text-muted">{label}</span>
    {children}
  </label>
);

// ─────────── 验收操作面板 ───────────
const AcceptancePanel: React.FC<{ task: RoomTask; onDone: () => void }> = ({ task, onDone }) => {
  const { toast } = useToast();
  const dodItems = useMemo(() => splitLines(task.definitionOfDone), [task.definitionOfDone]);

  const [passed, setPassed] = useState<Set<string>>(new Set(task.passedCriteria || []));
  const [failed, setFailed] = useState<Set<string>>(new Set(task.failedCriteria || []));
  const [summary, setSummary] = useState('');
  const [reworkInstructions, setReworkInstructions] = useState('');
  const [submitting, setSubmitting] = useState<string | null>(null);

  const togglePass = (item: string) => {
    setPassed(prev => {
      const n = new Set(prev);
      if (n.has(item)) n.delete(item); else n.add(item);
      return n;
    });
    setFailed(prev => { const n = new Set(prev); n.delete(item); return n; });
  };
  const toggleFail = (item: string) => {
    setFailed(prev => {
      const n = new Set(prev);
      if (n.has(item)) n.delete(item); else n.add(item);
      return n;
    });
    setPassed(prev => { const n = new Set(prev); n.delete(item); return n; });
  };

  const submit = async (status: 'accepted' | 'rework' | 'needs_human' | 'blocked') => {
    if (status === 'rework' && !reworkInstructions.trim()) {
      toast('warning', '请填写返工要求');
      return;
    }
    setSubmitting(status);
    try {
      await acceptTask(task.id, {
        status,
        summary: summary.trim(),
        passedCriteria: Array.from(passed),
        failedCriteria: Array.from(failed),
        reworkInstructions: status === 'rework' ? reworkInstructions.trim() : undefined,
      });
      toast('success', '验收已提交');
      onDone();
    } catch {
      // service 已弹错误
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="rounded-md border border-violet-500/40 bg-violet-500/5 p-2 space-y-2">
      <div className="text-[10.5px] uppercase tracking-wide text-violet-500 font-semibold inline-flex items-center gap-1">
        <span className="material-symbols-outlined text-[13px]">rule</span>
        验收结论
        {task.reworkCount && task.reworkCount > 0 ? (
          <span className="ms-1 px-1 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 normal-case tracking-normal">
            第 {task.reworkCount + 1} 次审阅
          </span>
        ) : null}
      </div>

      {/* DoD 检查 */}
      {dodItems.length > 0 ? (
        <div className="space-y-1">
          <div className="text-[10px] text-text-muted">逐条勾选 DoD 是否达标</div>
          {dodItems.map(item => {
            const isPassed = passed.has(item);
            const isFailed = failed.has(item);
            return (
              <div key={item} className="flex items-start gap-1.5 px-1.5 py-1 rounded border border-border bg-surface">
                <div className="flex gap-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => togglePass(item)}
                    className={`w-5 h-5 rounded inline-flex items-center justify-center transition ${
                      isPassed
                        ? 'bg-emerald-500 text-white'
                        : 'border border-border text-text-muted hover:border-emerald-500/60 hover:text-emerald-500'
                    }`}
                    title="达标"
                  >
                    <span className="material-symbols-outlined text-[12px]">check</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleFail(item)}
                    className={`w-5 h-5 rounded inline-flex items-center justify-center transition ${
                      isFailed
                        ? 'bg-rose-500 text-white'
                        : 'border border-border text-text-muted hover:border-rose-500/60 hover:text-rose-500'
                    }`}
                    title="未达标"
                  >
                    <span className="material-symbols-outlined text-[12px]">close</span>
                  </button>
                </div>
                <span className={`text-[10.5px] leading-snug flex-1 min-w-0 ${
                  isPassed ? 'text-emerald-600 dark:text-emerald-400' : isFailed ? 'text-rose-600 dark:text-rose-400' : 'text-text'
                }`}>
                  {item}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-[10.5px] text-text-muted italic">
          没填 DoD。先在卡片上方补写「完成标准」可让验收逐条勾选。
        </div>
      )}

      <FieldLabel label="验收总结">
        <textarea
          value={summary}
          onChange={e => setSummary(e.target.value)}
          rows={2}
          placeholder="一句话总结质量、关键证据、是否符合预期"
          className="w-full px-1.5 py-1 rounded bg-surface border border-border sci-input text-[10.5px] resize-y"
        />
      </FieldLabel>

      <FieldLabel label="返工要求（仅返工时填）">
        <textarea
          value={reworkInstructions}
          onChange={e => setReworkInstructions(e.target.value)}
          rows={2}
          placeholder="具体说明哪一条需要重做、改成什么样"
          className="w-full px-1.5 py-1 rounded bg-surface border border-border sci-input text-[10.5px] resize-y"
        />
      </FieldLabel>

      {/* 4 个操作 */}
      <div className="grid grid-cols-2 gap-1.5">
        <ActionBtn icon="check_circle" tone="emerald" label="通过"        loading={submitting === 'accepted'}    onClick={() => submit('accepted')} />
        <ActionBtn icon="redo"         tone="amber"   label="返工"        loading={submitting === 'rework'}      onClick={() => submit('rework')} />
        <ActionBtn icon="report"       tone="rose"    label="阻塞"        loading={submitting === 'blocked'}     onClick={() => submit('blocked')} />
        <ActionBtn icon="escalator_warning" tone="fuchsia" label="上升人工" loading={submitting === 'needs_human'} onClick={() => submit('needs_human')} />
      </div>

      <button
        type="button"
        onClick={onDone}
        className="w-full h-6 rounded-md text-[10px] font-semibold bg-surface hover:bg-surface-sunken border border-border"
      >
        取消
      </button>
    </div>
  );
};

const ACTION_TONE: Record<string, string> = {
  emerald: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25 border-emerald-500/30',
  amber:   'bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25 border-amber-500/30',
  rose:    'bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 border-rose-500/30',
  fuchsia: 'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400 hover:bg-fuchsia-500/25 border-fuchsia-500/30',
};
const ActionBtn: React.FC<{ icon: string; tone: string; label: string; onClick: () => void; loading?: boolean }> = ({ icon, tone, label, onClick, loading }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={loading}
    className={`h-7 rounded-md text-[10.5px] font-semibold border ${ACTION_TONE[tone] || ACTION_TONE.emerald} inline-flex items-center justify-center gap-1 disabled:opacity-50 disabled:cursor-wait`}
  >
    <span className="material-symbols-outlined text-[13px]">{loading ? 'hourglass_top' : icon}</span>
    {label}
  </button>
);

// ─────────── ExecutionSection：派发与执行回执（v0.2 GAP G4） ───────────
//
// 状态机：
//   无活跃 execution → 显示"派发任务"行（mode 选择 + 执行人选择 + 派发按钮）
//   有 queued/running execution → 显示当前执行卡 + 提交结果表单 + 取消按钮
//   历史 execution → 折叠显示完成/取消的列表
//
// 数据：组件挂载时拉一次执行列表；通过 roomEvents.room.update 监听 tasksChanged 事件
// 重新拉取（与 TasksPanel 数据流一致，不重复 polling）。
const EXEC_STATUS_META: Record<string, { label: string; tone: string; icon: string }> = {
  queued:    { label: '已派发', tone: 'text-blue-500',    icon: 'inbox' },
  running:   { label: '执行中', tone: 'text-amber-500',   icon: 'autorenew' },
  completed: { label: '已完成', tone: 'text-emerald-500', icon: 'check_circle' },
  failed:    { label: '失败',   tone: 'text-rose-500',    icon: 'error' },
  canceled:  { label: '已取消', tone: 'text-text-muted',  icon: 'cancel' },
};
const EXEC_MODE_LABEL: Record<string, string> = {
  manual:       '人工',
  member_agent: '成员代理',
  subagent:     '子代理',
};

const ExecutionSection: React.FC<{
  task: RoomTask;
  roomId: string;
  memberOptions: { value: string; label: string }[];
  members: Map<string, Member>;
}> = ({ task, roomId, memberOptions, members }) => {
  const { toast } = useToast();
  const [executions, setExecutions] = useState<TaskExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [dispatchMode, setDispatchMode] = useState<TaskExecution['mode']>(
    (task.executionMode as TaskExecution['mode']) || 'manual',
  );
  const [dispatchExecutor, setDispatchExecutor] = useState(task.assigneeId || '');
  const [submitSummary, setSubmitSummary] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const refetch = React.useCallback(() => {
    setLoading(true);
    listTaskExecutions(task.id).then(setExecutions).finally(() => setLoading(false));
  }, [task.id]);

  useEffect(() => { refetch(); }, [refetch]);

  // 监听房间任务变更广播 → 重新拉取
  useEffect(() => {
    const off = roomEvents.on('room.update', ev => {
      if (ev.roomId !== roomId) return;
      const p = ev.patch as { tasksChanged?: boolean } | undefined;
      if (p && p.tasksChanged) refetch();
    });
    return () => { if (off) off(); };
  }, [roomId, refetch]);

  const active = executions.find(e => e.status === 'queued' || e.status === 'running');
  const history = executions.filter(e => e !== active);

  const doDispatch = async () => {
    if (busy) return;
    if ((dispatchMode === 'member_agent' || dispatchMode === 'subagent') && !dispatchExecutor) {
      toast('warning', '请选择执行人');
      return;
    }
    setBusy('dispatch');
    try {
      await dispatchTask(roomId, task.id, {
        mode: dispatchMode,
        executorMemberId: dispatchExecutor || undefined,
      });
      toast('success', '已派发');
    } catch {
      // service 已弹错
    } finally {
      setBusy(null);
    }
  };

  const doSubmit = async () => {
    if (!active || busy) return;
    if (!submitSummary.trim()) {
      toast('warning', '请填写执行结果摘要');
      return;
    }
    setBusy('submit');
    try {
      await submitExecutionResult(active.id, { summary: submitSummary.trim() });
      toast('success', '已提交结果，等待验收');
      setSubmitSummary('');
    } catch {
      // service 已弹错
    } finally {
      setBusy(null);
    }
  };

  const doCancel = async () => {
    if (!active || busy) return;
    setBusy('cancel');
    try {
      await cancelExecution(active.id);
      toast('info', '已取消执行');
    } catch {
      // service 已弹错
    } finally {
      setBusy(null);
    }
  };

  const memberName = (id?: string) => (id ? (members.get(id)?.name || id) : '—');

  return (
    <div className="rounded-md border border-border/70 bg-surface-sunken/50 p-2 space-y-2">
      <div className="text-[10.5px] uppercase tracking-wide text-text-muted font-semibold inline-flex items-center gap-1">
        <span className="material-symbols-outlined text-[13px]">rocket_launch</span>
        派发与执行
      </div>

      {/* 活跃执行卡 */}
      {active && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10.5px]">
            <span className={`inline-flex items-center gap-0.5 ${EXEC_STATUS_META[active.status]?.tone || ''}`}>
              <span className="material-symbols-outlined text-[12px]">
                {EXEC_STATUS_META[active.status]?.icon || 'circle'}
              </span>
              {EXEC_STATUS_META[active.status]?.label || active.status}
            </span>
            <span className="text-text-muted">·</span>
            <span className="text-text-muted">{EXEC_MODE_LABEL[active.mode] || active.mode}</span>
            {active.executorMemberId && (
              <>
                <span className="text-text-muted">·</span>
                <span className="font-semibold text-cyan-600 dark:text-cyan-400">@{memberName(active.executorMemberId)}</span>
              </>
            )}
            {active.startedAt && (
              <>
                <span className="text-text-muted">·</span>
                <span className="font-mono text-text-muted">{formatRelativeTime(active.startedAt)}</span>
              </>
            )}
          </div>
          <textarea
            value={submitSummary}
            onChange={e => setSubmitSummary(e.target.value)}
            rows={2}
            placeholder="完成情况、产出位置、备注…"
            className="w-full px-1.5 py-1 rounded bg-surface border border-border sci-input text-[10.5px] resize-y"
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={doSubmit}
              disabled={busy === 'submit'}
              className="flex-1 h-6 rounded-md text-[10px] font-semibold bg-violet-500 text-white hover:bg-violet-600 inline-flex items-center justify-center gap-1 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[12px]">{busy === 'submit' ? 'hourglass_top' : 'rule'}</span>
              提交结果 → 待验收
            </button>
            <button
              type="button"
              onClick={doCancel}
              disabled={busy === 'cancel'}
              className="h-6 px-2 rounded-md text-[10px] font-semibold bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 border border-rose-500/30 inline-flex items-center gap-1 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[12px]">{busy === 'cancel' ? 'hourglass_top' : 'stop_circle'}</span>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 派发新执行（无活跃且任务未到 review/done） */}
      {!active && task.status !== 'review' && (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            <FieldLabel label="执行模式">
              <CustomSelect
                value={dispatchMode}
                onChange={v => setDispatchMode(v as TaskExecution['mode'])}
                options={[
                  { value: 'manual', label: '人工执行' },
                  { value: 'member_agent', label: '成员代理' },
                  { value: 'subagent', label: '派子代理' },
                ]}
                className="h-6 px-1 rounded bg-surface border border-border text-[10.5px]"
              />
            </FieldLabel>
            <FieldLabel label="执行人">
              <CustomSelect
                value={dispatchExecutor}
                onChange={v => setDispatchExecutor(v)}
                options={memberOptions}
                className="h-6 px-1 rounded bg-surface border border-border text-[10.5px]"
              />
            </FieldLabel>
          </div>
          <button
            type="button"
            onClick={doDispatch}
            disabled={busy === 'dispatch'}
            className="w-full h-7 rounded-md text-[11px] font-semibold bg-cyan-500 text-white hover:bg-cyan-600 inline-flex items-center justify-center gap-1 disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[13px]">{busy === 'dispatch' ? 'hourglass_top' : 'send'}</span>
            派发任务
          </button>
        </div>
      )}

      {/* 历史执行 */}
      {!loading && history.length > 0 && (
        <details className="group/exehist">
          <summary className="cursor-pointer text-[10px] text-text-muted hover:text-text inline-flex items-center gap-1 select-none">
            <span className="material-symbols-outlined text-[12px] group-open/exehist:rotate-90 transition-transform">chevron_right</span>
            历史执行 ({history.length})
          </summary>
          <div className="mt-1 space-y-1">
            {history.map(e => (
              <div key={e.id} className="rounded border border-border/60 bg-surface px-1.5 py-1 text-[10px]">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className={EXEC_STATUS_META[e.status]?.tone || ''}>
                    {EXEC_STATUS_META[e.status]?.label || e.status}
                  </span>
                  <span className="text-text-muted">·</span>
                  <span className="text-text-muted">{EXEC_MODE_LABEL[e.mode] || e.mode}</span>
                  {e.executorMemberId && (
                    <>
                      <span className="text-text-muted">·</span>
                      <span>@{memberName(e.executorMemberId)}</span>
                    </>
                  )}
                  <span className="text-text-muted ms-auto font-mono">{formatRelativeTime(e.completedAt || e.createdAt)}</span>
                </div>
                {e.summary && (
                  <div className="mt-0.5 text-text-muted leading-snug whitespace-pre-wrap">{e.summary}</div>
                )}
                {e.errorMsg && (
                  <div className="mt-0.5 text-rose-500 leading-snug">{e.errorMsg}</div>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
};

// ─────────── helpers ───────────
function splitLines(s?: string): string[] {
  if (!s) return [];
  return s.split('\n').map(x => x.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
}

// 距今的相对时间。<60s "刚刚"；<60min "N 分钟前"；<24h "N 小时前"；其余短日期。
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDueTime(ts: number): string {
  const diff = ts - Date.now();
  if (diff < 0) return '已逾期';
  if (diff < 3_600_000) return `${Math.ceil(diff / 60_000)} 分钟后`;
  if (diff < 86_400_000) return `${Math.ceil(diff / 3_600_000)} 小时后`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default TasksPanel;
