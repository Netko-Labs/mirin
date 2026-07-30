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
  /** Minimum window size; the OS prevents resizing below it. */
  minWidth?: number;
  minHeight?: number;
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
  /**
   * Publisher / company name (e.g. "Netko Labs"). Shown in the Windows installer,
   * the exe's file properties (CompanyName), and Add/Remove Programs. Defaults to
   * the app `name`.
   */
  publisher?: string;
  /** Main-process entry, relative to the project root (runs in the Bun Worker). */
  main: string;
  /**
   * App icon, relative to the project root. Accepts a `.icns`, a `.iconset`
   * directory, or a single square `.png` (≥512px). macOS renders it into an
   * `.icns` embedded in the bundle for the Dock and Finder; Linux resolves a PNG
   * and sets it as the window's `_NET_WM_ICON` (taskbar/dock); Windows uses the
   * `.ico` for the exe and window.
   */
  icon?: string;
  /** CEF runtime packaging options. Omit to bundle every locale. */
  cef?: CefConfig;
  /**
   * Cross-platform auto-update configuration. Omit to disable updates entirely.
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
   * Linux distributable packages produced by `mirin release` (and by `mirin build`
   * when packaging is requested): an **AppImage** (single-file, run-anywhere), a
   * **.deb** (Debian/Ubuntu), and an **.rpm** (Fedora/RHEL/openSUSE). `true`/omitted
   * builds all three with sensible defaults; an object customizes them (which
   * `formats`, maintainer, runtime `depends`, …); `false` disables Linux packaging.
   * Requires `fpm` (deb + rpm) and `appimagetool` (AppImage) on the build machine.
   */
  linux?: boolean | LinuxConfig;
  /**
   * External binaries bundled into the `.app` and spawned at runtime with
   * `app.sidecar(name)`. Maps a logical name to a path (relative to the project
   * root) or a {@link SidecarSpec}. Names must be filename-safe (`A-Z`, `a-z`,
   * `0-9`, `.`, `_`, `-`) and paths must stay under the project root. Each binary is copied into
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
   * the main worker. Names follow the same filename-safe rule as sidecars, and
   * paths must stay under the project root. Resolve one at runtime with `resolveWorker(name)` and pass
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
  /**
   * Single-instance app (default true): a second launch focuses the running
   * window and exits, instead of opening another window. Set false to allow
   * multiple instances (each gets its own CEF cache dir).
   */
  singleInstance?: boolean;
  /**
   * Agent-facing developer tooling: the structured event stream and the loopback
   * inspector (docs/agent-devtools.md). Fully enabled under `mirin dev` and
   * fully disabled in packaged builds; omit unless you need to change that.
   */
  devtools?: DevtoolsConfig;
}

/**
 * Developer/agent observability settings.
 *
 * Under `mirin dev` every capability defaults to on. In a packaged build every
 * capability defaults to **off**, and the individual switches below are ignored
 * unless {@link DevtoolsConfig.production} is `true` — the inspector can evaluate
 * JavaScript in a webview and synthesize input, so enabling it in a shipped app
 * gives any local process control of the app. Do that only for a diagnostic
 * build you control.
 */
export interface DevtoolsConfig {
  /** Master switch for the whole subsystem. Default true where permitted. */
  enabled?: boolean;
  /** Bind the loopback inspector HTTP/SSE server. Default true where permitted. */
  inspector?: boolean;
  /** Mirror the event stream to `.mirin/dev/<session>/events.jsonl`. Default true. */
  file?: boolean;
  /** Events kept in memory for `/logs`. Default 2000. */
  bufferSize?: number;
  /**
   * Include RPC inputs and results in traces. Default false: procedure payloads
   * carry app data, and the stream is written to disk in plain text.
   */
  rpcPayloads?: boolean;
  /**
   * Attach to CEF's remote-debugging port, enabling `/screenshot`, `/snapshot`,
   * `/eval`, and `/act`. Default true where permitted.
   */
  cdp?: boolean;
  /**
   * Permit devtools in a packaged (non-dev) build. Default false. Read the
   * warning on this interface before setting it.
   */
  production?: boolean;
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

/** A Linux distributable package format `mirin` can emit. */
export type LinuxPackageFormat = "appimage" | "deb" | "rpm";

/**
 * Linux packaging options. Every format ships the same relocatable app payload
 * (host binary + libcef.so + the CEF runtime + `resources/`) under a single
 * prefix, with a launcher and a freedesktop `.desktop` entry + hicolor icon.
 */
export interface LinuxConfig {
  /** Which package formats to emit. Default: all three (`appimage`, `deb`, `rpm`). */
  formats?: LinuxPackageFormat[];
  /**
   * The `/usr/bin` launcher command name and the deb/rpm package name. Defaults to
   * the last dot-segment of the app `id` (e.g. `dev.netko.anko` → `anko`),
   * lowercased and sanitized to a valid package name.
   */
  binName?: string;
  /** Package maintainer for deb/rpm (`"Name <email>"`). Defaults to `publisher`. */
  maintainer?: string;
  /** One-line package description / `.desktop` `Comment`. Defaults to the app name. */
  description?: string;
  /** License identifier for deb/rpm metadata (e.g. `"MIT"`). Omitted when unset. */
  license?: string;
  /** Homepage URL for deb/rpm metadata. Omitted when unset. */
  homepage?: string;
  /** Freedesktop `.desktop` category (e.g. `"Development"`). Default `"Utility"`. */
  category?: string;
  /**
   * Debian runtime dependency package names, replacing the built-in CEF/GTK
   * defaults (`libgtk-3-0`, `libnss3`, `libasound2`, …). Advanced.
   */
  debDepends?: string[];
  /**
   * RPM runtime dependency package names, replacing the built-in CEF/GTK defaults
   * (`gtk3`, `nss`, `alsa-lib`, …). Advanced.
   */
  rpmDepends?: string[];
}

export interface ReleaseConfig {
  /** Flat directory URL hosting `{channel}-{platform}-{arch}-*` update files. */
  baseUrl: string;
  /** Update channel; baked into artifact names + support dir. Default "stable". */
  channel?: string;
  /** Optional markdown release notes embedded in the update manifest. */
  notes?: string;
}

export interface CefConfig {
  /**
   * Locale packs bundled with production apps, as BCP 47 tags such as
   * `en-US`, `es-419`, or `pt-BR`. Omit to bundle every CEF locale.
   */
  locales?: string[];
}

/** Identity function for typing/intellisense. `const` generic preserves window names as literal keys. */
export function defineConfig<const T extends MirinConfig>(config: T): T {
  return config;
}
