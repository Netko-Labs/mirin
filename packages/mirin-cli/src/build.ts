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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { assertRuntimePackageCompatibility, resolveArtifacts } from "./artifacts.ts";
import { buildLinuxBundle } from "./bundle/linux/index.ts";
import { buildAppBundle } from "./bundle/macos/index.ts";
import { normalizeCefLocales } from "./bundle/shared/cef-locales.ts";
import { buildWindowsBundle } from "./bundle/windows/index.ts";
import { compileWorkers, normalizeSidecars, normalizeWorkers } from "./extras.ts";
import { makeWindowsIcon } from "./icons/windows/index.ts";
import { buildLinuxPackages, resolveLinuxFormats } from "./package/linux/index.ts";
import {
  assertProjectIcon,
  canonicalProjectRoot,
  resolveProjectFile,
  resolveProjectIcon,
  validateOwnedOutputDirectory,
} from "./shared/fs/project-source.ts";
import {
  resolveAppVersion,
  validateAppIdentity,
  validateReleaseNotes,
} from "./shared/validation/config.ts";
import { validateUpdatePublicKey } from "./shared/validation/update-key.ts";
import {
  serializeVersionMetadata,
  validateReleaseBaseUrl,
} from "./shared/validation/version-json.ts";
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
    const icon = assertProjectIcon(opts.projectDir, opts.icon, "app icon");
    const ico = makeWindowsIcon(icon, join(opts.work, "exe-icon.ico"), { onlyLargest: true });
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
  /** Ed25519 public key embedded into version.json for manifest verification. */
  updatePublicKey?: string;
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
  // Preflight every value that becomes a path or release identity before creating,
  // cleaning, compiling, downloading, or recursively removing anything.
  const root = canonicalProjectRoot(projectDir);
  const config = (await import(join(root, "mirin.config.ts"))).default;
  const identity = validateAppIdentity({
    appName: config.name === undefined ? "Mirin App" : config.name,
    bundleId: config.id === undefined ? "dev.mirin.app" : config.id,
    channel: config.release?.channel === undefined ? "stable" : config.release.channel,
    version: resolveAppVersion(root, opts.version),
  });
  const { appName, bundleId, version, channel } = identity;
  const mainEntry = resolveProjectFile(root, config.main ?? "main/main.ts", "main entry");
  const icon =
    config.icon === undefined ? undefined : resolveProjectIcon(root, config.icon, "app icon");
  const releaseNotes = validateReleaseNotes(config.release?.notes);
  const baseUrl: string | undefined =
    config.release === undefined ? undefined : config.release.baseUrl;
  if (config.release !== undefined) validateReleaseBaseUrl(baseUrl);
  const updatePublicKey =
    config.release === undefined
      ? undefined
      : validateUpdatePublicKey(config.release.publicKey ?? process.env.MIRIN_UPDATE_PUBLIC_KEY);
  const dmg: boolean | import("mirinjs").DmgConfig = config.dmg ?? true;
  const nsis: boolean | import("mirinjs").NsisConfig = config.nsis ?? true;
  const inno: boolean | import("mirinjs").InnoConfig = config.inno ?? true;
  const linux: boolean | import("mirinjs").LinuxConfig = config.linux ?? true;
  const publisher: string = config.publisher ?? appName;
  const cefLocales = normalizeCefLocales(config.cef?.locales);
  const sidecars = normalizeSidecars(root, config.sidecars);
  const workers = normalizeWorkers(root, config.workers);
  assertRuntimePackageCompatibility(root);
  const versionJson =
    config.release === undefined
      ? undefined
      : serializeVersionMetadata({ ...identity, baseUrl, publicKey: updatePublicKey });

  const outDir = validateOwnedOutputDirectory(root, "build", "build output directory");
  const work = validateOwnedOutputDirectory(root, ".mirin", "build work directory");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  sweepBuildTemps(root);

  console.log(`[mirin build] ${appName} ${version}`);

  // Production UI and native artifacts do not share outputs, so overlap them.
  console.log("[mirin build] building UI + native artifacts…");
  const [, artifacts] = await Promise.all([
    $`bunx vite build`.cwd(root),
    resolveArtifacts({ release: true }),
  ]);

  // Host compilation, main Worker bundling, and extra Worker bundling are independent.
  console.log("[mirin build] compiling host + bundling workers…");
  const signIdentity = process.env.MIRIN_SIGN_IDENTITY;
  const hostExe = join(work, IS_WINDOWS ? "host-release.exe" : "host-release");
  const workerJs = join(work, "worker.release.js");
  const hostBuild = (async (): Promise<void> => {
    // Bun's Windows arm64 build currently has no bun:ffi/TinyCC runtime. The
    // win32-arm64 Mirin package therefore carries an x64 compatibility payload,
    // which Windows 11 ARM executes through its built-in x64 emulation layer.
    const target = IS_WINDOWS && process.arch === "arm64" ? ["--target=bun-windows-x64"] : [];
    await $`bun build --compile --minify ${target} ${artifacts.hostEntry} --outfile ${hostExe}`.cwd(
      root,
    );
    if (IS_WINDOWS) {
      patchPeToGuiSubsystem(hostExe);
      await brandWindowsExe(hostExe, {
        projectDir: root,
        work,
        appName,
        version,
        icon,
        publisher,
      });
    }
  })();
  const workerBuild = $`bun build ${mainEntry} --target=bun --minify --outfile ${workerJs}`.cwd(
    root,
  );
  const extraWorkersBuild = compileWorkers(root, workers, join(work, "workers"), true);
  const [, , extraWorkers] = await Promise.all([hostBuild, workerBuild, extraWorkersBuild]);

  // 5. assemble (+ sign on macOS)
  const artifactKind = IS_WINDOWS ? "app folder" : IS_LINUX ? "app folder" : ".app";
  console.log(`[mirin build] assembling ${artifactKind}…`);
  // version.json embeds the validated running app identity (read by app.updater).
  // Only when `release` is configured — otherwise the app has no updater.
  const resources = {
    uiDir: join(root, "dist"),
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
        bundleId,
        version,
        channel,
        projectDir: root,
        outDir,
        hostExe,
        coreDll: artifacts.coreDylib,
        helperExe: artifacts.helperBin,
        cefPath: artifacts.cefPath,
        cefLocales,
        icon,
        resources: { ...resources, sidecars: sidecars.map((s) => ({ name: s.name, src: s.src })) },
      })
    : IS_LINUX
      ? await buildLinuxBundle({
          appName,
          bundleId,
          version,
          channel,
          projectDir: root,
          outDir,
          hostExe,
          coreDll: artifacts.coreDylib,
          helperExe: artifacts.helperBin,
          cefPath: artifacts.cefPath,
          cefLocales,
          icon,
          resources: {
            ...resources,
            sidecars: sidecars.map((s) => ({ name: s.name, src: s.src })),
          },
        })
      : await buildAppBundle({
          appName,
          bundleId,
          version,
          channel,
          projectDir: root,
          outDir,
          hostExe,
          coreDylib: artifacts.coreDylib,
          helperBin: artifacts.helperBin,
          cefPath: artifacts.cefPath,
          cefLocales,
          icon,
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
      projectDir: root,
      icon,
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
    updatePublicKey,
    releaseNotes,
    coreDylib: artifacts.coreDylib,
    codecBin: artifacts.codecBin,
    projectDir: root,
    dmg,
    nsis,
    inno,
    linux,
    publisher,
    icon,
    signIdentity,
  };
}
