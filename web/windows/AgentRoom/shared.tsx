// AgentRoom 共用小组件与工具
import React from 'react';
import type { Member, MemberStatus, RoomPolicy } from './types';

// ── 成员头像 ──

export const MemberAvatar: React.FC<{
  member: Member;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  showStatus?: boolean;
  glow?: boolean;
  impersonated?: boolean;
}> = ({ member, size = 'md', showStatus = true, glow, impersonated }) => {
  const sizeMap = {
    xs: 'w-6 h-6 text-[11px]',
    sm: 'w-8 h-8 text-[14px]',
    md: 'w-10 h-10 text-[18px]',
    lg: 'w-14 h-14 text-[24px]',
  };
  const talking = member.status === 'speaking' || member.status === 'thinking';
  const ringCls = glow || talking
    ? 'ring-2 ring-cyan-400/60 dark:ring-cyan-400/80 shadow-[0_0_12px_var(--glow-cyan)] animate-glow-breathe'
    : member.isModerator
      ? 'ring-2 ring-purple-400/50 dark:ring-purple-400/60'
      : 'ring-1 ring-black/5 dark:ring-white/10';
  return (
    <div className="relative shrink-0">
      <div
        className={`${sizeMap[size]} rounded-xl flex items-center justify-center font-semibold select-none overflow-hidden transition-all ${ringCls}`}
        style={{
          background: member.emoji ? 'transparent' : `linear-gradient(135deg, ${member.avatarColor || '#00c8ff'}, ${member.avatarColor || '#8b5cf6'})`,
        }}
        aria-label={member.name}
      >
        {member.emoji ? (
          <span className="leading-none">{member.emoji}</span>
        ) : (
          <span className="text-white font-bold">{member.name.slice(0, 1).toUpperCase()}</span>
        )}
      </div>
      {member.isModerator && (
        <span className="absolute -top-1 -start-1 text-[10px] bg-purple-500 text-white rounded-full w-4 h-4 flex items-center justify-center shadow leading-none">🎩</span>
      )}
      {impersonated && (
        <span className="absolute -bottom-1 -end-1 text-[10px] bg-amber-500 text-white rounded-full w-4 h-4 flex items-center justify-center shadow leading-none">👻</span>
      )}
      {showStatus && <StatusDot status={member.status} />}
    </div>
  );
};

// ── 状态点 ──

export const StatusDot: React.FC<{ status: MemberStatus }> = ({ status }) => {
  const map: Record<MemberStatus, { color: string; pulse: boolean; title: string }> = {
    idle: { color: 'bg-slate-300 dark:bg-white/25', pulse: false, title: '空闲' },
    thinking: { color: 'bg-cyan-400', pulse: true, title: '思考中' },
    speaking: { color: 'bg-green-400', pulse: true, title: '发言中' },
    tool_call: { color: 'bg-blue-400', pulse: true, title: '调用工具' },
    tool_running: { color: 'bg-blue-500', pulse: true, title: '工具运行中' },
    tool_waiting_approval: { color: 'bg-amber-400', pulse: true, title: '等待审批' },
    muted: { color: 'bg-slate-400', pulse: false, title: '已静音' },
    error: { color: 'bg-red-500', pulse: false, title: '错误' },
    offline: { color: 'bg-slate-500', pulse: false, title: '离线' },
  };
  const cfg = map[status];
  return (
    <span
      className={`absolute -bottom-0.5 -end-0.5 w-3 h-3 rounded-full ring-2 ring-white dark:ring-[#1a1a1e] ${cfg.color} ${cfg.pulse ? 'animate-pulse' : ''}`}
      title={cfg.title}
    />
  );
};

// ── 策略徽章 ──

export const POLICY_META: Record<RoomPolicy, { label: string; icon: string; color: string }> = {
  free: { label: '自由', icon: 'forum', color: 'text-violet-500' },
  reactive: { label: '反应式', icon: 'reply', color: 'text-cyan-500' },
  roundRobin: { label: '轮流', icon: 'rotate_right', color: 'text-blue-500' },
  moderator: { label: '主持人', icon: 'record_voice_over', color: 'text-purple-500' },
  bidding: { label: '竞价发言', icon: 'gavel', color: 'text-amber-500' },
  observer: { label: '静默', icon: 'visibility', color: 'text-slate-500' },
  planned: { label: '结构化执行', icon: 'list_alt', color: 'text-emerald-500' },
  parallel: { label: '并行发言', icon: 'groups', color: 'text-pink-500' },
  debate: { label: '辩论', icon: 'compare_arrows', color: 'text-rose-500' },
};

export const PolicyBadge: React.FC<{ policy: RoomPolicy; onClick?: () => void }> = ({ policy, onClick }) => {
  const meta = POLICY_META[policy];
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-md text-[11px] font-semibold bg-surface-raised hover:bg-surface-sunken border border-border text-text transition-all"
    >
      <span className={`material-symbols-outlined text-[14px] ${meta.color}`}>{meta.icon}</span>
      {meta.label}
      <span className="material-symbols-outlined text-[14px] opacity-50">expand_more</span>
    </button>
  );
};

// ── 成本气泡 ──

