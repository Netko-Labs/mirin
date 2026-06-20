/**
 * `mirin build` — package a standalone, signed .app (docs/macos-mvp.md).
 *
 * 1. vite build               → production UI in dist/
 * 2. resolve native artifacts → core + helper (in-repo build or prebuilt)
 * 3. compile host (minified)  → Contents/MacOS/<exe>
 * 4. bundle Worker (minified) → Resources/worker.js
 * 5. assemble + sign the .app → dist/ui, manifest, dylib, helpers, CEF
 *
 * The result runs with no env and no dev server: the host resolves everything
 * from inside the bundle, and webviews load their `app://` URLs served from
 * Contents/Resources by the native scheme handler.
 *
 * Codesign identity: ad-hoc by default; set MIRIN_SIGN_IDENTITY to a Developer
 * ID to produce a distributable, notarizable app.
 */

import { $ } from "bun";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildAppBundle } from "./bundle.ts";
import { buildWindowsBundle } from "./bundle-win.ts";
import { makeWindowsIcon } from "./icon-win.ts";
import { resolveArtifacts } from "./artifacts.ts";
import { sweepBuildTemps } from "./temps.ts";
import { normalizeSidecars, compileWorkers } from "./extras.ts";

const IS_WINDOWS = process.platform === "win32";

