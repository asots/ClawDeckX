/**
 * Convert Tailwind color classes from template JSON to inline CSS styles.
 * Tailwind 4.x JIT cannot scan runtime-loaded JSON templates, so dynamic
 * color classes like "from-cyan-500 to-blue-500" or "bg-blue-500" are never
 * compiled into the CSS output. This utility resolves them to inline styles.
 */

const TW_COLORS: Record<string, string> = {
  // -400 variants
  'slate-400': '#94a3b8',
  'red-400': '#f87171',
  'orange-400': '#fb923c',
  'amber-400': '#fbbf24',
  'yellow-400': '#facc15',
  'lime-400': '#a3e635',
  'green-400': '#4ade80',
  'emerald-400': '#34d399',
  'teal-400': '#2dd4bf',
  'cyan-400': '#22d3ee',
  'sky-400': '#38bdf8',
  'blue-400': '#60a5fa',
  'indigo-400': '#818cf8',
  'violet-400': '#a78bfa',
  'purple-400': '#c084fc',
  'fuchsia-400': '#e879f9',
  'pink-400': '#f472b6',
  'rose-400': '#fb7185',
  // -500 variants (primary)
  'slate-500': '#64748b',
  'zinc-500': '#71717a',
  'zinc-600': '#52525b',
  'red-500': '#ef4444',
  'orange-500': '#f97316',
  'amber-500': '#f59e0b',
  'yellow-500': '#eab308',
  'lime-500': '#84cc16',
  'green-500': '#22c55e',
  'emerald-500': '#10b981',
  'teal-500': '#14b8a6',
  'cyan-500': '#06b6d4',
  'sky-500': '#0ea5e9',
  'blue-500': '#3b82f6',
  'indigo-500': '#6366f1',
  'violet-500': '#8b5cf6',
  'purple-500': '#a855f7',
  'fuchsia-500': '#d946ef',
  'pink-500': '#ec4899',
  'rose-500': '#f43f5e',
  // -600 variants
  'slate-600': '#475569',
  'red-600': '#dc2626',
  'orange-600': '#ea580c',
  'amber-600': '#d97706',
  'lime-600': '#65a30d',
  'green-600': '#16a34a',
  'emerald-600': '#059669',
  'teal-600': '#0d9488',
  'cyan-600': '#0891b2',
  'sky-600': '#0284c7',
  'blue-600': '#2563eb',
  'indigo-600': '#4f46e5',
  'violet-600': '#7c3aed',
  'purple-600': '#9333ea',
  'fuchsia-600': '#c026d3',
  'pink-600': '#db2777',
  'rose-600': '#e11d48',
  // -700/-900 variants (dark accents used in war-room, adversarial)
  'gray-700': '#374151',
  'slate-700': '#334155',
  'zinc-700': '#3f3f46',
  'zinc-800': '#27272a',
  'zinc-900': '#18181b',
};

const DEFAULT_GRADIENT = { from: '#a855f7', to: '#ec4899' }; // purple-500 → pink-500
const DEFAULT_SOLID = '#64748b'; // slate-500

/**
 * Parse a template color string into an inline CSS `background` value.
 *
 * Supported formats:
 *   "from-cyan-500 to-blue-500"              → 2-stop linear-gradient
 *   "from-cyan-400 via-blue-500 to-indigo-500" → 3-stop linear-gradient (v0.9)
 *   "bg-blue-500"                            → solid color
 *   "bg-gradient-to-br from-..."             → linear-gradient (strip prefix)
 *
 * v0.9 note: most of the built-in room templates use the three-stop
 * `from-X via-Y to-Z` form. Tailwind 4.x JIT cannot see these classes
 * because they live in runtime JSON returned from the Go backend —— the
 * result was template cards rendering as dark surface fallback. Resolving
 * to inline styles here is the fix.
 */
export function resolveTemplateColor(colorClass: string | undefined): React.CSSProperties {
  if (!colorClass) {
    return { background: `linear-gradient(135deg, ${DEFAULT_GRADIENT.from}, ${DEFAULT_GRADIENT.to})` };
  }

  const tokens = colorClass.trim().split(/\s+/);

  let from: string | null = null;
  let via: string | null = null;
  let to: string | null = null;
  let solid: string | null = null;

  for (const t of tokens) {
    if (t.startsWith('from-')) {
      from = TW_COLORS[t.slice(5)] ?? null;
    } else if (t.startsWith('via-')) {
      via = TW_COLORS[t.slice(4)] ?? null;
    } else if (t.startsWith('to-')) {
      to = TW_COLORS[t.slice(3)] ?? null;
    } else if (t.startsWith('bg-') && !t.startsWith('bg-gradient')) {
      solid = TW_COLORS[t.slice(3)] ?? null;
    }
  }

  // 三色渐变优先：比两色更丰富的色彩层次，对应 Tailwind 的 `from-X via-Y to-Z`。
  if (from && via && to) {
    return { background: `linear-gradient(135deg, ${from}, ${via}, ${to})` };
  }
  if (from && to) {
    return { background: `linear-gradient(135deg, ${from}, ${to})` };
  }
  if (from && via) {
    return { background: `linear-gradient(135deg, ${from}, ${via})` };
  }
  if (from) {
    return { background: from };
  }
  if (solid) {
    return { background: solid };
  }

  return { background: DEFAULT_SOLID };
}

/**
 * Resolve a template color string to a single hex color (for SVG fill etc.).
 * Returns the "from" color for gradients, or the solid color.
 */
export function resolveTemplateHex(colorClass: string | undefined): string {
  if (!colorClass) return DEFAULT_GRADIENT.from;

  const tokens = colorClass.trim().split(/\s+/);
  for (const t of tokens) {
    if (t.startsWith('from-')) {
      return TW_COLORS[t.slice(5)] ?? DEFAULT_GRADIENT.from;
    }
    if (t.startsWith('bg-') && !t.startsWith('bg-gradient')) {
      return TW_COLORS[t.slice(3)] ?? DEFAULT_SOLID;
    }
  }
  return DEFAULT_SOLID;
}
