/**
 * Tailwind's design scales (v4 defaults) as plain numbers: spacing, named
 * widths, radii, type sizes, line heights, and the default color palette.
 */

/** Tailwind's spacing step, in px (`p-1` = 4px). */
export const SPACING_UNIT = 4;

/** `w-*`/`max-w-*` named sizes (Tailwind v4 container scale). */
export const NAMED_SIZES: Record<string, number> = {
  "3xs": 256,
  "2xs": 288,
  xs: 320,
  sm: 384,
  md: 448,
  lg: 512,
  xl: 576,
  "2xl": 672,
  "3xl": 768,
  "4xl": 896,
  "5xl": 1024,
  "6xl": 1152,
  "7xl": 1280,
  prose: 650,
  "screen-sm": 640,
  "screen-md": 768,
  "screen-lg": 1024,
  "screen-xl": 1280,
};

/** Font size in px and its default line height in px. */
export const TEXT_SIZES: Record<string, [number, number]> = {
  xs: [12, 16],
  sm: [14, 20],
  base: [16, 24],
  lg: [18, 28],
  xl: [20, 28],
  "2xl": [24, 32],
  "3xl": [30, 36],
  "4xl": [36, 40],
  "5xl": [48, 48],
  "6xl": [60, 60],
  "7xl": [72, 72],
};

/** `leading-*` keywords as multipliers of the font size. */
export const LEADING: Record<string, number> = {
  none: 1,
  tight: 1.25,
  snug: 1.375,
  normal: 1.5,
  relaxed: 1.625,
  loose: 2,
};

/** Radii relative to `--radius` (shadcn defines sm/md/lg/xl from it). */
export function radius(name: string, base: number): number | undefined {
  switch (name) {
    case "none":
      return 0;
    case "xs":
      return 2;
    case "sm":
      return Math.max(0, base - 4);
    case "":
      return 4;
    case "md":
      return Math.max(0, base - 2);
    case "lg":
      return base;
    case "xl":
      return base + 4;
    case "2xl":
      return 16;
    case "3xl":
      return 24;
    case "4xl":
      return 32;
    case "full":
      return 9999;
    default: {
      const px = name.match(/^\[(\d+(?:\.\d+)?)px\]$/);
      return px ? Number(px[1]) : undefined;
    }
  }
}

/** Parse a spacing token: `4` → 16, `1.5` → 6, `px` → 1, `[13px]` → 13. */
export function spacing(token: string): number | undefined {
  if (token === "px") return 1;
  if (token === "0") return 0;
  const px = token.match(/^\[(-?\d+(?:\.\d+)?)(px|rem)?\]$/);
  if (px) return Number(px[1]) * (px[2] === "rem" ? 16 : 1);
  const value = Number(token);
  return Number.isFinite(value) ? value * SPACING_UNIT : undefined;
}

/** Parse a fraction token: `1/2` → 0.5, `full` → 1, `[40%]` → 0.4. */
export function fraction(token: string): number | undefined {
  if (token === "full") return 1;
  const ratio = token.match(/^(\d+)\/(\d+)$/);
  if (ratio) return Number(ratio[1]) / Number(ratio[2]);
  const percent = token.match(/^\[(\d+(?:\.\d+)?)%\]$/);
  return percent ? Number(percent[1]) / 100 : undefined;
}

/** Tailwind v4 default palette (the shades shadcn examples use). */
export const PALETTE: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  transparent: "#00000000",
  "slate-50": "#f8fafc",
  "slate-100": "#f1f5f9",
  "slate-200": "#e2e8f0",
  "slate-300": "#cbd5e1",
  "slate-400": "#94a3b8",
  "slate-500": "#64748b",
  "slate-600": "#475569",
  "slate-700": "#334155",
  "slate-800": "#1e293b",
  "slate-900": "#0f172a",
  "slate-950": "#020617",
  "gray-50": "#f9fafb",
  "gray-100": "#f3f4f6",
  "gray-200": "#e5e7eb",
  "gray-300": "#d1d5db",
  "gray-400": "#9ca3af",
  "gray-500": "#6b7280",
  "gray-600": "#4b5563",
  "gray-700": "#374151",
  "gray-800": "#1f2937",
  "gray-900": "#111827",
  "gray-950": "#030712",
  "zinc-50": "#fafafa",
  "zinc-100": "#f4f4f5",
  "zinc-200": "#e4e4e7",
  "zinc-300": "#d4d4d8",
  "zinc-400": "#a1a1aa",
  "zinc-500": "#71717a",
  "zinc-600": "#52525b",
  "zinc-700": "#3f3f46",
  "zinc-800": "#27272a",
  "zinc-900": "#18181b",
  "zinc-950": "#09090b",
  "neutral-50": "#fafafa",
  "neutral-100": "#f5f5f5",
  "neutral-200": "#e5e5e5",
  "neutral-300": "#d4d4d4",
  "neutral-400": "#a3a3a3",
  "neutral-500": "#737373",
  "neutral-600": "#525252",
  "neutral-700": "#404040",
  "neutral-800": "#262626",
  "neutral-900": "#171717",
  "neutral-950": "#0a0a0a",
  "red-50": "#fef2f2",
  "red-100": "#fee2e2",
  "red-200": "#fecaca",
  "red-400": "#f87171",
  "red-500": "#ef4444",
  "red-600": "#dc2626",
  "red-700": "#b91c1c",
  "red-800": "#991b1b",
  "red-900": "#7f1d1d",
  "orange-500": "#f97316",
  "orange-600": "#ea580c",
  "amber-100": "#fef3c7",
  "amber-400": "#fbbf24",
  "amber-500": "#f59e0b",
  "amber-600": "#d97706",
  "yellow-400": "#facc15",
  "yellow-500": "#eab308",
  "lime-500": "#84cc16",
  "green-50": "#f0fdf4",
  "green-100": "#dcfce7",
  "green-400": "#4ade80",
  "green-500": "#22c55e",
  "green-600": "#16a34a",
  "green-700": "#15803d",
  "emerald-500": "#10b981",
  "emerald-600": "#059669",
  "teal-500": "#14b8a6",
  "cyan-500": "#06b6d4",
  "sky-500": "#0ea5e9",
  "blue-50": "#eff6ff",
  "blue-100": "#dbeafe",
  "blue-400": "#60a5fa",
  "blue-500": "#3b82f6",
  "blue-600": "#2563eb",
  "blue-700": "#1d4ed8",
  "indigo-500": "#6366f1",
  "violet-500": "#8b5cf6",
  "purple-500": "#a855f7",
  "purple-600": "#9333ea",
  "fuchsia-500": "#d946ef",
  "pink-500": "#ec4899",
  "rose-500": "#f43f5e",
};
