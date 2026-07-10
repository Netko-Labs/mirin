/**
 * Assemble a Linux app folder for a mirin app. Like Windows, Linux has no `.app`
 * bundle — just a flat directory the dynamic loader can resolve libcef.so + the
 * CEF runtime from, next to the host binary:
 *
 *   <App>/
 *     <App>                    compiled Bun host (process.execPath)
 *     libmirin_core.so         loaded by the host via bun:ffi
 *     mirin-helper             CEF subprocess (browser_subprocess_path)
 *     libcef.so, libEGL.so, libGLESv2.so, *.pak, icudtl.dat,
 *     v8_context_snapshot.bin, locales/, chrome-sandbox, …  (CEF runtime)
 *     resources/               (production only — dev serves from the Vite URL)
 *       ui/, worker.js, mirin.manifest.json, version.json, sidecars/, workers/
 *
 * Wayland-only (docs/linux-port.md); the CEF subprocess name (`mirin-helper`) and
 * the `resources/` layout match what mirin-core derives at runtime
 * (engine::derive_subprocess_path, host.ts). libcef.so is resolved via
 * LD_LIBRARY_PATH set on the host (dev.ts) or an rpath at build time.
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { copyFlatCefLocales } from "../shared/cef-locales.ts";

/** Source dir (vendor/cef on Linux) must contain libcef.so. */
const CEF_MARKER = "libcef.so";

/** CEF runtime files copied next to the host binary. Everything else in the Linux
 *  distribution (include/, cmake/, CMakeLists.txt, archive.json, libcef_dll/) is
 *  build-time only and intentionally left out. `.so` covers libcef/libEGL/
 *  libGLESv2/libvk_swiftshader; the extras list catches the non-extension names. */
const CEF_RUNTIME_EXTS = new Set([".so", ".bin", ".pak", ".dat"]);
const CEF_RUNTIME_EXTRAS = ["vk_swiftshader_icd.json", "libvulkan.so.1", "chrome-sandbox"];

export interface LinuxBundleOptions {
  appName: string; // also the host binary stem → <appName>
  outDir: string;
  hostExe: string; // compiled Bun host (no extension)
  coreDll: string; // libmirin_core.so
  helperExe: string; // mirin-helper
  cefPath: string; // dir containing the Linux CEF runtime (vendor/cef)
  /** Production CEF locale allowlist. Undefined keeps every locale. */
  cefLocales?: string[];
  /** App icon source (.png / .iconset); resolved to a PNG at resources/icon.png for
   *  the window's `_NET_WM_ICON` (taskbar/dock). */
  icon?: string;
  /** Production-only resources placed under <App>/resources. */
  resources?: {
    uiDir?: string; // Vite dist/ → resources/ui (served via app://ui)
    workerJs?: string; // bundled main-process Worker → resources/worker.js
    manifestJson?: string; // serialized manifest → resources/mirin.manifest.json
    versionJson?: string; // serialized version.json → resources/version.json (updater)
    sidecars?: { name: string; src: string }[]; // → resources/sidecars/<name>
    workers?: Record<string, string>; // name → abs path → resources/workers/<name>.js
  };
}

/**
 * Resolve the app config's `icon` to a concrete square PNG usable on Linux (for
 * the window's `_NET_WM_ICON`). Accepts a `.png` (used as-is) or a `.iconset`
 * directory (pick a good mid/large size). Returns undefined for `.icns` (which the
 * Linux core can't decode) or a missing/empty source.
 *
 * @param icon absolute path to the icon source (`config.icon` joined with the project root).
 */
export function resolveLinuxIconPng(icon: string): string | undefined {
  if (!existsSync(icon)) return undefined;
  if (statSync(icon).isDirectory()) {
    const pngs = readdirSync(icon).filter((f) => extname(f).toLowerCase() === ".png");
    if (!pngs.length) return undefined;
    // Prefer 128×128: crisp in the dock, and small enough that its `_NET_WM_ICON`
    // (a 128²+2 CARDINAL array ≈ 64 KB) stays under X11's ~256 KB max request size —
    // a 256×256 icon (≈ 256 KB) can exceed it and get dropped. Fall back to the
    // largest available under that ceiling (by pixels parsed from the iconset name).
    const preferred = ["icon_128x128.png", "icon_64x64.png", "icon_256x256.png"];
    const MaxSide = 128;
    const pick =
      preferred.find((p) => pngs.includes(p)) ??
      pngs
        .slice()
        .sort((a, b) => iconsetPixels(b) - iconsetPixels(a))
        .find((p) => iconsetPixels(p) <= MaxSide * MaxSide) ??
      pngs.sort((a, b) => iconsetPixels(a) - iconsetPixels(b))[0];
    return pick ? join(icon, pick) : undefined;
  }
  return extname(icon).toLowerCase() === ".png" ? icon : undefined;
}

