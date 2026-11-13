/**
 * shadcn/ui theme tokens (the `--background`, `--primary`, … CSS variables)
 * as `#RRGGBB[AA]` colors the Metal renderer accepts. Every registry theme
 * ships (`themes.generated.ts`); `ThemeProvider` picks one and components
 * read it through `useTheme()`.
 */

import { createContext, use, useContext } from "react";
import { THEMES } from "./themes.generated.ts";

export type ThemeName = keyof typeof THEMES;

/** The CSS variables a shadcn theme defines, camelCased (`muted-foreground` → `mutedForeground`). */
export interface ThemeTokens {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  border: string;
  input: string;
  ring: string;
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarPrimary: string;
  sidebarPrimaryForeground: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  sidebarBorder: string;
  sidebarRing: string;
}

export interface Theme {
  name: ThemeName;
  mode: "light" | "dark";
  colors: ThemeTokens;
  /** `--radius`, in px. */
  radius: number;
}

/** Build a theme from a registry name and mode. Missing tokens fall back to neutral. */
export function createTheme(name: ThemeName = "neutral", mode: "light" | "dark" = "dark"): Theme {
  const base = THEMES.neutral[mode] as unknown as ThemeTokens;
  const chosen = THEMES[name][mode] as unknown as Partial<ThemeTokens>;
  return {
    name,
    mode,
    colors: { ...base, ...chosen },
    radius: THEMES[name].radius,
  };
}

export const darkTheme: Theme = createTheme("neutral", "dark");
export const lightTheme: Theme = createTheme("neutral", "light");
export const darkTokens: ThemeTokens = darkTheme.colors;
export const lightTokens: ThemeTokens = lightTheme.colors;
export const themeNames = Object.keys(THEMES) as ThemeName[];

export interface ThemeApi extends Theme {
  /** The chosen setting, `next-themes` style: `"light" | "dark" | "system"`. */
  theme: "light" | "dark" | "system";
  /** The mode actually in use (`next-themes`' `resolvedTheme`). */
  resolvedTheme: "light" | "dark";
  /** Switch mode (`next-themes`-style `setTheme("light" | "dark" | "system")`). */
  setTheme: (mode: "light" | "dark" | "system") => void;
  /** Switch the registry palette (`neutral`, `zinc`, `blue`, …). */
  setThemeName: (name: ThemeName) => void;
  /** Window width in px, for responsive variants. */
  viewportWidth: number;
}

export const ThemeContext = createContext<ThemeApi>({
  ...darkTheme,
  theme: "dark",
  resolvedTheme: "dark",
  setTheme: () => {},
  setThemeName: () => {},
  viewportWidth: 1280,
});

export function useTheme(): ThemeApi {
  return useContext(ThemeContext);
}

/**
 * What styling reads of the theme. `viewportWidth` is the widest breakpoint
 * the window has reached (`breakpointFloor`), not its width: it answers every
 * breakpoint variant the same, and the value changes only when one is
 * crossed, so a window being resized re-renders no element until then.
 */
export interface StyleTheme {
  colors: ThemeTokens;
  radius: number;
  mode: "light" | "dark";
  viewportWidth: number;
}

/** Provided by `ThemeScope` (provider.tsx) beside `ThemeContext`; null under a bare `ThemeContext`. */
export const StyleThemeContext = createContext<StyleTheme | null>(null);

/** The theme as elements style themselves by it (`Box`, icons, inputs). */
export function useStyleTheme(): StyleTheme {
  // `use`, not `useContext`: the whole theme is read (and followed) only where no scope is.
  return useContext(StyleThemeContext) ?? use(ThemeContext);
}

/** Blend `color` (`#RRGGBB`) with `alpha` in `0..1` into `#RRGGBBAA`. */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.replace("#", "").slice(0, 6);
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${hex}${a}`;
}

/** Lighten (`amount > 0`) or darken (`amount < 0`) a `#RRGGBB` color. */
export function shade(color: string, amount: number): string {
  const hex = color.replace("#", "").slice(0, 6);
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16);
    const next = amount >= 0 ? value + (255 - value) * amount : value * (1 + amount);
    return Math.round(Math.max(0, Math.min(255, next)))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(2)}${channel(4)}`;
}
