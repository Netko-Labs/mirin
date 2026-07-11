/**
 * `mirin build` — package a standalone, signed .app (docs/macos-mvp.md).
 *
 * 1. vite build + native artifact resolution run in parallel.
 * 2. compile host + bundle Workers run in parallel.
 * 3. assemble + sign the app from the completed artifacts.
 *
 * The result runs with no env and no dev server: the host resolves everything
 * from inside the bundle, and webviews load their `app://` URLs served from
 * Contents/Resources by the native scheme handler.
 *
 * Codesign identity: ad-hoc by default; set MIRIN_SIGN_IDENTITY to a Developer
 * ID to produce a distributable, notarizable app.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { resolveArtifacts } from "./artifacts.ts";
import { buildLinuxBundle } from "./bundle/linux/index.ts";
import { buildAppBundle } from "./bundle/macos/index.ts";
import { normalizeCefLocales } from "./bundle/shared/cef-locales.ts";
import { buildWindowsBundle } from "./bundle/windows/index.ts";
import { compileWorkers, normalizeSidecars } from "./extras.ts";
import { makeWindowsIcon } from "./icons/windows/index.ts";
import { buildLinuxPackages, resolveLinuxFormats } from "./package/linux/index.ts";
import { sweepBuildTemps } from "./temps.ts";

const IS_WINDOWS = process.platform === "win32";
const IS_LINUX = process.platform === "linux";

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
    "--set-version-string",
    "ProductName",
    opts.appName,
    "--set-version-string",
    "FileDescription",
    opts.appName,
    "--set-version-string",
    "CompanyName",
    opts.publisher,
    "--set-file-version",
    fv,
    "--set-product-version",
    fv,
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
  /** Markdown release notes embedded in the updater manifest, if configured. */
  releaseNotes?: string;
  /** libmirin_core path (for the updater codec at release time). */
  coreDylib: string;
  /** Standalone updater codec executable used at release time. */
  codecBin: string;
  /** Project root (so `mirin release` can resolve relative asset paths). */
  projectDir: string;
  /** DMG config from mirin.config.ts (`true`/object/`false`); default `true`. */
  dmg: boolean | import("mirinjs").DmgConfig;
  /** NSIS installer config (Windows) — `true`/object/`false`; default `true`. */
  nsis: boolean | import("mirinjs").NsisConfig;
  /** Inno Setup installer config (Windows) — preferred over NSIS; default `true`. */
  inno: boolean | import("mirinjs").InnoConfig;
  /** Linux packaging config (`mirin.config.ts` `linux`) — `true`/object/`false`; default `true`. */
  linux: boolean | import("mirinjs").LinuxConfig;
  /** Publisher / company name (config.publisher ?? appName). */
  publisher: string;
  /** Absolute path to the app icon source (config.icon), if set — for Linux packaging. */
  icon?: string;
  /** Codesign identity used for the bundle, if any (MIRIN_SIGN_IDENTITY). */
  signIdentity?: string;
}

/**
 * The app version: `$MIRIN_APP_VERSION` (release-pipeline override) wins, otherwise
 * the project's package.json `version` (the single source of truth).
 */
