// SafetyPanel —— 房间级安全开关（只读 / 变更演练）
//
// 两个开关都是 Room 顶级 boolean 字段，通过 setRoomSafety(PATCH /rooms/:id) 更新。
// 只读：agent 全员静默（scheduler.Pick 兜底），人类仍可发言；适合复盘、事后解释。
// 变更演练：agent 可发言但 prompt 要求不实际触发工具副作用；适合彩排、教学、审计回放。

import React from 'react';
import { setRoomSafety } from '../service';
import type { Room } from '../types';

interface Props {
  room: Room;
}

const Row: React.FC<{
  label: string;
  desc: string;
  tone: string;
  icon: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, desc, tone, icon, checked, onChange }) => (
  <label className={`flex items-start gap-2 px-2 py-1.5 rounded-md border cursor-pointer transition ${
    checked ? `${tone} border-current` : 'bg-surface-raised border-border hover:bg-surface-sunken'
  }`}>
    <span className={`material-symbols-outlined text-[18px] mt-0.5 ${checked ? '' : 'text-text-muted'}`}>{icon}</span>
    <span className="flex-1 min-w-0">
      <span className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-text truncate">{label}</span>
        <input
          type="checkbox"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
          className="accent-primary shrink-0"
        />
      </span>
      <span className="block text-[10px] text-text-muted leading-snug mt-0.5">{desc}</span>
    </span>
  </label>
);

const SafetyPanel: React.FC<Props> = ({ room }) => {
  const setReadonly = async (v: boolean) => {
    await setRoomSafety(room.id, { readonly: v }).catch(() => { /* toast via service */ });
  };
  const setDryRun = async (v: boolean) => {
    await setRoomSafety(room.id, { mutationDryRun: v }).catch(() => { /* toast via service */ });
  };
  return (
    <div className="space-y-1.5">
      <Row
        label="只读模式"
        desc="所有 agent 静默；只有人可以发言。适合复盘、事后总结、演示录像。"
        tone="bg-amber-500/10 text-amber-600 dark:text-amber-400"
        icon="lock"
        checked={!!room.readonly}
        onChange={setReadonly}
      />
      <Row
        label="变更演练 · dry-run"
        desc="Agent 仍可发言，但不要真调工具副作用——规划/解释『我会写什么』代替实际执行。"
        tone="bg-blue-500/10 text-blue-600 dark:text-blue-400"
        icon="science"
        checked={!!room.mutationDryRun}
        onChange={setDryRun}
      />
      {(room.readonly || room.mutationDryRun) && (
        <div className="mt-1 px-2 py-1 rounded-md bg-surface-sunken text-[10px] text-text-muted leading-snug">
          安全开关会作为 system prompt 的一部分注入每一轮；模型是否遵守取决于其本身服从度，人类仍需把关。
        </div>
      )}
    </div>
  );
};

export default SafetyPanel;
