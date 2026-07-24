/**
 * Linux distributable packages for a mirin app — **AppImage**, **.deb**, **.rpm** —
 * built from the assembled Linux app folder (buildLinuxBundle's output). This is the
 * Linux analog of dmg.ts (macOS) and installer-inno.ts / installer-win.ts (Windows):
 * `mirin build` (with packaging requested) and `mirin release` call it after the app
 * folder is assembled.
 *
 * The app folder is a flat, relocatable payload — the host binary, libcef.so + the
 * CEF runtime, and `resources/`, all resolved at runtime from an `$ORIGIN` rpath and
 * `dirname(process.execPath)` (host.ts). Every package therefore ships the whole
 * folder verbatim under one prefix and points a launcher at the *real* host binary
 * inside it (never a bare PATH name — the host derives everything from its own dir):
 *
 *   - deb / rpm: payload → `/opt/<id>/`, a `/usr/bin/<bin>` wrapper `exec`s
 *     `/opt/<id>/<App>`, plus `/usr/share/applications/<id>.desktop` and a
 *     `/usr/share/icons/hicolor/256x256/apps/<id>.png`.
 *   - AppImage: payload → `AppDir/usr/lib/<id>/`, top-level `AppRun` `exec`s it,
 *     `<id>.desktop` + `<id>.png` (+ `.DirIcon`) at the AppDir root, packed by
 *     appimagetool.
 *
 * Tooling (resolved via $MIRIN_FPM / $MIRIN_APPIMAGETOOL, then PATH, then a
 * conventional fallback — see resolveTool):
 *   - **fpm** builds both deb and rpm in pure Ruby (no dpkg/rpmbuild on the host).
 *   - **appimagetool** packs the AppImage (invoked with `--appimage-extract-and-run`
 *     so it works on hosts without FUSE).
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { desktopEntry, resolveLinuxDesktopIconPng } from "../../bundle/linux/index.ts";
import { DEFAULT_DEB_DEPENDS, DEFAULT_RPM_DEPENDS, LINUX_FORMATS } from "./lib/defaults.ts";
import { resolveAppimagetool, resolveFpm } from "./lib/tools.ts";
import { safeLinuxPackageInput, safePackageName, validateLinuxFormats } from "./lib/validation.ts";
import type {
  LinuxConfig,
  LinuxPackageFormat,
  LinuxPackageInput,
  LinuxPackageResult,
} from "./types.ts";

const size = (p: string) => statSync(p).size;

/** Cleanup failure is fatal because a best-effort release must not commit partial packages. */
export class LinuxPackageCleanupError extends Error {
  readonly packageFailure: unknown;
  readonly cleanupFailure: unknown;

  constructor(packageFailure: unknown, cleanupFailure: unknown) {
    super("Linux package output cleanup failed; refusing to commit partial release artifacts");
    this.name = "LinuxPackageCleanupError";
    this.packageFailure = packageFailure;
    this.cleanupFailure = cleanupFailure;
  }
}

/** Build every requested Linux package; returns each artifact's path + size. */
export async function buildLinuxPackages(input: LinuxPackageInput): Promise<LinuxPackageResult[]> {
  const safeInput = safeLinuxPackageInput(input);
  mkdirSync(safeInput.outDir, { recursive: true });
  const binName = safePackageName(
    safeInput.options.binName ?? safeInput.bundleId.split(".").pop() ?? safeInput.appName,
  );
  const outputPaths = linuxPackageOutputPaths(safeInput, binName);
  // deb + rpm share one staged filesystem tree (payload under /opt, launcher,
  // .desktop, icon). Build it once and reuse. Package compressors only read the
  // staged tree, so all requested formats can run concurrently.
  const needFsTree = safeInput.formats.includes("deb") || safeInput.formats.includes("rpm");
  const fsRoot = needFsTree ? join(safeInput.outDir, `.pkgroot-${process.pid}`) : undefined;
  try {
    return await runWithLinuxStagingCleanup(fsRoot, async () => {
      if (fsRoot) stageFsTree(safeInput, binName, fsRoot);
      return await settleLinuxPackageBuilds(
        safeInput.formats.map((format) => {
          if (format === "appimage") return buildAppImage(safeInput, binName);
          if (!fsRoot) throw new Error("Linux package staging is unavailable");
          return buildFpm(safeInput, binName, fsRoot, format);
        }),
        outputPaths,
      );
    });
  } catch (error) {
    throwAfterLinuxOutputCleanup(outputPaths, error);
  }
}

