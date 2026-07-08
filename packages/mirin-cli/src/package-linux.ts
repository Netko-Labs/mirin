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

import { $ } from "bun";
import {
  cpSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { desktopEntry, resolveLinuxDesktopIconPng } from "./bundle-linux.ts";
import type { LinuxConfig, LinuxPackageFormat } from "mirinjs";

export interface LinuxPackageInput {
  /** The assembled Linux app folder (build/<App>): the whole relocatable payload. */
  appDir: string;
  /** App display name; also the host-binary stem inside `appDir`. */
  appName: string;
  /** Reverse-DNS app id, e.g. "dev.netko.anko" (install prefix + `.desktop`/icon name). */
  bundleId: string;
  version: string;
  /** Publisher / company (deb/rpm vendor + maintainer fallback). */
  publisher: string;
  /** Directory the artifacts are written into. */
  outDir: string;
  projectDir: string;
  /** Abs path to the app icon source (`.png` / `.iconset`); resolved to a PNG. */
  icon?: string;
  /** Resolved Linux config (maintainer, depends, category, …). */
  options: LinuxConfig;
  /** Which formats to build. */
  formats: LinuxPackageFormat[];
}

export interface LinuxPackageResult {
  format: LinuxPackageFormat;
  path: string;
  size: number;
}

/** CEF/GTK runtime deps on Debian/Ubuntu package naming (best-effort; overridable). */
const DEFAULT_DEB_DEPENDS = [
  "libgtk-3-0", "libnss3", "libnspr4", "libasound2", "libx11-6", "libxcomposite1",
  "libxdamage1", "libxext6", "libxfixes3", "libxrandr2", "libgbm1", "libxkbcommon0",
  "libpango-1.0-0", "libcairo2", "libatk1.0-0", "libatk-bridge2.0-0", "libcups2",
  "libdrm2", "libdbus-1-3",
];

/** CEF/GTK runtime deps on RPM (Fedora/RHEL/openSUSE) package naming. */
const DEFAULT_RPM_DEPENDS = [
  "gtk3", "nss", "nspr", "alsa-lib", "libX11", "libXcomposite", "libXdamage",
  "libXext", "libXfixes", "libXrandr", "mesa-libgbm", "libxkbcommon", "pango",
  "cairo", "atk", "at-spi2-atk", "cups-libs", "libdrm", "dbus-libs",
];

/**
 * Resolve an external tool path: an explicit `$ENV` override (if it exists), then
 * PATH, then the first existing `fallback`. Throws a clear, actionable error when
 * none resolve (no user-specific absolute path is baked into committed code).
 */
function resolveTool(bin: string, envVar: string, fallbacks: string[]): string {
  const fromEnv = process.env[envVar];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const onPath = Bun.which(bin);
  if (onPath) return onPath;
  for (const f of fallbacks) if (existsSync(f)) return f;
  throw new Error(
    `[mirin] "${bin}" not found — install it and put it on PATH, or set $${envVar} ` +
      `to its absolute path.`,
  );
}

/** `~/.local/share/gem/ruby/<ver>/bin` (RubyGems user install dir), if resolvable. */
function gemUserBin(): string | undefined {
  const ruby = Bun.which("ruby");
  if (!ruby) return undefined;
  try {
    const dir = Bun.spawnSync([ruby, "-e", "print Gem.user_dir"]).stdout.toString().trim();
    return dir ? join(dir, "bin") : undefined;
  } catch {
    return undefined;
  }
}

function resolveFpm(): string {
  const fallbacks: string[] = [];
  const gemBin = gemUserBin();
  if (gemBin) fallbacks.push(join(gemBin, "fpm"));
  return resolveTool("fpm", "MIRIN_FPM", fallbacks);
}

function resolveAppimagetool(): string {
  return resolveTool("appimagetool", "MIRIN_APPIMAGETOOL", [
    join(homedir(), ".local", "bin", "appimagetool"),
  ]);
}

/** A Debian/RPM-friendly package name: lowercase, alnum + `.-+`, no leading sigil. */
function shortName(input: string): string {
  return (
    input.toLowerCase().replace(/[^a-z0-9.\-+]/g, "-").replace(/^[.\-+]+/, "") || "app"
  );
}

const size = (p: string) => statSync(p).size;

/** Build every requested Linux package; returns each artifact's path + size. */
export async function buildLinuxPackages(
  input: LinuxPackageInput,
): Promise<LinuxPackageResult[]> {
  mkdirSync(input.outDir, { recursive: true });
  const binName = input.options.binName ?? shortName(input.bundleId.split(".").pop() ?? input.appName);
  const results: LinuxPackageResult[] = [];

  // deb + rpm share one staged filesystem tree (payload under /opt, launcher,
  // .desktop, icon). Build it once and reuse.
  const needFsTree = input.formats.includes("deb") || input.formats.includes("rpm");
  let fsRoot: string | undefined;
  try {
    if (needFsTree) fsRoot = stageFsTree(input, binName);
    if (input.formats.includes("deb")) results.push(await buildFpm(input, binName, fsRoot!, "deb"));
    if (input.formats.includes("rpm")) results.push(await buildFpm(input, binName, fsRoot!, "rpm"));
    if (input.formats.includes("appimage")) results.push(await buildAppImage(input, binName));
  } finally {
    if (fsRoot) rmSync(fsRoot, { recursive: true, force: true });
  }
  return results;
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
      ? input.options.debDepends ?? DEFAULT_DEB_DEPENDS
      : input.options.rpmDepends ?? DEFAULT_RPM_DEPENDS;

  const args: string[] = [
    "-s", "dir",
    "-t", kind,
    "-C", fsRoot,
    "--package", out,
    "--name", binName,
    "--version", input.version,
    "--iteration", "1",
    "--architecture", arch,
    "--maintainer", input.options.maintainer ?? input.publisher,
    "--vendor", input.publisher,
    "--description", input.options.description ?? input.appName,
  ];
  if (input.options.homepage) args.push("--url", input.options.homepage);
  if (input.options.license) args.push("--license", input.options.license);
  for (const d of depends) args.push("--depends", d);
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
  if (override && override.length) return override;
  const fromConfig = typeof linux === "object" ? linux.formats : undefined;
  return fromConfig && fromConfig.length ? fromConfig : ["appimage", "deb", "rpm"];
}