/** A PE FILEVERSION (`x.y.z.w`) from a semver string (pre-release suffix dropped). */
function winFileVersion(v: string): string {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}.0` : "0.0.0.0";
}

/**
 * Flip a PE exe from the CONSOLE subsystem (3) to GUI (2) so Windows allocates
 * **no console window** when it's launched from a shortcut. Bun's
 * `--windows-hide-console` only hides the console at runtime (a brief flash);
 * GUI subsystem prevents it entirely — the equivalent of Electrobun's
 * `exe.subsystem = .Windows`. The optional-header Subsystem field is at
 * `e_lfanew + 24 (PE sig + COFF) + 68`.
 */
function patchPeToGuiSubsystem(exePath: string): void {
  const buf = readFileSync(exePath);
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOff) !== 0x0000_4550) return; // not "PE\0\0"
  const subsystemOff = peOff + 92;
  if (buf.readUInt16LE(subsystemOff) === 3 /* CONSOLE */) {
    buf.writeUInt16LE(2 /* GUI */, subsystemOff);
    writeFileSync(exePath, buf);
  }
}

/**
 * Stamp a Bun-compiled Windows exe with the app icon + version metadata via
 * rcedit. Bun's `--windows-icon` is a silent no-op on Windows hosts, so without
 * this the exe keeps Bun's icon — which the Start Menu / Desktop shortcut, the
 * taskbar, and Explorer all show. Uses a single largest-size icon: rcedit's
 * multi-size replacement silently fails on Bun's appended-payload exes, while a
 * single 256 entry takes and Windows downscales it cleanly for smaller views.
 * Best-effort — warns (doesn't fail the build) if rcedit isn't installed.
 */
async function brandWindowsExe(
  exe: string,
  opts: {
    projectDir: string;
    work: string;
    appName: string;
    version: string;
    icon?: string;
    publisher: string;
  },
): Promise<void> {
  if (!Bun.which("rcedit")) {
    console.warn(
      "[mirin build] rcedit not found — the Windows exe keeps Bun's default icon. " +
        "Install it: `scoop install rcedit` (or `choco install rcedit`).",
    );
    return;
  }
  const args: string[] = [];
  if (opts.icon) {
    const ico = makeWindowsIcon(join(opts.projectDir, opts.icon), join(opts.work, "exe-icon.ico"), {
      onlyLargest: true,
    });
    if (ico) args.push("--set-icon", ico);
  }
  const fv = winFileVersion(opts.version);
  args.push(
    "--set-version-string", "ProductName", opts.appName,
    "--set-version-string", "FileDescription", opts.appName,
    "--set-version-string", "CompanyName", opts.publisher,
    "--set-file-version", fv,
    "--set-product-version", fv,
  );
  const res = await $`rcedit ${exe} ${args}`.nothrow();
  if (res.exitCode !== 0) {
    console.warn(`[mirin build] rcedit failed (exit ${res.exitCode}) — exe branding skipped.`);
  }
}

export interface BuildResult {
  /** Path to the assembled .app. */
  app: string;
  appName: string;
  bundleId: string;
  /** App version (from the project's package.json). */
  version: string;
  /** Update channel (config.release.channel ?? "stable"). */
  channel: string;
  /** Update baseUrl, if `release` is configured. */
  baseUrl?: string;
  /** libmirin_core path (for the updater codec at release time). */
  coreDylib: string;
  /** Project root (so `mirin release` can resolve relative asset paths). */
  projectDir: string;
  /** DMG config from mirin.config.ts (`true`/object/`false`); default `true`. */
  dmg: boolean | import("mirinjs").DmgConfig;
  /** NSIS installer config (Windows) — `true`/object/`false`; default `true`. */
  nsis: boolean | import("mirinjs").NsisConfig;
  /** Inno Setup installer config (Windows) — preferred over NSIS; default `true`. */
  inno: boolean | import("mirinjs").InnoConfig;
  /** Publisher / company name (config.publisher ?? appName). */
  publisher: string;
  /** Codesign identity used for the bundle, if any (MIRIN_SIGN_IDENTITY). */
  signIdentity?: string;
}

/** Read the project's package.json version (the single source of app version). */
function appVersion(projectDir: string): string {
  const pkgPath = join(projectDir, "package.json");
  if (!existsSync(pkgPath)) return "0.0.0";
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function build(projectDir = process.cwd()): Promise<BuildResult> {
  const outDir = join(projectDir, "build");
  const work = join(projectDir, ".mirin");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  sweepBuildTemps(projectDir);

  const config = (await import(join(projectDir, "mirin.config.ts"))).default;
  const appName: string = config.name ?? "Mirin App";
  const bundleId: string = config.id ?? "dev.mirin.app";
  const mainEntry = join(projectDir, config.main ?? "main/main.ts");
  const version = appVersion(projectDir);
  const channel: string = config.release?.channel ?? "stable";
  const baseUrl: string | undefined = config.release?.baseUrl;
  const dmg: boolean | import("mirinjs").DmgConfig = config.dmg ?? true;
  const nsis: boolean | import("mirinjs").NsisConfig = config.nsis ?? true;
  const inno: boolean | import("mirinjs").InnoConfig = config.inno ?? true;
  const publisher: string = config.publisher ?? appName;

  console.log(`[mirin build] ${appName} ${version}`);

  // 1. production UI
  console.log("[mirin build] vite build…");
  await $`bunx vite build`.cwd(projectDir);

  // 2. native artifacts (release)
  const artifacts = await resolveArtifacts({ release: true });

  // 3 + 4. host + worker (minified)
  console.log("[mirin build] compiling host + bundling main process…");
  const signIdentity = process.env.MIRIN_SIGN_IDENTITY;
  const hostExe = join(work, IS_WINDOWS ? "host-release.exe" : "host-release");
  const workerJs = join(work, "worker.release.js");
  await $`bun build --compile --minify ${artifacts.hostEntry} --outfile ${hostExe}`.cwd(projectDir);
  if (IS_WINDOWS) {
    patchPeToGuiSubsystem(hostExe);
    await brandWindowsExe(hostExe, {
      projectDir,
      work,
      appName,
      version,
      icon: config.icon,
      publisher,
    });
  }
  await $`bun build ${mainEntry} --target=bun --minify --outfile ${workerJs}`.cwd(projectDir);

  // Extra assets: resolve sidecar binaries + compile any extra worker entries.
  const sidecars = normalizeSidecars(projectDir, config.sidecars);
  const extraWorkers = await compileWorkers(projectDir, config.workers, join(work, "workers"), true);

  // 5. assemble (+ sign on macOS)
  console.log(`[mirin build] assembling ${IS_WINDOWS ? "app folder" : ".app"}…`);
  // version.json embeds the running app's update identity (read by app.updater).
  // Only when `release` is configured — otherwise the app has no updater.
  const versionJson = baseUrl
    ? JSON.stringify({ version, channel, baseUrl, name: appName, identifier: bundleId })
    : undefined;
  const resources = {
    uiDir: join(projectDir, "dist"),
    workerJs,
    manifestJson: JSON.stringify({ windows: config.windows, singleInstance: config.singleInstance }),
    versionJson,
    workers: extraWorkers,
  };
  const { app } = IS_WINDOWS
    ? await buildWindowsBundle({
        appName,
        outDir,
        hostExe,
        coreDll: artifacts.coreDylib,
        helperExe: artifacts.helperBin,
        cefPath: artifacts.cefPath,
        icon: config.icon ? join(projectDir, config.icon) : undefined,
        resources: { ...resources, sidecars: sidecars.map((s) => ({ name: s.name, src: s.src })) },
      })
    : await buildAppBundle({
        appName,
        bundleId,
        outDir,
        hostExe,
        coreDylib: artifacts.coreDylib,
        helperBin: artifacts.helperBin,
        cefPath: artifacts.cefPath,
        version,
        icon: config.icon ? join(projectDir, config.icon) : undefined,
        signIdentity,
        urlSchemes: config.urlSchemes,
        resources: { ...resources, sidecars },
      });

  console.log(`\n[mirin build] done → ${app}`);
  return {
    app,
    appName,
    bundleId,
    version,
    channel,
    baseUrl,
    coreDylib: artifacts.coreDylib,
    projectDir,
    dmg,
    nsis,
    inno,
    publisher,
    signIdentity,
  };
}
