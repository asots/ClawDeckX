// 紧急刹车按钮 + 确认弹窗（DESIGN §6.3）
import React, { useState } from 'react';

interface Props {
  onStop: (reason: string) => void;
}

const EmergencyStop: React.FC<Props> = ({ onStop }) => {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="紧急停止（所有 Agent）"
        className="fixed bottom-20 end-4 z-40 w-12 h-12 rounded-full bg-gradient-to-br from-red-500 to-red-600 text-white shadow-[0_8px_24px_rgba(239,68,68,0.4)] hover:shadow-[0_12px_32px_rgba(239,68,68,0.6)] hover:scale-105 active:scale-95 transition-all flex items-center justify-center border-2 border-red-400/50"
      >
        <span className="material-symbols-outlined text-[22px]">e911_emergency</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-surface rounded-2xl shadow-2xl border border-red-500/30 w-full max-w-md animate-card-enter overflow-hidden">
            <div className="p-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-11 h-11 rounded-xl bg-red-500/10 flex items-center justify-center">
                  <span className="material-symbols-outlined text-[24px] text-red-500">e911_emergency</span>
                </div>
                <div>
                  <h3 className="text-[15px] font-bold text-text">紧急停止所有 Agent</h3>
                  <p className="text-[11px] text-text-secondary">立即中止所有进行中的调用与工具执行</p>
                </div>
              </div>
              <ul className="text-[11.5px] text-text-secondary space-y-1 mb-3 ps-1">
                <li className="flex gap-2"><span className="text-red-500">●</span>所有 Agent 进入 IDLE</li>
                <li className="flex gap-2"><span className="text-red-500">●</span>未完成的工具调用被 abort</li>
                <li className="flex gap-2"><span className="text-red-500">●</span>历史消息完整保留，不会删除</li>
                <li className="flex gap-2"><span className="text-red-500">●</span>房间状态切到 PAUSED</li>
              </ul>
              <label className="text-[11px] text-text-muted mb-1 block">停止原因（可选，用于 trajectory 标注）</label>
              <input
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="例如：成员循环反复 / 即将撞到敏感话题 / 调错策略..."
                className="w-full px-2.5 h-8 rounded-lg bg-surface-raised border border-border sci-input text-[12px]"
                autoFocus
              />
            </div>
            <div className="flex gap-2 px-5 py-3 border-t border-border bg-surface-sunken/40">
              <button
                onClick={() => { setOpen(false); setReason(''); }}
                className="flex-1 h-9 rounded-lg text-[12px] font-semibold bg-surface hover:bg-surface-raised border border-border"
              >
                取消
              </button>
              <button
                onClick={() => { onStop(reason); setOpen(false); setReason(''); }}
                className="flex-1 h-9 rounded-lg text-[12px] font-bold bg-red-500 text-white hover:bg-red-600 shadow-[0_4px_12px_rgba(239,68,68,0.3)]"
              >
                立即停止
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default EmergencyStop;
