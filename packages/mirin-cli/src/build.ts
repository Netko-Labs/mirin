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
  const hostCmd = ["build", "--compile", "--minify", artifacts.hostEntry, "--outfile", hostExe];
  if (IS_WINDOWS) {
    // A GUI-subsystem exe (no console window on launch) with an embedded icon +
    // version metadata — so the Start Menu / Desktop shortcut + taskbar show the
    // app's icon, not a generic one (Bun ≥1.2 PE flags; mirrors Electrobun's
    // GUI-subsystem + embedded-icon launcher).
    const nsisCfg = typeof nsis === "object" ? nsis : {};
    const winIcon = config.icon
      ? makeWindowsIcon(join(projectDir, config.icon), join(work, "host-icon.ico"))
      : undefined;
    hostCmd.push(
      "--windows-hide-console",
      `--windows-title=${appName}`,
      `--windows-version=${winFileVersion(version)}`,
      `--windows-publisher=${nsisCfg.publisher ?? appName}`,
      `--windows-description=${appName}`,
    );
    if (winIcon) hostCmd.push(`--windows-icon=${winIcon}`);
  }
  await $`bun ${hostCmd}`.cwd(projectDir);
  if (IS_WINDOWS) patchPeToGuiSubsystem(hostExe);
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
    manifestJson: JSON.stringify({ windows: config.windows }),
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
    signIdentity,
  };
}
