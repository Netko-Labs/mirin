/**
 * mirin/config — the pure-data manifest (docs/api-design.md §1).
 *
 * `mirin.config.ts` must stay serializable: no functions, no side effects.
 * The CLI and the host bootstrap both read it without running app code.
 */

/**
 * A native macOS background material rendered behind the web UI. macOS only.
 *
 * - `"liquidGlass"` — Apple's Liquid Glass (NSGlassEffectView, macOS 26+);
 *   automatically falls back to a frosted vibrancy material on older systems.
 * - the rest map to NSVisualEffectView vibrancy materials.
 */
export type WindowMaterial =
  | "liquidGlass"
  | "sidebar"
  | "menu"
  | "popover"
  | "hud"
  | "fullScreenUI"
  | "underWindowBackground"
  | "contentBackground"
  | "windowBackground"
  | "titlebar"
  | "selection"
  | "headerView"
  | "sheet"
  | "toolTip";

export interface WindowMaterialOptions {
  type: WindowMaterial;
  /** Liquid Glass tint as a CSS hex color (e.g. "#3b82f6" or "#3b82f680"). */
  tint?: string;
  /** Corner radius in points (defaults to the panel radius, 14). */
  cornerRadius?: number;
}

export interface WindowConfig {
  /** Page to load: `app://` (bundled assets) or http(s). */
  url: string;
  title?: string;
  width?: number;
  height?: number;
  /** Screen position (bottom-left origin, points). Centered when absent. */
  x?: number;
  y?: number;
  /** "ready" (default) shows on first paint to avoid a white flash. */
  show?: "ready" | "immediately";
  /** "auto" (default) opens at launch; "manual" windows are templates for app.windows.open(name). */
  open?: "auto" | "manual";
  /** Custom title bar: hide it (content fills) or inset the traffic lights. */
  titleBarStyle?: "hidden" | "hiddenInset";
  /** Non-opaque window (for transparent/blurred UIs). */
  transparent?: boolean;
  /**
   * Native background material behind the web UI (macOS). Implies `transparent`,
   * so the page should use a translucent or clear background. Pass a material
   * name or an object with `tint`/`cornerRadius`.
   */
  material?: WindowMaterial | WindowMaterialOptions;
  /** Float above normal windows. */
  alwaysOnTop?: boolean;
  /** Drag the window from anywhere in its background. */
  movableByBackground?: boolean;
  /** Create the window hidden (e.g. a Spotlight panel shown on a hotkey). */
  visible?: boolean;
}

export interface MirinConfig {
  /** Reverse-DNS app id, e.g. "dev.peje.hello". */
  id: string;
  name: string;
  /** Main-process entry, relative to the project root (runs in the Bun Worker). */
  main: string;
  windows: Record<string, WindowConfig>;
}

/** Identity function for typing/intellisense. `const` generic preserves window names as literal keys. */
export function defineConfig<const T extends MirinConfig>(config: T): T {
  return config;
}