function appVersion(projectDir: string): string {
  const override = process.env.MIRIN_APP_VERSION;
  if (override) return override;
  const pkgPath = join(projectDir, "package.json");
  if (!existsSync(pkgPath)) return "0.0.0";
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface BuildOptions {
  /** Override the app version (else `$MIRIN_APP_VERSION` / package.json). */
  version?: string;
  /** On Linux, also emit distributable packages (AppImage/deb/rpm) after assembling. */
  packageLinux?: boolean;
  /** Restrict Linux packaging to these formats (else config.linux.formats / all). */
  linuxFormats?: import("mirinjs").LinuxPackageFormat[];
}

export async function build(
  projectDir = process.cwd(),
  opts: BuildOptions = {},
): Promise<BuildResult> {
  const outDir = join(projectDir, "build");
  const work = join(projectDir, ".mirin");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  sweepBuildTemps(projectDir);

  const config = (await import(join(projectDir, "mirin.config.ts"))).default;
  const appName: string = config.name ?? "Mirin App";
  const bundleId: string = config.id ?? "dev.mirin.app";
  const mainEntry = join(projectDir, config.main ?? "main/main.ts");
  const version = opts.version ?? appVersion(projectDir);
  const channel: string = config.release?.channel ?? "stable";
  const baseUrl: string | undefined = config.release?.baseUrl;
  const releaseNotes: string | undefined = config.release?.notes;
  const dmg: boolean | import("mirinjs").DmgConfig = config.dmg ?? true;
  const nsis: boolean | import("mirinjs").NsisConfig = config.nsis ?? true;
  const inno: boolean | import("mirinjs").InnoConfig = config.inno ?? true;
  const linux: boolean | import("mirinjs").LinuxConfig = config.linux ?? true;
  const publisher: string = config.publisher ?? appName;
  const cefLocales = normalizeCefLocales(config.cef?.locales);

  console.log(`[mirin build] ${appName} ${version}`);

  // Production UI and native artifacts do not share outputs, so overlap them.
  console.log("[mirin build] building UI + native artifacts…");
  const [, artifacts] = await Promise.all([
    $`bunx vite build`.cwd(projectDir),
    resolveArtifacts({ release: true }),
  ]);

  // Host compilation, main Worker bundling, and extra Worker bundling are independent.
  console.log("[mirin build] compiling host + bundling workers…");
  const signIdentity = process.env.MIRIN_SIGN_IDENTITY;
  const hostExe = join(work, IS_WINDOWS ? "host-release.exe" : "host-release");
  const workerJs = join(work, "worker.release.js");
  const sidecars = normalizeSidecars(projectDir, config.sidecars);
  const hostBuild = (async (): Promise<void> => {
    await $`bun build --compile --minify ${artifacts.hostEntry} --outfile ${hostExe}`.cwd(
      projectDir,
    );
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
  })();
  const workerBuild = $`bun build ${mainEntry} --target=bun --minify --outfile ${workerJs}`.cwd(
    projectDir,
  );
  const extraWorkersBuild = compileWorkers(projectDir, config.workers, join(work, "workers"), true);
  const [, , extraWorkers] = await Promise.all([hostBuild, workerBuild, extraWorkersBuild]);

  // 5. assemble (+ sign on macOS)
  const artifactKind = IS_WINDOWS ? "app folder" : IS_LINUX ? "app folder" : ".app";
  console.log(`[mirin build] assembling ${artifactKind}…`);
  // version.json embeds the running app's update identity (read by app.updater).
  // Only when `release` is configured — otherwise the app has no updater.
  const versionJson = baseUrl
    ? JSON.stringify({ version, channel, baseUrl, name: appName, identifier: bundleId })
    : undefined;
  const resources = {
    uiDir: join(projectDir, "dist"),
    workerJs,
    manifestJson: JSON.stringify({
      id: bundleId,
      windows: config.windows,
      singleInstance: config.singleInstance,
    }),
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
        cefLocales,
        icon: config.icon ? join(projectDir, config.icon) : undefined,
        resources: { ...resources, sidecars: sidecars.map((s) => ({ name: s.name, src: s.src })) },
      })
    : IS_LINUX
      ? await buildLinuxBundle({
          appName,
          outDir,
          hostExe,
          coreDll: artifacts.coreDylib,
          helperExe: artifacts.helperBin,
          cefPath: artifacts.cefPath,
          cefLocales,
          icon: config.icon ? join(projectDir, config.icon) : undefined,
          resources: {
            ...resources,
            sidecars: sidecars.map((s) => ({ name: s.name, src: s.src })),
          },
        })
      : await buildAppBundle({
          appName,
          bundleId,
          outDir,
          hostExe,
          coreDylib: artifacts.coreDylib,
          helperBin: artifacts.helperBin,
          cefPath: artifacts.cefPath,
          cefLocales,
          version,
          icon: config.icon ? join(projectDir, config.icon) : undefined,
          signIdentity,
          urlSchemes: config.urlSchemes,
          resources: { ...resources, sidecars },
        });

  console.log(`\n[mirin build] done → ${app}`);

  // Linux: optionally emit distributable packages (AppImage/deb/rpm) straight from
  // `mirin build`. `mirin release` does its own packaging into build/release, so it
  // never sets `packageLinux` — this path only runs for a direct build request.
  if (IS_LINUX && opts.packageLinux && linux !== false) {
    const formats = resolveLinuxFormats(linux, opts.linuxFormats);
    console.log(`[mirin build] packaging Linux artifacts (${formats.join(", ")})…`);
    const pkgs = await buildLinuxPackages({
      appDir: app,
      appName,
      bundleId,
      version,
      publisher,
      outDir,
      projectDir,
      icon: config.icon ? join(projectDir, config.icon) : undefined,
      options: typeof linux === "object" ? linux : {},
      formats,
    });
    const mb = (n: number) => (n / 1e6).toFixed(1);
    for (const p of pkgs) console.log(`  ${p.path} (${mb(p.size)} MB)`);
  }

  return {
    app,
    appName,
    bundleId,
    version,
    channel,
    baseUrl,
    releaseNotes,
    coreDylib: artifacts.coreDylib,
    codecBin: artifacts.codecBin,
    projectDir,
    dmg,
    nsis,
    inno,
    linux,
    publisher,
    icon: config.icon ? join(projectDir, config.icon) : undefined,
    signIdentity,
  };
}
