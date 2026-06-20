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
  /**
   * Reposition the macOS traffic-light buttons for a custom title bar.
   * `x` insets the leftmost button from the left edge; `y` sets the effective
   * title-bar height the buttons are vertically centered in (so `y` ≈ your CSS
   * title-bar height minus the button height). Re-applied automatically on resize.
   */
  trafficLightPosition?: { x: number; y: number };
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
  /**
   * App icon, relative to the project root (macOS). Accepts a `.icns`, a
   * `.iconset` directory, or a single square `.png` (≥512px) that mirin renders
   * into an `.icns`. Embedded in the bundle for the Dock and Finder.
   */
  icon?: string;
  /**
   * Auto-update configuration (macOS). Omit to disable updates entirely.
   * `baseUrl` is a flat directory of release artifacts (a GitHub Releases
   * `…/releases/latest/download` URL, an S3/R2 bucket, or any static host).
   * `channel` (default "stable") is baked into artifact filenames + the app's
   * support folder, so multiple channels can coexist at the same `baseUrl`.
   */
  release?: ReleaseConfig;
  /**
   * macOS `.dmg` installer produced by `mirin release` (alongside the updater
   * artifacts). `true`/omitted builds a default drag-to-Applications DMG; an
   * object customizes it; `false` disables it. The DMG is codesigned and (when
   * notary credentials are set) notarized + stapled like the `.app`.
   */
  dmg?: boolean | DmgConfig;
  /**
   * Windows installer (NSIS) produced by `mirin release` alongside the updater
   * artifacts. `true`/omitted builds a default assisted installer (Program Files
   * or per-user, Start Menu + Desktop shortcuts, an uninstaller + Add/Remove
   * Programs entry); an object customizes it; `false` ships only the portable
   * `.zip`. Requires `makensis` (NSIS) on the build machine.
   */
  nsis?: boolean | NsisConfig;
  /**
   * Windows installer via **Inno Setup** — a modern flat wizard
   * (`WizardStyle=modern`, the installer VS Code ships). Preferred over `nsis`
   * when both are available; `true`/omitted builds the default installer, an
   * object customizes it, `false` falls back to NSIS / the portable `.zip`.
   * Requires `iscc` (Inno Setup 6+) on the build machine.
   */
  inno?: boolean | InnoConfig;
  /**
   * External binaries bundled into the `.app` and spawned at runtime with
   * `app.sidecar(name)`. Maps a logical name to a path (relative to the project
   * root) or a {@link SidecarSpec}. Each binary is copied into
   * `Contents/Resources/sidecars/<name>`, codesigned (hardened runtime), and —
   * when notary credentials are set — notarized with the rest of the app.
   *
   * Prefer a binary already on the user's PATH (`Bun.spawn("git", …)`) or a
   * download-on-first-run when size/licensing matter; bundle only when you need
   * a pinned version offline.
   */
  sidecars?: Record<string, string | SidecarSpec>;
  /**
   * Extra Bun Worker entry files (relative to the project root) bundled next to
   * the main worker. Resolve one at runtime with `resolveWorker(name)` and pass
   * it to `new Worker(...)` from `node:worker_threads`. These run off the main
   * thread for CPU/IO offload and must NOT call window/native APIs — only the
   * app worker owns AppKit/CEF (see docs/architecture.md).
   */
  workers?: Record<string, string>;
  /**
   * Custom URL schemes this app registers as a handler for (macOS
   * `CFBundleURLTypes`), e.g. `["anko"]` so `anko://…` links launch the app (or
   * focus it if already running). Incoming URLs are delivered to
   * `app.on("open-url", (url) => …)` — including the URL the app was launched
   * with. Scheme names should be lowercase letters/digits (no `://`).
   */
  urlSchemes?: string[];
  windows: Record<string, WindowConfig>;
}