export async function runWithLinuxStagingCleanup<T>(
  staging: string | undefined,
  run: () => Promise<T> | T,
  remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true }),
): Promise<T> {
  let result: T | undefined;
  let failed = false;
  let packageFailure: unknown;
  try {
    result = await run();
  } catch (error) {
    failed = true;
    packageFailure = error;
  }

  if (staging) {
    try {
      remove(staging);
    } catch (cleanupError) {
      throw new LinuxPackageCleanupError(packageFailure, cleanupError);
    }
  }
  if (failed) throw packageFailure;
  return result as T;
}

/**
 * Wait for every concurrently started packager before shared staging cleanup.
 * If any format fails, remove successful sibling artifacts and propagate failure
 * only after all child processes have settled.
 */
export async function settleLinuxPackageBuilds(
  jobs: Promise<LinuxPackageResult>[],
  expectedPaths: readonly string[] = [],
): Promise<LinuxPackageResult[]> {
  const settled = await Promise.allSettled(jobs);
  const successful = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const failure = settled.find((result) => result.status === "rejected");
  if (!failure || failure.status !== "rejected") return successful;

  removeLinuxPackageOutputs([...expectedPaths, ...successful.map((artifact) => artifact.path)]);
  throw failure.reason;
}

function removeLinuxPackageOutputs(paths: readonly string[]): void {
  const failures: unknown[] = [];
  for (const path of new Set(paths)) {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "failed to remove Linux package output");
  }
}

function throwAfterLinuxOutputCleanup(paths: readonly string[], packageFailure: unknown): never {
  try {
    removeLinuxPackageOutputs(paths);
  } catch (cleanupError) {
    throw new LinuxPackageCleanupError(packageFailure, cleanupError);
  }
  throw packageFailure;
}

function linuxPackageOutputPaths(input: LinuxPackageInput, binName: string): string[] {
  return input.formats.map((format) => {
    const arch = linuxPackageArch(format);
    switch (format) {
      case "appimage":
        return join(input.outDir, `${input.appName}-${input.version}-${arch}.AppImage`);
      case "deb":
        return join(input.outDir, `${binName}_${input.version}_${arch}.deb`);
      case "rpm":
        return join(input.outDir, `${binName}-${input.version}-1.${arch}.rpm`);
      default:
        throw new Error(`unsupported Linux package format: ${format}`);
    }
  });
}

/**
 * Stage the on-disk filesystem layout deb/rpm install: the whole payload under
 * `/opt/<id>/`, a `/usr/bin/<bin>` wrapper `exec`ing the real host binary, the
 * `.desktop` entry, and a hicolor icon. Returns the staging root (fpm's `-C` chdir).
 */
function stageFsTree(input: LinuxPackageInput, binName: string, root: string): void {
  rmSync(root, { recursive: true, force: true });

  // Payload → /opt/<id>/…
  const prefix = join(root, "opt", input.bundleId);
  mkdirSync(prefix, { recursive: true });
  cpSync(input.appDir, prefix, { recursive: true });
  stripUpdaterMetadataForManagedPackage(prefix);

  // /usr/bin/<bin>: a wrapper that exec's the real binary so process.execPath (and
  // thus the host's core/resources/helper resolution) points into /opt/<id>.
  const binDir = join(root, "usr", "bin");
  mkdirSync(binDir, { recursive: true });
  const launcher = join(binDir, binName);
  writeFileSync(launcher, `#!/bin/sh\nexec "/opt/${input.bundleId}/${input.appName}" "$@"\n`);
  chmodSync(launcher, 0o755);

  // /usr/share/applications/<id>.desktop — Icon= is the theme name (<id>), resolved
  // from the hicolor icon below; Exec= is the /usr/bin launcher on PATH.
  const appsDir = join(root, "usr", "share", "applications");
  mkdirSync(appsDir, { recursive: true });
  writeFileSync(join(appsDir, `${input.bundleId}.desktop`), buildDesktop(input, binName));

  stageHicolorIcon(root, input);
}