export const CostMeter: React.FC<{ used: number; limit: number; compact?: boolean }> = ({ used, limit, compact }) => {
  const pct = Math.min(used / limit, 1);
  const warn = pct >= 0.7;
  const danger = pct >= 0.9;
  const color = danger ? 'from-red-500 to-red-600' : warn ? 'from-amber-400 to-amber-500' : 'from-cyan-400 to-blue-500';
  const textColor = danger ? 'text-red-500' : warn ? 'text-amber-500' : 'text-text';
  return (
    <div className={`inline-flex items-center gap-2 ${compact ? '' : 'px-2.5 h-7 rounded-md bg-surface-raised border border-border'}`} title="房间成本">
      <span className="material-symbols-outlined text-[14px] opacity-60">paid</span>
      <span className={`text-[11px] font-mono font-semibold tabular-nums ${textColor} ${danger ? 'animate-pulse' : ''}`}>
        ¥{used.toFixed(2)}
        <span className="opacity-50"> / ¥{limit}</span>
      </span>
      <div className="relative w-14 h-1.5 rounded-full bg-surface-sunken overflow-hidden">
        <div
          className={`absolute start-0 top-0 h-full bg-gradient-to-r ${color} transition-all duration-500`}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
};

// ── 空信号：思考中三点 ──

export const ThinkingDots: React.FC = () => (
  <div className="inline-flex items-center gap-1" aria-label="正在思考">
    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 stream-dot" style={{ animationDelay: '0ms' }} />
    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 stream-dot" style={{ animationDelay: '160ms' }} />
    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 stream-dot" style={{ animationDelay: '320ms' }} />
  </div>
);

// ── 相对时间格式化 ──

// 用户偏好时区（localStorage UI_TIMEZONE）。留空=跟随浏览器 Intl 默认。
// 用户可在"界面"设置里切换；未登录/未配置时回落浏览器默认。
export function getUITimezone(): string | undefined {
  try {
    const v = localStorage.getItem('UI_TIMEZONE');
    return v && v.trim() ? v : undefined;
  } catch { return undefined; }
}

export function setUITimezone(tz: string | null) {
  try {
    if (tz && tz.trim()) localStorage.setItem('UI_TIMEZONE', tz.trim());
    else localStorage.removeItem('UI_TIMEZONE');
  } catch { /* ignore */ }
}

export function relativeTime(ts: number, lang: string = 'zh'): string {
  const diff = Date.now() - ts;
  if (diff < 10_000) return lang.startsWith('zh') ? '刚刚' : 'just now';
  if (diff < 60_000) return lang.startsWith('zh') ? `${Math.floor(diff / 1000)} 秒前` : `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return lang.startsWith('zh') ? `${Math.floor(diff / 60_000)} 分钟前` : `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return lang.startsWith('zh') ? `${Math.floor(diff / 3_600_000)} 小时前` : `${Math.floor(diff / 3_600_000)}h ago`;
  const tz = getUITimezone();
  try {
    return new Date(ts).toLocaleDateString(undefined, tz ? { timeZone: tz } : undefined);
  } catch {
    return new Date(ts).toLocaleDateString();
  }
}

export function formatTime(ts: number): string {
  const tz = getUITimezone();
  if (tz) {
    try {
      // 使用 Intl 以尊重用户时区；仍然固定 HH:mm:ss 形式
      return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, timeZone: tz,
      }).format(new Date(ts));
    } catch { /* fallthrough */ }
  }
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ── 面板折叠容器 ──

export const CollapsibleSection: React.FC<{
  title: string;
  icon: string;
  defaultOpen?: boolean;
  badge?: React.ReactNode;
  /**
   * v0.9：未读项数徽章。>0 时在标题前渲染一个绿色呼吸圆点 + 数字，提示"本面板有新产出还没看"。
   * 展开面板时会通过 onOpenChange(true) 回调让父组件把计数清零；重新折叠后重新累计。
   * 这是"产能可见性"机制——当 agent 自动生成议程/风险/问题/任务时，折叠着的面板也能
   * 第一时间让用户感知到。
   */
  unseenCount?: number;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ title, icon, defaultOpen = true, badge, unseenCount = 0, onOpenChange, children, actions }) => {
  const [open, setOpen] = React.useState(defaultOpen);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    onOpenChange?.(next);
  };
  // 展开时清零（告知父组件），但内部 state 保持，仅 unseen badge 依赖父传 prop。
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-center justify-between px-3 py-2">
        <button
          onClick={toggle}
          className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-text-muted hover:text-text transition-colors"
        >
          <span className={`material-symbols-outlined text-[15px] transition-transform duration-200 ${open ? 'rotate-90' : ''}`}>chevron_right</span>
          <span className="material-symbols-outlined text-[14px] text-cyan-500/70">{icon}</span>
          {title}
          {/* 未读圆点：折叠时尤其醒目；展开时也保留直到用户再次折叠（父组件那时重置过计数） */}
          {unseenCount > 0 && (
            <span
              className="inline-flex items-center gap-0.5 ms-0.5"
              title={`${unseenCount} new since you last opened`}
              aria-label={`${unseenCount} new items`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)] animate-pulse" />
              <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 normal-case tracking-normal">
                {unseenCount > 9 ? '9+' : unseenCount}
              </span>
            </span>
          )}
          {badge}
        </button>
        {open && actions && <div className="flex items-center gap-1">{actions}</div>}
      </div>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
};
