/**
 * shadcn/ui theme tokens (the `--background`, `--primary`, … CSS variables)
 * as `#RRGGBB` colors the Metal renderer accepts. Both default palettes ship;
 * `ThemeProvider` picks one and components read it through `useTheme()`.
 */

import { createContext, useContext } from "react";

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
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarBorder: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  sidebarPrimary: string;
  sidebarPrimaryForeground: string;
}

export interface Theme {
  mode: "light" | "dark";
  colors: ThemeTokens;
  /** `--radius`, in px. */
  radius: number;
}

/** shadcn "zinc" defaults, converted from oklch to hex. */
export const lightTokens: ThemeTokens = {
  background: "#ffffff",
  foreground: "#09090b",
  card: "#ffffff",
  cardForeground: "#09090b",
  popover: "#ffffff",
  popoverForeground: "#09090b",
  primary: "#18181b",
  primaryForeground: "#fafafa",
  secondary: "#f4f4f5",
  secondaryForeground: "#18181b",
  muted: "#f4f4f5",
  mutedForeground: "#71717a",
  accent: "#f4f4f5",
  accentForeground: "#18181b",
  destructive: "#dc2626",
  destructiveForeground: "#fafafa",
  border: "#e4e4e7",
  input: "#e4e4e7",
  ring: "#a1a1aa",
  sidebar: "#fafafa",
  sidebarForeground: "#09090b",
  sidebarBorder: "#e4e4e7",
  sidebarAccent: "#f4f4f5",
  sidebarAccentForeground: "#18181b",
  sidebarPrimary: "#18181b",
  sidebarPrimaryForeground: "#fafafa",
};

export const darkTokens: ThemeTokens = {
  background: "#09090b",
  foreground: "#fafafa",
  card: "#18181b",
  cardForeground: "#fafafa",
  popover: "#18181b",
  popoverForeground: "#fafafa",
  primary: "#e4e4e7",
  primaryForeground: "#18181b",
  secondary: "#27272a",
  secondaryForeground: "#fafafa",
  muted: "#27272a",
  mutedForeground: "#a1a1aa",
  accent: "#27272a",
  accentForeground: "#fafafa",
  destructive: "#ef4444",
  destructiveForeground: "#fafafa",
  border: "#27272a",
  input: "#3f3f46",
  ring: "#71717a",
  sidebar: "#18181b",
  sidebarForeground: "#fafafa",
  sidebarBorder: "#27272a",
  sidebarAccent: "#27272a",
  sidebarAccentForeground: "#fafafa",
  sidebarPrimary: "#3b82f6",
  sidebarPrimaryForeground: "#fafafa",
};

export const darkTheme: Theme = { mode: "dark", colors: darkTokens, radius: 8 };
export const lightTheme: Theme = { mode: "light", colors: lightTokens, radius: 8 };

export const ThemeContext = createContext<Theme>(darkTheme);

export function useTheme(): Theme {
  return useContext(ThemeContext);
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
