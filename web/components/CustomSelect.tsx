import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface Option {
    value: string;
    label: string;
    // v0.9.1：可选 Material Symbols 图标名。Composer 底部与 Popdown 并列的
    // 策略下拉用它来和旁边的 私聊/扮演/钦点 按钮保持"图标+文字+箭头"统一视觉。
    icon?: string;
}

interface CustomSelectProps {
    value: string;
    onChange: (value: string) => void;
    options: Option[];
    className?: string;
    disabled?: boolean;
    placeholder?: string;
    /**
     * 下拉弹出方向：
     *   - 'auto'（默认）：根据窗口空间自动选择；空间够就向下，不够就向上。
     *   - 'up'：强制向上弹出。用于页面底部工具条（如 Composer），避免下方空间充裕却与
     *     其他 Popdown 方向不一致造成的视觉跳变。
     *   - 'down'：强制向下弹出。
     */
    placement?: 'auto' | 'up' | 'down';
}

const CustomSelect: React.FC<CustomSelectProps> = ({
    value,
    onChange,
    options,
    className = '',
    disabled = false,
    placeholder,
    placement = 'auto',
}) => {
    const [open, setOpen] = useState(false);
    const [hl, setHl] = useState(-1);
    const ref = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
    // v0.9.2：只有键盘导航或首次打开时才需要 scrollIntoView，避免鼠标 hover→setHl→scroll→元素漂移→
    // 再次触发 hover 的反馈循环（"点不中列表项"根因）。
    const hlFromKeyboardRef = useRef(false);

    const selected = options.find(o => o.value === value);

    // 计算下拉面板位置（portal 模式需要绝对坐标）
    useEffect(() => {
        if (!open || !ref.current) return;
        const update = (event?: Event) => {
            if (event?.target && listRef.current?.contains(event.target as Node)) return;
            const rect = ref.current!.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            const dropH = Math.min(options.length * 30 + 8, 208); // max-h-52 = 208px
            // placement 'up' / 'down' 强制覆盖自动判定；'auto' 时按空间选方向。
            const above = placement === 'up'
                ? true
                : placement === 'down'
                    ? false
                    : (spaceBelow < dropH && rect.top > spaceBelow);
            // fixed 定位：直接用 viewport 坐标，不加 scroll offset
            setPos({
                top: above ? rect.top - dropH - 4 : rect.bottom + 4,
                left: rect.left,
                width: rect.width,
            });
        };
        update();
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
        };
    }, [open, options.length, placement]);

    // 点击外部关闭
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node) &&
                listRef.current && !listRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    // 打开时重置高亮到当前选中项（视为键盘触发，允许一次 scrollIntoView 把选中项带入视口）
    useEffect(() => {
        if (open) {
            const idx = options.findIndex(o => o.value === value);
            hlFromKeyboardRef.current = true;
            setHl(idx >= 0 ? idx : 0);
        }
    }, [open, options, value]);

    // 滚动高亮项可见：仅键盘/初始打开触发；hover 不参与，避免 scroll→hover 反馈循环
    useEffect(() => {
        if (!open || hl < 0 || !listRef.current) return;
        if (!hlFromKeyboardRef.current) return;
        hlFromKeyboardRef.current = false;
        const el = listRef.current.children[hl] as HTMLElement | undefined;
        el?.scrollIntoView({ block: 'nearest' });
    }, [hl, open]);

    const handleKey = useCallback((e: React.KeyboardEvent) => {
        if (disabled) return;
        if (!open) {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                e.preventDefault();
                setOpen(true);
            }
            return;
        }
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                hlFromKeyboardRef.current = true;
                setHl(h => Math.min(h + 1, options.length - 1));
                break;
            case 'ArrowUp':
                e.preventDefault();
                hlFromKeyboardRef.current = true;
                setHl(h => Math.max(h - 1, 0));
                break;
            case 'Enter':
                e.preventDefault();
                if (hl >= 0 && hl < options.length) {
                    onChange(options[hl].value);
                    setOpen(false);
                }
                break;
            case 'Escape':
                e.preventDefault();
                setOpen(false);
                break;
        }
    }, [open, hl, options, onChange, disabled]);

    // v0.9.1：当任一 option 带 icon 时，进入"Popdown 风格"：触发按钮左侧显示当前项图标，
    // 下拉列表每行也显示图标。这样在 Composer 底部与相邻的 private-mention / 扮演 / 钦点
    // Popdown 按钮保持一致的"图标+文字+向下箭头"视觉。
    const hasAnyIcon = options.some(o => !!o.icon);

    return (
        <div ref={ref} className={`relative ${className} !bg-transparent !border-none !ring-0 !shadow-none !p-0 !rounded-none`} onKeyDown={handleKey} style={{ border: 'none' }}>
            {/* 触发按钮 */}
            <button
                type="button"
                disabled={disabled}
                onClick={() => !disabled && setOpen(!open)}
                className={`w-full flex items-center justify-between gap-1 text-start cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${className}`}
                tabIndex={0}
            >
                {/* v0.9.1：触发按钮不显示图标，保持与 Popdown 触发（单文字+箭头）等宽的紧凑外观；
                    图标仅出现在展开后的列表项左侧，用于视觉分辨不同选项。 */}
                <span className="truncate flex-1 whitespace-nowrap" title={selected ? selected.label : undefined}>
                    {selected ? selected.label : (placeholder || '—')}
                </span>
                {/* v0.9.1：箭头尺寸/透明度与 Popdown 对齐（12px · 60% opacity），
                    open 时旋转 180° 保留原交互语义。 */}
                <span className={`material-symbols-outlined text-[12px] opacity-60 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}>
                    expand_more
                </span>
            </button>

            {/* 下拉面板 (portal to body to escape overflow clipping) */}
            {open && pos && createPortal(
                <div
                    ref={listRef}
                    className="fixed z-[9999] max-h-52 overflow-y-auto rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-[#1e2028] shadow-xl shadow-black/10 dark:shadow-black/40 py-1"
                    style={{ top: pos.top, left: pos.left, width: pos.width, colorScheme: 'light dark' }}
                >
                    {options.map((o, idx) => (
                        <button
                            key={o.value}
                            type="button"
                            title={o.label}
                            onMouseEnter={() => setHl(idx)}
                            onMouseDown={(e) => { e.preventDefault(); onChange(o.value); setOpen(false); }}
                            className={`w-full text-start px-3 py-1.5 text-[11px] transition-colors truncate inline-flex items-center gap-2 ${o.value === value
                                ? 'text-primary font-bold bg-primary/5 dark:bg-primary/10'
                                : idx === hl
                                    ? 'bg-slate-100 dark:bg-white/10 text-slate-700 dark:text-white'
                                    : 'text-slate-600 dark:text-white/70 hover:bg-slate-50 dark:hover:bg-white/[0.06]'
                                }`}
                        >
                            {hasAnyIcon && (
                                // 即使某个 option 没提供 icon，也留 14px 占位槽，保持左缘对齐。
                                <span className="material-symbols-outlined text-[14px] w-[14px] shrink-0">
                                    {o.icon || ''}
                                </span>
                            )}
                            <span className="flex-1 truncate">{o.label}</span>
                        </button>
                    ))}
                </div>,
                document.body
            )}
        </div>
    );
};

export default CustomSelect;
