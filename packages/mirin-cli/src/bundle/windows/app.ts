/**
 * Assemble a Windows app folder for a mirin app. Windows has no `.app` bundle and
 * no codesign step in the MVP — just a flat directory the OS loader can resolve
 * libcef.dll + the CEF runtime from, next to the host exe:
 *
 *   <App>/
 *     <App>.exe                compiled Bun host (process.execPath)
 *     mirin_core.dll           loaded by the host via bun:ffi
 *     mirin-helper.exe         CEF subprocess (browser_subprocess_path)
 *     libcef.dll, *.pak, icudtl.dat, v8_context_snapshot.bin, locales/, …  (CEF runtime)
 *     resources/               (production only — dev serves from the Vite URL)
 *       ui/, worker.js, mirin.manifest.json, version.json, sidecars/, workers/
 *
 * The CEF subprocess name (`mirin-helper.exe`) and the `resources/` layout match
 * what mirin-core derives at runtime (engine::derive_subprocess_path, host.ts).
 */

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { safeExtraAssetName, validateBundleExtras } from "../../extras.ts";
import { makeWindowsIcon } from "../../icons/windows/index.ts";
import { writeAtomicOutputDirectory } from "../../shared/fs/atomic-output.ts";
import {
  assertProjectIcon,
  copyProjectFile,
  safeDestructiveDirectory,
} from "../../shared/fs/project-source.ts";
import { validateAppIdentity } from "../../shared/validation/config.ts";
import { validateVersionMetadataForBundle } from "../../shared/validation/version-json.ts";
import { copyFlatCefLocales } from "../shared/cef-locales.ts";

/** Source dir (vendor/cef on Windows) must contain libcef.dll. */
const CEF_MARKER = "libcef.dll";

/** CEF runtime files copied next to the host exe. Everything else in the Windows
 *  distribution (libcef.lib, include/, cmake/, archive.json, bootstrap*.exe) is
 *  build-time only and intentionally left out. */
const CEF_RUNTIME_EXTS = new Set([".dll", ".bin", ".pak", ".dat"]);
const CEF_RUNTIME_EXTRAS = ["vk_swiftshader_icd.json"];

export interface WinBundleOptions {
  appName: string; // also the host exe stem → <appName>.exe
  bundleId: string;
  version: string;
  channel: string;
  projectDir: string;
  outDir: string;
  hostExe: string; // compiled Bun host (.exe)
  coreDll: string; // mirin_core.dll
  helperExe: string; // mirin-helper.exe
  cefPath: string; // dir containing the Windows CEF runtime (vendor/cef)
  /** Production CEF locale allowlist. Undefined keeps every locale. */
  cefLocales?: string[];
  /** App icon source (.ico / .iconset / .png) → <App>/icon.ico, set as the window icon. */
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

/** Build the Windows app folder and return its path + the host exe to launch. */
export async function buildWindowsBundle(
  opts: WinBundleOptions,
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
    "Windows bundle output directory",
  );
  await writeAtomicOutputDirectory(
    opts.projectDir,
    app,
    "Windows bundle output directory",
    async (staging) => {
      const exe = join(staging, `${appName}.exe`);
      cpSync(opts.hostExe, exe);
      cpSync(opts.coreDll, join(staging, "mirin_core.dll"));
      cpSync(opts.helperExe, join(staging, "mirin-helper.exe"));

      copyCefRuntime(cefPath, staging, opts.cefLocales);

      // App icon → <App>/icon.ico, loaded at runtime by the core and set as the window icon.
      if (icon) makeWindowsIcon(icon, join(staging, "icon.ico"));

      // Production resources (dev passes none — paths come from env + the Vite URL).
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
            copyProjectFile(
              opts.projectDir,
              sc.src,
              join(sidecarsDir, safeName),
              `sidecar "${safeName}"`,
            );
          }
        }
      }
    },
  );

  return { app, exe: join(app, `${appName}.exe`) };
}

/** Copy the CEF runtime (dlls, paks, snapshot, icu data, locales) into `dest`. */
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
}
