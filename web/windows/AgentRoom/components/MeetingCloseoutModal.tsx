// MeetingCloseoutModal —— v0.7 关闭仪式对话框
//
// 真实会议收尾必备：一键启动「纪要 → Todo → Playbook → Retro → Bundle」5 步流水线。
// 每步独立，某步失败其它仍继续；服务端通过 WS 事件 room.closeout.step 广播进度。
// 结束后直接把 OutcomeBundle 展示出来让用户浏览 / 导出。
//
// 设计：
//   - 双栏：左边 5 步进度条（实时），右边 Bundle 预览（完成后激活）
//   - 关闭按钮可选「同时把房间 state 置为 closed」（默认勾上）
//   - 失败步骤展示错误详情，可单独重试（后续版本）

import React, { useEffect, useMemo, useState } from 'react';
import type { CloseoutResult, CloseoutStep, Member, PlaybookHighlightContext } from '../types';
import { runCloseout, cancelCloseout, closeRoomOnly, purgeRoomSessions, roomEvents } from '../service';
import OutcomeBundleView from './OutcomeBundleView';

interface Props {
  roomId: string;
  roomTitle: string;
  members: Map<string, Member>;
  open: boolean;
  onClose: () => void;
  /** 关闭仪式成功后触发；父层可据此刷新 Room state。 */
  onDone?: (result: CloseoutResult) => void;
  onRunningChange?: (running: boolean) => void;
  onJump?: (messageId: string) => void;
  onOpenPlaybooks?: (playbookId?: string, context?: PlaybookHighlightContext) => void;
}

const STEP_META: Record<CloseoutStep['name'], { label: string; icon: string; desc: string }> = {
  minutes:  { label: '会议纪要',      icon: 'article',          desc: '由辅助 LLM 压缩整场对话' },
  todos:    { label: '抽取行动项',    icon: 'task_alt',         desc: '解析讨论里的显式 / 隐含动作项' },
  playbook: { label: '生成 Playbook', icon: 'menu_book',         desc: '沉淀为可复用的方法论卡 + 自动打标签' },
  retro:    { label: '会议复盘',      icon: 'analytics',         desc: '五维打分 + 亮点改进点 + 下次会议建议' },
  bundle:   { label: '打包产出',      icon: 'inventory_2',       desc: '聚合为完整 markdown 报告 / artifact' },
};

const STEP_ORDER: CloseoutStep['name'][] = ['minutes', 'todos', 'playbook', 'retro', 'bundle'];

const STATUS_STYLE: Record<CloseoutStep['status'], { dot: string; text: string }> = {
  pending: { dot: 'bg-surface-sunken border border-border', text: 'text-text-muted' },
  running: { dot: 'bg-cyan-500 border border-cyan-300 animate-pulse', text: 'text-cyan-600 dark:text-cyan-300' },
  ok:      { dot: 'bg-emerald-500 border border-emerald-300', text: 'text-emerald-600 dark:text-emerald-300' },
  error:   { dot: 'bg-red-500 border border-red-300', text: 'text-red-600 dark:text-red-300' },
  // skipped —— 不是默默无状，而是错错着展示灵灵一点的颜色：樱桃/琥珀，方便用户一眼区分 “没跑”和“成功”。
  skipped: { dot: 'bg-amber-500/60 border border-amber-400/60', text: 'text-amber-600 dark:text-amber-300' },
};