/**
 * Resolve the app config's `icon` to the *largest* concrete PNG (for a `.desktop`
 * `Icon=`, which is a file path with no X11 request-size limit — so we want it
 * crisp, unlike the window `_NET_WM_ICON`). `.png` used as-is; `.iconset` → biggest
 * PNG inside. Undefined for `.icns` or a missing source.
 */
export function resolveLinuxDesktopIconPng(icon: string): string | undefined {
  if (!existsSync(icon)) return undefined;
  if (statSync(icon).isDirectory()) {
    const pngs = readdirSync(icon).filter((f) => extname(f).toLowerCase() === ".png");
    if (!pngs.length) return undefined;
    const biggest = pngs.sort((a, b) => iconsetPixels(b) - iconsetPixels(a))[0];
    return biggest ? join(icon, biggest) : undefined;
  }
  return extname(icon).toLowerCase() === ".png" ? icon : undefined;
}

/**
 * A freedesktop `.desktop` entry body for a mirin app. cosmic's dock resolves an
 * X11 window's icon by matching its `WM_CLASS` (which the core sets to the app id)
 * against a desktop entry's `StartupWMClass`, then uses that entry's `Icon` — the
 * reliable path on cosmic (its `_NET_WM_ICON` fallback is unreliable). `wmClass`
 * MUST equal the core's `res_class` (the bundle id).
 */
