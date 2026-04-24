// QualityPanel —— v0.6 协作质量控制台
//
// v0.9.1 清理：房间目标 / 轮次预算 / 房间宪法 三项已由 LiveControlsPanel（会议控制台）
// 统一权威配置，从这里删除以避免同一参数双入口漂移。仅保留"自我批判回合"开关 ——
// 这是 QualityPanel 独有的开关（LiveControlsPanel 未暴露），并且语义上属于"提升单轮
// 输出质量的 opt-in 成本"，与其它持久化配置不同，独立管理更清晰。
//
// 保留原 draft + 显式保存模式；保存通过同一条 setRoomQuality RPC，参数仅传 selfCritique。

import React, { useEffect, useState } from 'react';
import type { Room } from '../types';
import { setRoomQuality } from '../service';

interface Props {
  room: Room;
}

const QualityPanel: React.FC<Props> = ({ room }) => {
  const [selfCritique, setSelfCritique] = useState<boolean>(!!room.selfCritique);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelfCritique(!!room.selfCritique);
  }, [room.id, room.selfCritique]);

  const dirty = selfCritique !== !!room.selfCritique;

  const save = async () => {
    setSaving(true);
    try {
      // 只回传本面板管辖的 selfCritique；其余字段（goal/roundBudget/constitution）
      // 沿用房间当前值，由 LiveControlsPanel 作为权威入口维护，这里不覆盖。
      await setRoomQuality(room.id, {
        goal: room.goal ?? '',
        roundBudget: room.roundBudget ?? 0,
        selfCritique,
        constitution: room.constitution ?? '',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 text-[12px]">
      {/* 自我批判开关（QualityPanel 独有，不在 LiveControlsPanel 里重复） */}
      <label className="flex items-start gap-2 px-2 py-1.5 rounded-md border border-border bg-surface-raised cursor-pointer hover:bg-surface-sunken">
        <input
          type="checkbox"
          checked={selfCritique}
          onChange={e => setSelfCritique(e.target.checked)}
          className="mt-0.5 accent-primary"
        />
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-text">自我批判回合</div>
          <div className="text-[10px] text-text-muted leading-snug">
            Agent 发言落盘前跑一次轻量 rubric：低质量会被重写一次。成本约 +15% tokens，换来更低胡说八道率。
          </div>
        </div>
      </label>

      {/* 去重提示 —— 告诉用户其余房间级配置去哪调，避免找不到。 */}
      <div className="flex items-start gap-1.5 px-2 py-1.5 rounded-md border border-dashed border-border bg-surface-sunken/40">
        <span className="material-symbols-outlined text-[14px] text-text-muted mt-px">tune</span>
        <div className="text-[10.5px] text-text-muted leading-snug">
          房间目标 · 预期 agent 轮次 · 房间宪法等配置已统一到
          <span className="font-semibold text-text"> 会议控制台</span>
          （右栏顶部"推进会议"组），在那里调整即可。
        </div>
      </div>

      {/* 保存 */}
      <div className="flex items-center justify-end gap-1 pt-1 border-t border-border">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className={`px-3 h-7 rounded-md text-[11px] font-semibold transition ${
            dirty && !saving
              ? 'bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30'
              : 'bg-surface-sunken text-text-muted cursor-not-allowed'
          }`}
        >
          {saving ? '保存中…' : dirty ? '保存' : '已保存'}
        </button>
      </div>
    </div>
  );
};

export default QualityPanel;
