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

/** Build every requested Linux package; returns each artifact's path + size. */
export async function buildLinuxPackages(input: LinuxPackageInput): Promise<LinuxPackageResult[]> {
  const safeInput = safeLinuxPackageInput(input);
  mkdirSync(safeInput.outDir, { recursive: true });
  const binName = safePackageName(
    safeInput.options.binName ?? safeInput.bundleId.split(".").pop() ?? safeInput.appName,
  );
  // deb + rpm share one staged filesystem tree (payload under /opt, launcher,
  // .desktop, icon). Build it once and reuse. Package compressors only read the
  // staged tree, so all requested formats can run concurrently.
  const needFsTree = safeInput.formats.includes("deb") || safeInput.formats.includes("rpm");
  let fsRoot: string | undefined;
  try {
    if (needFsTree) fsRoot = stageFsTree(safeInput, binName);
    return await Promise.all(
      safeInput.formats.map((format) =>
        format === "appimage"
          ? buildAppImage(safeInput, binName)
          : buildFpm(safeInput, binName, fsRoot!, format),
      ),
    );
  } finally {
    if (fsRoot) rmSync(fsRoot, { recursive: true, force: true });
  }
}

/**
 * Stage the on-disk filesystem layout deb/rpm install: the whole payload under
 * `/opt/<id>/`, a `/usr/bin/<bin>` wrapper `exec`ing the real host binary, the
 * `.desktop` entry, and a hicolor icon. Returns the staging root (fpm's `-C` chdir).
 */
function stageFsTree(input: LinuxPackageInput, binName: string): string {
  const root = join(input.outDir, `.pkgroot-${process.pid}`);
  rmSync(root, { recursive: true, force: true });

  // Payload → /opt/<id>/…
  const prefix = join(root, "opt", input.bundleId);
  mkdirSync(prefix, { recursive: true });
  cpSync(input.appDir, prefix, { recursive: true });

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
  return root;
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
  const fpm = resolveFpm();
  const arch = kind === "deb" ? "amd64" : "x86_64";
  const fileName =
    kind === "deb"
      ? `${binName}_${input.version}_${arch}.deb`
      : `${binName}-${input.version}-1.${arch}.rpm`;
  const out = join(input.outDir, fileName);
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
}

/** Build an AppDir and pack it into a single-file AppImage via appimagetool. */
async function buildAppImage(
  input: LinuxPackageInput,
  binName: string,
): Promise<LinuxPackageResult> {
  const appimagetool = resolveAppimagetool();
  const appDirRoot = join(input.outDir, `.AppDir-${process.pid}`);
  rmSync(appDirRoot, { recursive: true, force: true });

  // Payload → AppDir/usr/lib/<id>/ so $ORIGIN resolves within it.
  const payload = join(appDirRoot, "usr", "lib", input.bundleId);
  mkdirSync(payload, { recursive: true });
  cpSync(input.appDir, payload, { recursive: true });

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

  const fileName = `${input.appName}-${input.version}-x86_64.AppImage`;
  const out = join(input.outDir, fileName);
  rmSync(out, { force: true });

  console.log(`[mirin] building AppImage → ${fileName}`);
  // --appimage-extract-and-run: run appimagetool without FUSE. ARCH is required by
  // appimagetool; NO_STRIP avoids stripping the Bun-compiled host (which would break it).
  const res = await $`${appimagetool} --appimage-extract-and-run ${appDirRoot} ${out}`
    .env({ ...process.env, ARCH: "x86_64", NO_STRIP: "1" })
    .nothrow()
    .quiet();
  rmSync(appDirRoot, { recursive: true, force: true });
  if (res.exitCode !== 0 || !existsSync(out)) {
    throw new Error(`appimagetool failed (exit ${res.exitCode}):\n${res.stderr.toString()}`);
  }
  chmodSync(out, 0o755);
  return { format: "appimage", path: out, size: size(out) };
}

/** Resolve the effective set of formats from config + an optional CLI/caller override. */
export function resolveLinuxFormats(
  linux: boolean | LinuxConfig | undefined,
  override?: LinuxPackageFormat[],
): LinuxPackageFormat[] {
  if (override && override.length) return validateLinuxFormats(override, "CLI override");
  const fromConfig = typeof linux === "object" ? linux.formats : undefined;
  return fromConfig && fromConfig.length
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
