// HumanNeededBanner —— 人类需求提示条
//
// 展示最近的、未"已读"的 human-needed 软标记。
// 数据源：Message[] 过滤 humanNeeded 非空、且 timestamp > 上次"我看了"时间戳。
// 点消息定位跳转；点 "我看过了" 把当前时间写入 localStorage，隐藏该房间 banner 直到有新条目。

import React, { useMemo } from 'react';
import type { Member, Message } from '../types';

interface Props {
  roomId: string;
  messages: Message[];
  members: Map<string, Member>;
  onJump?: (messageId: string) => void;
}

function lastSeenKey(roomId: string) {
  return `agentroom:human-needed:seen:${roomId}`;
}

const HumanNeededBanner: React.FC<Props> = ({ roomId, messages, members, onJump }) => {
  const [, tick] = React.useReducer(x => x + 1, 0);
  const lastSeen = (() => {
    try { return parseInt(localStorage.getItem(lastSeenKey(roomId)) || '0') || 0; }
    catch { return 0; }
  })();

  const pending = useMemo(
    () => messages
      .filter(m => m.humanNeeded && !m.deleted && m.timestamp > lastSeen)
      .slice(-3),
    [messages, lastSeen],
  );

  if (pending.length === 0) return null;

  const markSeen = () => {
    try {
      localStorage.setItem(lastSeenKey(roomId), String(Date.now()));
      tick();
    } catch { /* ignore */ }
  };

  const latest = pending[pending.length - 1];
  const author = members.get(latest.authorId);

  return (
    <div className="mx-3 my-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 animate-fade-in">
      <div className="flex items-start gap-2">
        <span className="material-symbols-outlined text-[20px] text-amber-500 animate-pulse shrink-0">pan_tool</span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-amber-700 dark:text-amber-300">
            {pending.length > 1
              ? `有 ${pending.length} 条消息请求人类介入`
              : `${author?.name ?? latest.authorId} 请求你介入`}
          </div>
          <div className="text-[11px] text-text-secondary mt-0.5 line-clamp-2 break-words">
            {latest.humanNeeded}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onJump && (
            <button
              type="button"
              onClick={() => onJump(latest.id)}
              className="px-2 h-6 rounded text-[11px] font-semibold bg-amber-500/20 hover:bg-amber-500/30 text-amber-700 dark:text-amber-200 border border-amber-500/40"
            >查看</button>
          )}
          <button
            type="button"
            onClick={markSeen}
            className="px-2 h-6 rounded text-[11px] text-text-muted hover:text-text hover:bg-surface-sunken"
            title="标记全部已读"
          >已读</button>
        </div>
      </div>
    </div>
  );
};

export default HumanNeededBanner;