/** A bundled sidecar binary with optional hardened-runtime entitlements. */
export interface SidecarSpec {
  /** Path to the binary, relative to the project root. */
  bin: string;
  /**
   * Extra codesign entitlements for this binary under the hardened runtime.
   * Most plain CLIs need none. Use `disable-library-validation` for a binary
   * that loads dylibs not signed by your Team ID, or the JIT entitlements for a
   * binary that runs its own JIT (another Bun/V8/Node).
   */
  entitlements?: SidecarEntitlement[];
}

export type SidecarEntitlement =
  | "allow-jit"
  | "allow-unsigned-executable-memory"
  | "disable-library-validation";

export interface DmgConfig {
  /** Volume name shown when the DMG is mounted. Default: the app name. */
  volumeName?: string;
  /**
   * Disk-image format. `ULFO` (lzfse, default) compresses large CEF frameworks
   * best on modern macOS; `UDZO` (zlib) is the most broadly compatible; `UDBZ`
   * (bzip2) is smallest but slowest.
   */
  format?: "ULFO" | "UDZO" | "UDBZ";
  /**
   * Background image for the mounted Finder window (path relative to the project
   * root). Setting this — or any position/size below — switches to the laid-out
   * DMG (Finder window styled via AppleScript); best-effort, falling back to a
   * plain DMG if Finder automation is unavailable.
   */
  background?: string;
  /** Mounted Finder window size, in points. Default 640×400. */
  windowSize?: { width: number; height: number };
  /** Icon size in the mounted window, in points. Default 128. */
  iconSize?: number;
  /** App icon position in the window. Default centered-left. */
  appPosition?: { x: number; y: number };
  /** `/Applications` symlink position. Default centered-right. */
  applicationsPosition?: { x: number; y: number };
}

export interface NsisConfig {
  /**
   * Install for all users under Program Files (requires elevation), vs the
   * default per-user install under `%LOCALAPPDATA%\Programs` (no admin prompt,
   * and the in-app updater can swap the folder without elevation).
   */
  perMachine?: boolean;
  /**
   * One-click install (no wizard — just a progress bar, then run), vs the default
   * assisted wizard (welcome → optional license → directory → install → finish).
   */
  oneClick?: boolean;
  /** Default install directory (absolute, or with NSIS vars like `$PROGRAMFILES64`). */
  installDir?: string;
  /** Let the user change the install directory in the assisted wizard. Default true. */
  allowChangeInstallDir?: boolean;
  /** Create a Desktop shortcut. Default true. */
  desktopShortcut?: boolean;
  /** Create a Start Menu shortcut. Default true. */
  startMenuShortcut?: boolean;
  /** License file shown on a wizard page (path relative to the project root; .txt/.rtf). */
  license?: string;
  /** Publisher / company name, shown in the Add/Remove Programs entry. */
  publisher?: string;
  /** Offer to launch the app on the finish page. Default true. */
  runAfterFinish?: boolean;
  /**
   * Installer + uninstaller `.ico` (path relative to the project root). Defaults to
   * the app `icon` (rendered to `.ico` like the window icon).
   */
  installerIcon?: string;
  /**
   * Raw NSIS script injected near the top of the generated script (advanced) — for
   * custom pages, macros, or `Section` hooks beyond the options above.
   */
  include?: string;
}

/**
 * Inno Setup installer options — the same knobs as {@link NsisConfig}
 * (perMachine, oneClick, shortcuts, license, publisher, runAfterFinish,
 * installerIcon, and a raw `include` injected as `.iss` instead of NSIS script).
 */
export type InnoConfig = NsisConfig;

export interface ReleaseConfig {
  /** Flat directory URL hosting `{channel}-{platform}-{arch}-*` update files. */
  baseUrl: string;
  /** Update channel; baked into artifact names + support dir. Default "stable". */
  channel?: string;
}

/** Identity function for typing/intellisense. `const` generic preserves window names as literal keys. */
export function defineConfig<const T extends MirinConfig>(config: T): T {
  return config;
}
