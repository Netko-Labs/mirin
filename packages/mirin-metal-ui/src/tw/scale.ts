/**
 * Tailwind's design scales (v4 defaults) as plain numbers: spacing, named
 * widths, radii, type sizes, line heights, and the default color palette.
 */

/** Tailwind's spacing step, in px (`p-1` = 4px). */
import { TAILWIND_PALETTE } from "./palette.generated.ts";

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

/** Tailwind v4's default palette (`scripts/gen-palette.ts`) plus the keywords. */
export const PALETTE: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  transparent: "#00000000",
  ...TAILWIND_PALETTE,
};