const MeetingCloseoutModal: React.FC<Props> = ({ roomId, roomTitle, members, open, onClose, onDone, onRunningChange, onJump, onOpenPlaybooks }) => {
  const [closeRoomFlag, setCloseRoomFlag] = useState(true);
  const [purgeSessionsFlag, setPurgeSessionsFlag] = useState(true);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [resultTab, setResultTab] = useState<'overview' | 'retro'>('overview');
  // canceling —— 点击“取消”后到后端广播最后一个 step skipped 之间的过渡态；
  // 避免用户连续连点暴击取消按钮。
  const [canceling, setCanceling] = useState(false);
  const [steps, setSteps] = useState<CloseoutStep[]>(() =>
    STEP_ORDER.map(name => ({ name, status: 'pending' as const }))
  );
  const [result, setResult] = useState<CloseoutResult | null>(null);

  // reset on open
  useEffect(() => {
    if (open) {
      setRunning(false);
      setDone(false);
      setCanceling(false);
      setSteps(STEP_ORDER.map(name => ({ name, status: 'pending' as const })));
      setResult(null);
      setResultTab('overview');
    }
  }, [open]);

  useEffect(() => {
    onRunningChange?.(running);
  }, [running, onRunningChange]);

  // 监听 WS 实时 step 事件
  useEffect(() => {
    if (!open) return;
    const off = roomEvents.on('room.closeout.step' as any, (ev: any) => {
      if (ev?.roomId !== roomId || !ev.step) return;
      const s: CloseoutStep = ev.step;
      setSteps(prev => {
        const ix = prev.findIndex(x => x.name === s.name);
        if (ix < 0) return prev;
        const next = [...prev];
        next[ix] = s;
        return next;
      });
    });
    const offDone = roomEvents.on('room.closeout.done' as any, (ev: any) => {
      if (ev?.roomId !== roomId || !ev.result) return;
      setResult(ev.result);
      setDone(true);
    });
    return () => { off?.(); offDone?.(); };
  }, [open, roomId]);

  const runAll = async () => {
    if (running) return;
    setRunning(true);
    setDone(false);
    // 把所有 pending 步骤重置
    setSteps(STEP_ORDER.map(name => ({ name, status: 'pending' as const })));
    try {
      const res = await runCloseout(roomId, closeRoomFlag);
      // 兜底：WS 如果漏了某些 step，用最终 result 覆盖
      if (res && Array.isArray(res.steps) && res.steps.length > 0) {
        setSteps(prev => {
          const byName = new Map(res.steps.map(s => [s.name, s]));
          return prev.map(s => byName.get(s.name) || s);
        });
      }
      setResult(res);
      setDone(true);
      setResultTab('overview');
      // v0.9.1：勾选了“删除房间相关会话记录”——在 Closeout 成功落盘后再删 gateway session，
      // 避免 Closeout 过程中 LLM 调用被半途切掉。失败静默，服务层自带 toast。
      if (closeRoomFlag && purgeSessionsFlag) {
        try { await purgeRoomSessions(roomId); } catch { /* service withToast 已提示 */ }
      }
      if (onDone) onDone(res);
    } finally {
      setRunning(false);
      setCanceling(false);
    }
  };

  // 仅关闭——v0.9.1：跳过 Closeout 流水线，直接把房间状态切到 closed。
  // 适用于"已经有纪要 / 不需要 AI 总结 / 省 token"的场景。
  // 返回后立即触发 onDone，让父层关掉 modal 并刷新 Room state。
  const handleCloseOnly = async () => {
    if (running) return;
    try {
      await closeRoomOnly(roomId);
      if (purgeSessionsFlag) {
        try { await purgeRoomSessions(roomId); } catch { /* service withToast 已提示 */ }
      }
      // 不产出 bundle，构造一个最小 CloseoutResult 供 onDone 回调（让父层 state 刷新路径统一）。
      const minimal: CloseoutResult = {
        roomId,
        steps: [],
        ok: true,
      };
      if (onDone) onDone(minimal);
      onClose();
    } catch {
      // service withToast 已弹提示，无需额外处理
    }
  };

  // 取消——打断后端 LLM 调用。后端会给剩余 step 广播 skipped，前端监听触发重绘。
  // runAll 的 await 会返回“部分完成”的 result，稀有情况下 LLM 在返回前完成——也没关系。
  const handleCancel = async () => {
    if (!running || canceling) return;
    setCanceling(true);
    try {
      await cancelCloseout(roomId);
    } catch {
      // 静默：用户再点一次或等步骤天然结束也行
      setCanceling(false);
    }
  };

  const okCount = steps.filter(s => s.status === 'ok').length;
  const errCount = steps.filter(s => s.status === 'error').length;
  const progressPct = useMemo(() =>
    Math.round((steps.filter(s => s.status === 'ok' || s.status === 'error').length / steps.length) * 100),
    [steps],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
      role="dialog" aria-modal="true" aria-label="关闭会议仪式"
    >
      <div
        className="sci-card w-[min(960px,96vw)] max-h-[92vh] overflow-hidden bg-surface-overlay border border-border rounded-xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex items-center gap-2 bg-gradient-to-r from-cyan-500/10 via-purple-500/5 to-transparent">
          <span className="material-symbols-outlined text-[20px] text-cyan-500">flag</span>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-bold text-text truncate">关闭会议 · 生成正式产出</div>
            <div className="text-[11px] text-text-muted truncate">{roomTitle}</div>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-md hover:bg-surface-sunken text-text-muted hover:text-text transition-colors"
            aria-label="关闭">
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>

        {/* Body: split left=steps / right=bundle preview */}
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[320px_1fr] gap-0 overflow-hidden">
          {/* Left: steps */}
          <div className="border-e border-border p-4 flex flex-col overflow-y-auto neon-scrollbar">
            {!running && !done && (
              <div className="mb-3 text-[12px] text-text-secondary leading-relaxed">
                这是一条流水线：纪要 → Todo → Playbook → 复盘 → 打包。
                每步相对独立；任一步失败不影响其余步骤。
              </div>
            )}

            {/* Top progress */}
            <div className="mb-3">
              <div className="flex items-center justify-between text-[11px] text-text-muted mb-1">
                <span>进度</span>
                <span className="font-mono">{progressPct}%</span>
              </div>
              <div className="h-2 rounded bg-surface-sunken overflow-hidden">
                <div className="h-full bg-gradient-to-r from-cyan-500 to-purple-500 transition-all" style={{ width: `${progressPct}%` }} />
              </div>
            </div>

            {/* Steps */}
            <ol className="space-y-2">
              {steps.map((s, i) => {
                const meta = STEP_META[s.name];
                const style = STATUS_STYLE[s.status];
                return (
                  <li key={s.name} className="flex items-start gap-2">
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${style.dot}`}>
                      {s.status === 'ok' && <span className="material-symbols-outlined text-[12px] text-white">check</span>}
                      {s.status === 'error' && <span className="material-symbols-outlined text-[12px] text-white">close</span>}
                      {s.status === 'pending' && <span className="text-[9.5px] font-mono text-text-muted">{i + 1}</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className={`flex items-center gap-1 text-[12px] font-semibold ${style.text}`}>
                        <span className="material-symbols-outlined text-[14px]">{meta.icon}</span>
                        {meta.label}
                      </div>
                      <div className="text-[10.5px] text-text-muted leading-snug">{meta.desc}</div>
                      {s.detail && (
                        <div className={`mt-0.5 text-[10.5px] ${s.status === 'error' ? 'text-red-500' : 'text-text-muted'}`}>
                          {s.status === 'error' ? '⚠ ' : '· '}{s.detail}
                        </div>
                      )}
                      {s.startMs && s.endMs && (
                        <div className="text-[10px] text-text-muted font-mono">
                          {((s.endMs - s.startMs) / 1000).toFixed(1)}s
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>

            {/* Bottom actions */}
            <div className="mt-auto pt-4 space-y-2">
              <label className="flex items-center gap-2 text-[11.5px] text-text-secondary cursor-pointer">
                <input type="checkbox"
                  checked={closeRoomFlag}
                  onChange={e => setCloseRoomFlag(e.target.checked)}
                  disabled={running}
                  className="accent-cyan-500"
                />
                产出完成后，把房间状态改为「closed」（推荐）
              </label>
              <label className="flex items-center gap-2 text-[11.5px] text-text-secondary cursor-pointer">
                <input type="checkbox"
                  checked={purgeSessionsFlag}
                  onChange={e => setPurgeSessionsFlag(e.target.checked)}
                  disabled={running}
                  className="accent-cyan-500"
                />
                <span>
                  同时删除本房间相关的 AI 会话记录
                  <span className="ml-1 text-text-muted">（清理 gateway 侧残留，建议勾选）</span>
                </span>
              </label>
              {purgeSessionsFlag && (
                <div className="text-[10.5px] leading-snug text-amber-600 dark:text-amber-300/80 pl-6 -mt-1">
                  ⚠ 会话记录删除后，AI 将失去此前所有对话记忆；重启会议时会按成员原始角色设定从零开始续聊。
                </div>
              )}
              {!done ? (
                // 运行中：两按钮无缝横排——主按钮显示“生成中”(disabled)，辅按钮“取消”能点。
                // 未开始：单按钮“开始生成”全宽。
                running ? (
                  <div className="flex items-stretch gap-2">
                    <button type="button" disabled
                      className="flex-1 h-9 rounded-md text-[12.5px] font-semibold bg-gradient-to-r from-cyan-500/60 to-purple-500/60 text-white opacity-90 cursor-not-allowed inline-flex items-center justify-center gap-1.5">
                      <span className="material-symbols-outlined text-[15px] animate-spin">progress_activity</span>
                      {canceling ? '正在中断…' : '生成中…'}
                    </button>
                    <button type="button" onClick={handleCancel} disabled={canceling}
                      className="h-9 px-3 rounded-md text-[12.5px] font-semibold bg-surface-raised hover:bg-amber-500/10 border border-border hover:border-amber-500/40 text-text-secondary hover:text-amber-600 dark:hover:text-amber-300 transition disabled:opacity-50 inline-flex items-center gap-1"
                      title="立即打断后端 LLM 调用；已完成的步骤结果保留">
                      <span className="material-symbols-outlined text-[15px]">stop_circle</span>
                      取消
                    </button>
                  </div>
                ) : (
                  // v0.9.1：双按钮布局——主按钮「生成正式产出」跑完整流水线；
                  // 次按钮「仅关闭会议」跳过流水线直接把房间切到 closed。
                  // 设计：主按钮保持强调色 + flex-1 抢宽；次按钮克制（无背景，边框 + 弱文字），
                  // 放在右侧，视觉权重小 ≈ 1/3 主按钮，避免误引导。
                  <div className="flex items-stretch gap-2">
                    <button type="button" onClick={runAll}
                      className="flex-1 h-9 rounded-md text-[12.5px] font-semibold bg-gradient-to-r from-cyan-500 to-purple-500 hover:from-cyan-600 hover:to-purple-600 text-white transition inline-flex items-center justify-center gap-1.5">
                      <span className="material-symbols-outlined text-[15px]">bolt</span>
                      开始生成
                    </button>
                    <button type="button" onClick={handleCloseOnly}
                      title="跳过 AI 产出流水线，直接把房间切到 closed 状态（省 token，产出物不会生成）"
                      className="h-9 px-3 rounded-md text-[12px] font-semibold bg-surface-raised hover:bg-amber-500/10 border border-border hover:border-amber-500/40 text-text-secondary hover:text-amber-700 dark:hover:text-amber-300 transition inline-flex items-center gap-1">
                      <span className="material-symbols-outlined text-[14px]">block</span>
                      <span className="hidden sm:inline">仅关闭</span>
                    </button>
                  </div>
                )
              ) : (
                <>
                  <div className={`px-2 py-2 rounded-md text-[11.5px] text-center font-semibold ${errCount > 0 ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}`}>
                    {errCount > 0
                      ? `完成 · ${okCount} 成功，${errCount} 失败`
                      : `✅ 全部完成 · ${okCount} 步成功`}
                  </div>
                  {/* v0.9.1：辅助 LLM 用量卡片。后端 Closeout 累计所有 nonStreamComplete
                      调用的 tokens，再用 EstimateCostCNYSplit 按模型单价估算 CNY；前端
                      这里只展示，不做任何二次计算。仅 result.usage 存在且 calls>0 时渲染。 */}
                  {result?.usage && result.usage.calls > 0 && (
                    <div className="px-2.5 py-2 rounded-md bg-surface-sunken border border-border space-y-1.5">
                      <div className="flex items-center gap-1 text-[11px] font-semibold text-text-secondary">
                        <span className="material-symbols-outlined text-[13px]">receipt_long</span>
                        本次生成消耗
                      </div>
                      {result.usage.model && (
                        <div className="flex items-center justify-between text-[10.5px]">
                          <span className="text-text-muted">模型</span>
                          <span className="font-mono text-text truncate ms-2 max-w-[160px]" title={result.usage.model}>
                            {result.usage.model}
                          </span>
                        </div>
                      )}
                      <div className="flex items-center justify-between text-[10.5px]">
                        <span className="text-text-muted">输入 / 输出 tokens</span>
                        <span className="font-mono text-text">
                          {result.usage.tokensPrompt.toLocaleString()} / {result.usage.tokensComplete.toLocaleString()}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[10.5px]">
                        <span className="text-text-muted">LLM 调用次数</span>
                        <span className="font-mono text-text">{result.usage.calls}</span>
                      </div>
                      <div className="flex items-center justify-between text-[11px] font-semibold pt-1 border-t border-border/60">
                        <span className="text-text">估算费用</span>
                        <span className="font-mono text-cyan-600 dark:text-cyan-300">
                          ¥{result.usage.costCNY.toFixed(4)}
                        </span>
                      </div>
                    </div>
                  )}
                </>
              )}

              {done && result?.bundle && (
                <div className="grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    onClick={() => setResultTab('overview')}
                    className="h-8 px-3 rounded-md text-[11.5px] font-semibold border border-border text-text-secondary hover:bg-surface-sunken inline-flex items-center justify-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-[14px]">description</span>
                    查看总包
                  </button>
                  <button
                    type="button"
                    onClick={() => setResultTab('retro')}
                    className="h-8 px-3 rounded-md text-[11.5px] font-semibold border border-border text-text-secondary hover:bg-surface-sunken inline-flex items-center justify-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-[14px]">analytics</span>
                    查看复盘
                  </button>
                  {result.bundle.playbookId && onOpenPlaybooks ? (
                    <button
                      type="button"
                      onClick={() => onOpenPlaybooks(result.bundle?.playbookId, {
                        source: 'closeout',
                        roomId,
                        roomTitle,
                        playbookId: result.bundle?.playbookId,
                        summary: result.bundle?.retro?.summary,
                        highlights: result.bundle?.retro?.highlights || [],
                        lowlights: result.bundle?.retro?.lowlights || [],
                        nextAgendaItems: result.bundle?.retro?.nextMeetingDraft?.agendaItems || [],
                        generatedAt: result.bundle?.generatedAt,
                      })}
                      className="h-8 px-3 rounded-md text-[11.5px] font-semibold bg-violet-500 hover:bg-violet-600 text-white inline-flex items-center justify-center gap-1.5"
                    >
                      <span className="material-symbols-outlined text-[14px]">menu_book</span>
                      打开对应 Playbook
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          </div>

          {/* Right: bundle preview */}
          <div className="p-4 overflow-y-auto neon-scrollbar">
            {done && result?.bundle ? (
              <OutcomeBundleView roomId={roomId} members={members} onJump={onJump} forcedTab={resultTab} />
            ) : running ? (
              <div className="h-full flex items-center justify-center text-center text-[12.5px] text-text-muted leading-relaxed">
                <div>
                  <span className="material-symbols-outlined text-[42px] text-cyan-500 animate-spin block mb-3">progress_activity</span>
                  AI 正在基于完整对话历史生成正式产出…<br/>
                  通常耗时 30 秒 – 2 分钟，视对话长度而定。
                </div>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-center text-[12.5px] text-text-muted leading-relaxed">
                <div className="max-w-sm">
                  <span className="material-symbols-outlined text-[42px] text-text-muted block mb-3">description</span>
                  点击左侧「开始生成」后，完整的会议产出（markdown 报告 + 决策 + 行动项 + 复盘）会出现在这里，可一键导出分享。
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MeetingCloseoutModal;