/** Install the app icon at `usr/share/icons/hicolor/256x256/apps/<id>.png` under `root`. */
function stageHicolorIcon(root: string, input: LinuxPackageInput): void {
  const png = input.icon ? resolveLinuxDesktopIconPng(input.icon) : undefined;
  if (!png) return;
  const dir = join(root, "usr", "share", "icons", "hicolor", "256x256", "apps");
  mkdirSync(dir, { recursive: true });
  cpSync(png, join(dir, `${input.bundleId}.png`));
}

/** The `.desktop` body shared by deb/rpm/AppImage (Exec = launcher name, Icon = <id>). */
function buildDesktop(input: LinuxPackageInput, binName: string): string {
  return desktopEntry({
    name: input.appName,
    exec: binName,
    iconPng: input.bundleId,
    wmClass: input.bundleId,
    categories: input.options.category ?? "Utility",
    comment: input.options.description,
  });
}

/** Build a .deb or .rpm from the staged tree via fpm. */
async function buildFpm(
  input: LinuxPackageInput,
  binName: string,
  fsRoot: string,
  kind: "deb" | "rpm",
): Promise<LinuxPackageResult> {
  const arch = linuxPackageArch(kind);
  const fileName =
    kind === "deb"
      ? `${binName}_${input.version}_${arch}.deb`
      : `${binName}-${input.version}-1.${arch}.rpm`;
  const out = join(input.outDir, fileName);
  try {
    const fpm = resolveFpm();
    rmSync(out, { force: true });

    const depends =
      kind === "deb"
        ? (input.options.debDepends ?? DEFAULT_DEB_DEPENDS)
        : (input.options.rpmDepends ?? DEFAULT_RPM_DEPENDS);

    const args: string[] = [
      "-s",
      "dir",
      "-t",
      kind,
      "-C",
      fsRoot,
      "--package",
      out,
      "--name",
      binName,
      "--version",
      input.version,
      "--iteration",
      "1",
      "--architecture",
      arch,
      "--maintainer",
      input.options.maintainer ?? input.publisher,
      "--vendor",
      input.publisher,
      "--description",
      input.options.description ?? input.appName,
    ];
    if (input.options.homepage) args.push("--url", input.options.homepage);
    if (input.options.license) args.push("--license", input.options.license);
    for (const d of depends) args.push("--depends", d);
    // CEF dominates the payload. Level 3 avoids spending minutes chasing small
    // gains while retaining gzip compatibility across Debian and RPM families.
    args.push(
      kind === "deb" ? "--deb-compression" : "--rpm-compression",
      kind === "deb" ? "gz" : "gzip",
      kind === "deb" ? "--deb-compression-level" : "--rpm-compression-level",
      "3",
    );
    // Package the whole staged tree ('.' relative to the -C chdir).
    args.push(".");

    console.log(`[mirin] building ${kind} → ${fileName}`);
    const res = await $`${fpm} ${args}`.nothrow().quiet();
    if (res.exitCode !== 0 || !existsSync(out)) {
      throw new Error(`fpm (${kind}) failed (exit ${res.exitCode}):\n${res.stderr.toString()}`);
    }
    return { format: kind, path: out, size: size(out) };
  } catch (error) {
    throwAfterLinuxOutputCleanup([out], error);
  }
}