export function desktopEntry(opts: {
  name: string;
  exec: string;
  iconPng: string;
  wmClass: string;
  /** Freedesktop main category (e.g. "Utility", "Development"). A trailing `;` is
   *  added if missing (the spec requires list values to end with one). Omitted → no
   *  Categories line. Used by the .deb/.rpm/AppImage entries (dev needs none). */
  categories?: string;
  /** Optional Comment= (tooltip / description) line. */
  comment?: string;
}): string {
  const lines = ["[Desktop Entry]", "Type=Application", `Name=${desktopValue("Name", opts.name)}`];
  if (opts.comment) lines.push(`Comment=${desktopValue("Comment", opts.comment)}`);
  lines.push(
    `Exec=${desktopExec(opts.exec)}`,
    `Icon=${desktopValue("Icon", opts.iconPng)}`,
    `StartupWMClass=${desktopValue("StartupWMClass", opts.wmClass)}`,
    "Terminal=false",
  );
  if (opts.categories) {
    lines.push(`Categories=${desktopCategories(opts.categories)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function desktopValue(field: string, value: string): string {
  assertDesktopScalar(field, value);
  return value.replace(/\\/g, "\\\\").replace(/\t/g, "\\t");
}

function desktopExec(value: string): string {
  assertDesktopScalar("Exec", value);
  if (/^[A-Za-z0-9._/+:-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function desktopCategories(value: string): string {
  const normalized = value.endsWith(";") ? value : `${value};`;
  assertDesktopScalar("Categories", normalized);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*(;[A-Za-z0-9][A-Za-z0-9-]*)*;$/.test(normalized)) {
    throw new Error(
      `[mirin] invalid Linux desktop category "${value}" — use freedesktop category names separated by semicolons.`,
    );
  }
  return normalized;
}

function assertDesktopScalar(field: string, value: string): void {
  if (value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error(`[mirin] invalid Linux desktop ${field} value.`);
  }
}

/** Effective pixel count encoded in an iconset filename (`icon_256x256@2x.png` → 512²). */
function iconsetPixels(name: string): number {
  const m = basename(name).match(/(\d+)x(\d+)(@(\d+)x)?/);
  if (!m) return 0;
  const scale = m[4] ? Number(m[4]) : 1;
  return Number(m[1]) * Number(m[2]) * scale * scale;
}

/** Build the Linux app folder and return its path + the host binary to launch. */
export async function buildLinuxBundle(
  opts: LinuxBundleOptions,
): Promise<{ app: string; exe: string }> {
  const { appName, cefPath } = opts;
  if (!existsSync(join(cefPath, CEF_MARKER))) {
    throw new Error(`CEF runtime not found at ${cefPath} — run: bun scripts/fetch-cef.ts`);
  }

  const app = join(opts.outDir, appName);
  rmSync(app, { recursive: true, force: true });
  mkdirSync(app, { recursive: true });

  const exe = join(app, appName);
  cpSync(opts.hostExe, exe);
  chmodSync(exe, 0o755);
  cpSync(opts.coreDll, join(app, "libmirin_core.so"));
  const helper = join(app, "mirin-helper");
  cpSync(opts.helperExe, helper);
  chmodSync(helper, 0o755);

  copyCefRuntime(cefPath, app, opts.cefLocales);

  // The window taskbar/dock icon (`_NET_WM_ICON`) is set by the core from a PNG at
  // `resources/icon.png`; host.ts points the init config's `icon_path` there in prod.
  // (Dev serves it directly from the project via MIRIN_CONFIG_JSON, not the bundle.)
  const iconPng = opts.icon ? resolveLinuxIconPng(opts.icon) : undefined;
  if (iconPng) {
    const res = join(app, "resources");
    mkdirSync(res, { recursive: true });
    cpSync(iconPng, join(res, "icon.png"));
  }

  // Production resources (dev passes none — paths come from env + the Vite URL).
  if (opts.resources) {
    const res = join(app, "resources");
    mkdirSync(res, { recursive: true });
    if (opts.resources.uiDir) cpSync(opts.resources.uiDir, join(res, "ui"), { recursive: true });
    if (opts.resources.workerJs) cpSync(opts.resources.workerJs, join(res, "worker.js"));
    if (opts.resources.manifestJson != null) {
      writeFileSync(join(res, "mirin.manifest.json"), opts.resources.manifestJson);
    }
    if (opts.resources.versionJson != null) {
      writeFileSync(join(res, "version.json"), opts.resources.versionJson);
    }
    if (opts.resources.workers && Object.keys(opts.resources.workers).length) {
      const workersDir = join(res, "workers");
      mkdirSync(workersDir, { recursive: true });
      for (const [name, src] of Object.entries(opts.resources.workers)) {
        cpSync(src, join(workersDir, `${name}.js`));
      }
    }
    if (opts.resources.sidecars?.length) {
      const sidecarsDir = join(res, "sidecars");
      mkdirSync(sidecarsDir, { recursive: true });
      for (const sc of opts.resources.sidecars) {
        if (!existsSync(sc.src)) throw new Error(`sidecar "${sc.name}" not found: ${sc.src}`);
        const dst = join(sidecarsDir, sc.name);
        cpSync(sc.src, dst);
        chmodSync(dst, 0o755);
      }
    }
  }

  return { app, exe };
}

/** Copy the CEF runtime (shared libs, paks, snapshot, icu data, locales) into `dest`. */
function copyCefRuntime(cefPath: string, dest: string, locales: string[] | undefined): void {
  for (const entry of readdirSync(cefPath)) {
    if (CEF_RUNTIME_EXTS.has(extname(entry).toLowerCase())) {
      cpSync(join(cefPath, entry), join(dest, entry));
    }
  }
  for (const extra of CEF_RUNTIME_EXTRAS) {
    const src = join(cefPath, extra);
    if (existsSync(src)) cpSync(src, join(dest, extra), { recursive: true });
  }
  copyFlatCefLocales(join(cefPath, "locales"), join(dest, "locales"), locales);
  // chrome-sandbox works setuid-root (mode 4755) or, on kernels with unprivileged
  // user namespaces, via the namespace sandbox with no special perms. We can't
  // setuid without root here; leave it executable and let CEF pick the userns path.
  const sandbox = join(dest, "chrome-sandbox");
  if (existsSync(sandbox)) {
    try {
      require("node:fs").chmodSync(sandbox, 0o755);
    } catch {
      /* best-effort */
    }
  }
}
