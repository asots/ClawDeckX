// VersionPicker —— "指定版本升级"下拉
//
// 为 ClawDeckX / OpenClaw 两个升级卡片共用的版本选择组件。视觉上与
// TranslateModelPicker 对齐（label + 高 36px 的 CustomSelect），外加一个同高度
// 的刷新按钮。值为空字符串代表"最新稳定版"，即走各自默认行为。
//
// 选项后缀徽章：
//   - current / older / beta / no asset（均为本地化文案，由调用方传入 labels）
// "no asset" 仅 ClawDeckX 会有（按当前平台匹配资产）；OpenClaw 走 npm tag，全部可装。

import React from 'react';
import CustomSelect from './CustomSelect';

export interface ReleaseItem {
  tagName: string;
  prerelease: boolean;
  hasAsset: boolean;
  isCurrent?: boolean;
  isOlder?: boolean;
}

export interface VersionPickerLabels {
  /** 左侧 label，如"指定版本"。 */
  title: string;
  /** 占位项文案，例如"最新稳定版"。 */
  latest: string;
  /** 徽章文案。 */
  current: string;
  older: string;
  beta: string;
  noAsset: string;
  /** 刷新按钮 tooltip。 */
  refresh: string;
}

export interface VersionPickerProps {
  value: string;                                 // 选中的 tag（不带 v）；'' = 最新
  onChange: (tag: string) => void;
  releases: ReleaseItem[];
  labels: VersionPickerLabels;
  loading?: boolean;
  onRefresh?: () => void;
  /** 下拉弹出方向；默认 auto。 */
  placement?: 'auto' | 'up' | 'down';
  /** inline 模式：去掉 mb-3，外层变成 flex-1，便于与其它按钮横向并排。 */
  inline?: boolean;
}

const VersionPicker: React.FC<VersionPickerProps> = ({
  value,
  onChange,
  releases,
  labels,
  loading = false,
  onRefresh,
  placement = 'auto',
  inline = false,
}) => {
  const options = [
    { value: '', label: labels.latest },
    ...releases.map(r => {
      const plain = r.tagName.replace(/^v/, '');
      const tags: string[] = [];
      if (r.isCurrent) tags.push(labels.current);
      else if (r.isOlder) tags.push(labels.older);
      if (r.prerelease) tags.push(labels.beta);
      if (!r.hasAsset) tags.push(labels.noAsset);
      const suffix = tags.length > 0 ? `  (${tags.join(' · ')})` : '';
      return { value: plain, label: `v${plain}${suffix}` };
    }),
  ];

  // inline 模式：宽度自适应（不抢占 flex-1），让调用方的其它按钮可以在同一行并排。
  // 默认模式：保留 mb-3 与 flex-1 的 CustomSelect，独占一行。
  const rootCls = inline
    ? 'inline-flex items-center gap-2 min-w-0'
    : 'mb-3 flex items-center gap-2';
  const selectCls = inline
    ? 'h-9 px-3 min-w-[140px] max-w-[240px] bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg text-[12px] text-slate-700 dark:text-white/80 outline-none'
    : 'flex-1 min-w-0 h-9 px-3 bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg text-[12px] text-slate-700 dark:text-white/80 outline-none';
  return (
    <div className={rootCls}>
      <span className="text-[12px] font-medium text-slate-500 dark:text-white/40 shrink-0">
        {labels.title}
      </span>
      <CustomSelect
        value={value}
        onChange={onChange}
        options={options}
        placement={placement}
        className={selectCls}
      />
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          title={labels.refresh}
          className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg border border-slate-200 dark:border-white/10 text-slate-500 dark:text-white/40 hover:bg-slate-50 dark:hover:bg-white/5 disabled:opacity-40"
        >
          <span className={`material-symbols-outlined text-[16px] ${loading ? 'animate-spin' : ''}`}>refresh</span>
        </button>
      )}
    </div>
  );
};

export default VersionPicker;
