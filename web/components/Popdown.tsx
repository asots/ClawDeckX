import React from 'react';
import { createPortal } from 'react-dom';

interface PopdownProps {
  label: string;
  /** Material Symbols 图标名；留空则不渲染图标，按钮仅显示 label + 箭头。 */
  icon?: string;
  title: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  children: React.ReactNode;
  direction?: 'up' | 'down';
  disabled?: boolean;
}

const Popdown: React.FC<PopdownProps> = ({ label, icon, title, open, setOpen, children, direction = 'up', disabled }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);

  React.useEffect(() => {
    if (!open || !ref.current) return;
    const update = () => {
      // fixed 定位：直接用 viewport 坐标，不加 scroll offset
      const rect = ref.current!.getBoundingClientRect();
      if (direction === 'up') {
        setPos({ top: rect.top - 6, left: rect.left });
      } else {
        setPos({ top: rect.bottom + 6, left: rect.left });
      }
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, direction]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        title={title}
        className={`inline-flex items-center gap-1 px-2 h-7 rounded-md text-[11px] font-semibold whitespace-nowrap transition-all ${disabled ? 'bg-surface-raised/40 text-text-disabled border border-border cursor-not-allowed opacity-50' : open ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/30' : 'bg-surface-raised hover:bg-surface-sunken text-text-secondary border border-border'}`}
      >
        {icon && <span className="material-symbols-outlined text-[14px]">{icon}</span>}
        <span className="hidden sm:inline whitespace-nowrap">{label}</span>
        <span className="material-symbols-outlined text-[12px] opacity-60">expand_more</span>
      </button>
      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[9999] min-w-[200px] bg-surface-overlay backdrop-blur-md rounded-lg border border-border shadow-xl py-1 animate-card-enter"
            style={{
              left: pos.left,
              ...(direction === 'up'
                ? { bottom: window.innerHeight - pos.top }
                : { top: pos.top }),
            }}
          >
            {children}
          </div>
        </>,
        document.body
      )}
    </div>
  );
};

export default Popdown;