/** Build an AppDir and pack it into a single-file AppImage via appimagetool. */
async function buildAppImage(
  input: LinuxPackageInput,
  binName: string,
): Promise<LinuxPackageResult> {
  const appDirRoot = join(input.outDir, `.AppDir-${process.pid}`);
  const arch = linuxPackageArch("appimage");
  const fileName = `${input.appName}-${input.version}-${arch}.AppImage`;
  const out = join(input.outDir, fileName);
  try {
    return await runWithLinuxStagingCleanup(appDirRoot, async () => {
      const appimagetool = resolveAppimagetool();
      rmSync(appDirRoot, { recursive: true, force: true });
      rmSync(out, { force: true });

      // Payload → AppDir/usr/lib/<id>/ so $ORIGIN resolves within it.
      const payload = join(appDirRoot, "usr", "lib", input.bundleId);
      mkdirSync(payload, { recursive: true });
      cpSync(input.appDir, payload, { recursive: true });
      stripUpdaterMetadataForManagedPackage(payload);

      // AppRun: exec the real host binary (resolves core/resources/helper from its dir).
      const appRun = join(appDirRoot, "AppRun");
      writeFileSync(
        appRun,
        [
          "#!/bin/sh",
          'HERE="$(dirname "$(readlink -f "$0")")"',
          `exec "$HERE/usr/lib/${input.bundleId}/${input.appName}" "$@"`,
          "",
        ].join("\n"),
      );
      chmodSync(appRun, 0o755);

      // .desktop at the AppDir root (appimagetool reads it) + the standard location.
      const desktop = buildDesktop(input, binName);
      writeFileSync(join(appDirRoot, `${input.bundleId}.desktop`), desktop);
      const appsDir = join(appDirRoot, "usr", "share", "applications");
      mkdirSync(appsDir, { recursive: true });
      writeFileSync(join(appsDir, `${input.bundleId}.desktop`), desktop);

      // Icon: <id>.png + .DirIcon at the root, plus the hicolor copy.
      const png = input.icon ? resolveLinuxDesktopIconPng(input.icon) : undefined;
      if (png) {
        cpSync(png, join(appDirRoot, `${input.bundleId}.png`));
        try {
          symlinkSync(`${input.bundleId}.png`, join(appDirRoot, ".DirIcon"));
        } catch {
          /* best-effort: some filesystems disallow symlinks */
        }
        stageHicolorIcon(appDirRoot, input);
      }

      console.log(`[mirin] building AppImage → ${fileName}`);
      // --appimage-extract-and-run: run appimagetool without FUSE. ARCH is required by
      // appimagetool; NO_STRIP avoids stripping the Bun-compiled host.
      const res = await $`${appimagetool} --appimage-extract-and-run ${appDirRoot} ${out}`
        .env({ ...process.env, ARCH: arch, NO_STRIP: "1" })
        .nothrow()
        .quiet();
      if (res.exitCode !== 0 || !existsSync(out)) {
        throw new Error(`appimagetool failed (exit ${res.exitCode}):\n${res.stderr.toString()}`);
      }
      chmodSync(out, 0o755);
      return { format: "appimage", path: out, size: size(out) };
    });
  } catch (error) {
    throwAfterLinuxOutputCleanup([out], error);
  }
}

/** System packages and read-only AppImages update through their package channel. */
export function stripUpdaterMetadataForManagedPackage(payload: string): void {
  rmSync(join(payload, "resources", "version.json"), { force: true });
}

function linuxPackageArch(kind: "appimage" | "deb" | "rpm"): string {
  if (process.arch === "arm64") {
    return kind === "deb" ? "arm64" : "aarch64";
  }
  return kind === "deb" ? "amd64" : "x86_64";
}

/** Resolve the effective set of formats from config + an optional CLI/caller override. */
export function resolveLinuxFormats(
  linux: boolean | LinuxConfig | undefined,
  override?: LinuxPackageFormat[],
): LinuxPackageFormat[] {
  if (override?.length) return validateLinuxFormats(override, "CLI override");
  const fromConfig = typeof linux === "object" ? linux.formats : undefined;
  return fromConfig?.length
    ? validateLinuxFormats(fromConfig, "mirin.config.ts linux.formats")
    : [...LINUX_FORMATS];
}

export function parseLinuxFormats(raw: string): LinuxPackageFormat[] {
  const formats = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!formats.length) {
    throw new Error("[mirin] --linux-target needs at least one format: appimage, deb, or rpm.");
  }
  return validateLinuxFormats(formats, "--linux-target");
}
