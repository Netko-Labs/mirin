/**
 * Assemble a Linux app folder for a mirin app. Like Windows, Linux has no `.app`
 * bundle — just a flat directory the dynamic loader can resolve libcef.so + the
 * CEF runtime from, next to the host binary:
 *
 *   <App>/
 *     <App>                    compiled Bun host (process.execPath)
 *     libmirin_core.so         loaded by the host via bun:ffi
 *     mirin-codec              atomic updater swap + release codecs
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
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { safeExtraAssetName, validateBundleExtras } from "../../extras.ts";
import { writeAtomicOutputDirectory } from "../../shared/fs/atomic-output.ts";
import {
  assertProjectIcon,
  copyProjectFile,
  safeDestructiveDirectory,
} from "../../shared/fs/project-source.ts";
import { validateAppIdentity } from "../../shared/validation/config.ts";
import { validateVersionMetadataForBundle } from "../../shared/validation/version-json.ts";
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
  bundleId: string;
  version: string;
  channel: string;
  projectDir: string;
  outDir: string;
  hostExe: string; // compiled Bun host (no extension)
  coreDll: string; // libmirin_core.so
  codecBin: string; // mirin-codec (atomic updater swap + release codecs)
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
  const identity = validateAppIdentity({
    appName: opts.appName,
    bundleId: opts.bundleId,
    version: opts.version,
    channel: opts.channel,
  });
  validateVersionMetadataForBundle(opts.resources?.versionJson, identity);
  validateBundleExtras(opts.projectDir, opts.resources?.sidecars, opts.resources?.workers);
  const icon = opts.icon ? assertProjectIcon(opts.projectDir, opts.icon, "app icon") : undefined;
  const { appName } = identity;
  const { cefPath } = opts;
  if (!existsSync(join(cefPath, CEF_MARKER))) {
    throw new Error(`CEF runtime not found at ${cefPath} — run: bun scripts/fetch-cef.ts`);
  }

  const app = safeDestructiveDirectory(
    opts.projectDir,
    join(opts.outDir, appName),
    "Linux bundle output directory",
  );
  await writeAtomicOutputDirectory(
    opts.projectDir,
    app,
    "Linux bundle output directory",
    async (staging) => {
      const exe = join(staging, appName);
      cpSync(opts.hostExe, exe);
      chmodSync(exe, 0o755);
      cpSync(opts.coreDll, join(staging, "libmirin_core.so"));
      const codec = join(staging, "mirin-codec");
      cpSync(opts.codecBin, codec);
      chmodSync(codec, 0o755);
      const helper = join(staging, "mirin-helper");
      cpSync(opts.helperExe, helper);
      chmodSync(helper, 0o755);

      copyCefRuntime(cefPath, staging, opts.cefLocales);

      const iconPng = icon ? resolveLinuxIconPng(icon) : undefined;
      if (iconPng) {
        const res = join(staging, "resources");
        mkdirSync(res, { recursive: true });
        cpSync(iconPng, join(res, "icon.png"));
      }

      if (opts.resources) {
        const res = join(staging, "resources");
        mkdirSync(res, { recursive: true });
        if (opts.resources.uiDir) {
          cpSync(opts.resources.uiDir, join(res, "ui"), { recursive: true });
        }
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
            const safeName = safeExtraAssetName(name, "worker name");
            copyProjectFile(
              opts.projectDir,
              src,
              join(workersDir, `${safeName}.js`),
              `worker "${safeName}" bundle`,
            );
          }
        }
        if (opts.resources.sidecars?.length) {
          const sidecarsDir = join(res, "sidecars");
          mkdirSync(sidecarsDir, { recursive: true });
          for (const sc of opts.resources.sidecars) {
            const safeName = safeExtraAssetName(sc.name, "sidecar name");
            const dst = join(sidecarsDir, safeName);
            copyProjectFile(opts.projectDir, sc.src, dst, `sidecar "${safeName}"`);
            chmodSync(dst, 0o755);
          }
        }
      }
    },
  );

  return { app, exe: join(app, appName) };
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
