/**
 * Resolve the native toolchain the CLI needs (core dylib, helper, host entry,
 * CEF framework) in two modes:
 *
 *  - **in-repo** (this CLI is running inside the mirin monorepo): build the Rust
 *    crates from source and use `vendor/cef`. For contributors.
 *  - **installed** (a consumer ran `bun add -d @mirinjs/cli`): use the prebuilt
 *    binaries from the per-platform `mirinjs-<os>-<arch>` package, the `host`
 *    entry from the `mirin` package, and a CEF framework downloaded once from
 *    the matching GitHub Release into `~/.mirinjs/cef/<version>`. No Rust needed.
 *
 * Alpha supports macOS arm64, Windows x64/arm64, and Linux x64/arm64.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { $ } from "bun";
import { createReporter, type Reporter } from "./shared/report.ts";

const REPO_SLUG = "Netko-Labs/mirin";

const CLI_DIR = import.meta.dir;
const REPO_ROOT = resolve(CLI_DIR, "..", "..", "..");
const IN_REPO = existsSync(join(REPO_ROOT, "crates", "mirin-core"));

export interface Artifacts {
  /** libmirin_core.dylib — dlopened by the host. */
  coreDylib: string;
  /** Standalone updater codec used by `mirin release`. */
  codecBin: string;
  /** mirin-helper — the CEF subprocess binary. */
  helperBin: string;
  /** host entry (TS/JS) compiled with `bun build --compile`. */
  hostEntry: string;
  /** Directory containing "Chromium Embedded Framework.framework". */
  cefPath: string;
}

export function isInRepo(): boolean {
  return IN_REPO;
}

/** The in-repo CEF distribution. `present` checks the framework marker, not just
 *  the directory: an interrupted `fetch-cef.ts` leaves an empty one behind. */
export function vendoredCef(): { path: string; present: boolean } {
  const path = join(REPO_ROOT, "vendor", "cef");
  return { path, present: existsSync(join(path, cefMarker())) };
}

export async function resolveArtifacts(opts: {
  release: boolean;
  /** Where build chatter goes. Defaults to human mode, which prints it. */
  reporter?: Reporter;
}): Promise<Artifacts> {
  assertSupportedPlatform();
  const reporter = opts.reporter ?? createReporter(false);
  const cefPath = await ensureCef(reporter);

  if (IN_REPO) {
    const profile = opts.release ? "release" : "debug";
    reporter.info(`[mirin] building native core + helpers (${profile})…`);
    const flags = opts.release ? ["--release"] : [];
    await reporter.build(
      $`cargo build -p mirin-codec -p mirin-core -p mirin-helper ${flags}`.cwd(REPO_ROOT),
    );
    const target = join(REPO_ROOT, "target", profile);
    return {
      coreDylib: join(target, coreFileName()),
      codecBin: join(target, codecFileName()),
      helperBin: join(target, helperFileName()),
      hostEntry: join(REPO_ROOT, "packages", "mirin", "src", "host.ts"),
      cefPath,
    };
  }

  const nativeDir = resolveNativeDir();
  return {
    coreDylib: join(nativeDir, coreFileName()),
    codecBin: join(nativeDir, codecFileName()),
    helperBin: join(nativeDir, helperFileName()),
    hostEntry: resolvePackageFile("mirinjs/host"),
    cefPath,
  };
}

/** The native core library file name for the host platform (MSVC has no `lib` prefix). */
function coreFileName(): string {
  if (process.platform === "win32") return "mirin_core.dll";
  if (process.platform === "linux") return "libmirin_core.so";
  return "libmirin_core.dylib";
}

/** The CEF subprocess binary name for the host platform. */
function helperFileName(): string {
  return process.platform === "win32" ? "mirin-helper.exe" : "mirin-helper";
}

function codecFileName(): string {
  return process.platform === "win32" ? "mirin-codec.exe" : "mirin-codec";
}

function assertSupportedPlatform(): void {
  const supported =
    (process.platform === "darwin" && process.arch === "arm64") ||
    (process.platform === "win32" && (process.arch === "x64" || process.arch === "arm64")) ||
    (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64"));
  if (!supported) {
    throw new Error(
      "mirin alpha supports macOS arm64, Windows x64/arm64, and Linux x64/arm64 " +
        `(got ${process.platform}/${process.arch}).`,
    );
  }
}

function platformTag(): string {
  return `${process.platform}-${process.arch}`; // e.g. "darwin-arm64"
}

function resolveNativeDir(): string {
  const pkg = `@mirinjs/${platformTag()}`;
  try {
    return dirname(resolvePackageFile(`${pkg}/package.json`));
  } catch {
    throw new Error(
      `mirin: prebuilt native package "${pkg}" is not installed. Run \`bun install\` ` +
        "(it is an optional dependency of @mirinjs/cli for your platform).",
    );
  }
}

function resolvePackageFile(specifier: string): string {
  return Bun.resolveSync(specifier, process.cwd());
}

/** The CLI's own version, used to pick the matching CEF release asset. */
function cliVersion(): string {
  const pkg = JSON.parse(readFileSync(join(CLI_DIR, "..", "package.json"), "utf8"));
  return pkg.version as string;
}

/** A file/dir that, if present in a CEF dir, means the distribution is unpacked.
 *  macOS ships the framework bundle; Windows ships a flat dir with libcef.dll;
 *  Linux ships a flat dir with libcef.so. */
function cefMarker(): string {
  if (process.platform === "win32") return "libcef.dll";
  if (process.platform === "linux") return "libcef.so";
  return "Chromium Embedded Framework.framework";
}

async function ensureCef(reporter: Reporter): Promise<string> {
  if (IN_REPO) {
    const vendor = vendoredCef();
    if (vendor.present) return vendor.path;
    console.error(
      "[mirin] vendor/cef missing — run `bun scripts/fetch-cef.ts` in the monorepo first.",
    );
    return vendor.path;
  }

  const version = cliVersion();
  const cacheRoot = join(homedir(), ".mirinjs", "cef");
  const cacheDir = join(cacheRoot, `${version}-${platformTag()}`);
  if (existsSync(join(cacheDir, cefMarker()))) return cacheDir;

  mkdirSync(cacheRoot, { recursive: true });
  const asset = `cef-${platformTag()}.tar.gz`;
  const url = `https://github.com/${REPO_SLUG}/releases/download/v${version}/${asset}`;
  reporter.info(`[mirin] downloading CEF for ${platformTag()} (one-time, ~hundreds of MB)…`);

  // Download with curl, not `Bun.write(file, await fetch(url))`: the latter
  // pins a core at 100% CPU and never completes on large gzip responses
  // (the streaming write path). curl is fast and ubiquitous.
  const downloadDir = mkdtempSync(join(tmpdir(), "mirin-cef-download-"));
  const stagingDir = mkdtempSync(join(cacheRoot, ".staging-"));
  const archive = join(downloadDir, asset);
  const checksum = `${archive}.sha256`;
  const checksumUrl = `${url}.sha256`;
  const httpsOnly = "=https";
  try {
    await $`curl --fail --show-error --location --retry 3 --proto ${httpsOnly} --proto-redir ${httpsOnly} -o ${checksum} ${checksumUrl}`;
    await $`curl --fail --show-error --location --retry 3 --proto ${httpsOnly} --proto-redir ${httpsOnly} -o ${archive} ${url}`;
    await verifyFileSha256(archive, readFileSync(checksum, "utf8"));
    const listing = await $`tar -tzf ${archive}`.quiet().text();
    validateArchiveEntries(listing);
    await $`tar -xzf ${archive} -C ${stagingDir}`;
    validateExtractedSymlinks(stagingDir);
    if (!existsSync(join(stagingDir, cefMarker()))) {
      throw new Error(`CEF archive is missing ${cefMarker()}`);
    }

    // Another process may have populated the cache while this one downloaded.
    if (existsSync(join(cacheDir, cefMarker()))) return cacheDir;
    rmSync(cacheDir, { recursive: true, force: true });
    renameSync(stagingDir, cacheDir);
  } catch (err) {
    throw new Error(`mirin: failed to download CEF from ${url} (${err}).`);
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
  return cacheDir;
}

/** Reject absolute paths and parent traversal before a downloaded tar is extracted. */
export function validateArchiveEntries(listing: string): void {
  for (const rawEntry of listing.split(/\r?\n/)) {
    if (rawEntry.length === 0) continue;
    const entry = archivePath(rawEntry);
    if (entry == null) throw new Error(`unsafe CEF archive entry: ${rawEntry}`);
  }
}

/** Verify a downloaded release asset before parsing or extracting it. */
export async function verifyFileSha256(path: string, checksum: string): Promise<void> {
  const expected = checksum.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error("invalid CEF SHA-256 checksum");
  }

  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }
  const actual = hasher.digest("hex");
  if (actual !== expected) {
    throw new Error(`CEF SHA-256 mismatch (expected ${expected}, got ${actual})`);
  }
}

/** Reject extracted symlinks whose lexical target escapes the staging directory. */
export function validateExtractedSymlinks(root: string): void {
  const absoluteRoot = resolve(root);
  const pending = [absoluteRoot];

  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(path);
        const resolvedTarget = resolve(dirname(path), target);
        const fromRoot = relative(absoluteRoot, resolvedTarget);
        if (
          isAbsolute(target) ||
          fromRoot === ".." ||
          fromRoot.startsWith(`..${sep}`) ||
          isAbsolute(fromRoot)
        ) {
          throw new Error(`CEF archive symlink escapes its cache: ${path} -> ${target}`);
        }
      } else if (entry.isDirectory()) {
        pending.push(path);
      }
    }
  }
}

function archivePath(raw: string): string | null {
  let path = raw.replaceAll("\\", "/");
  while (path.startsWith("./")) path = path.slice(2);
  if (path.length === 0 || path === ".") return "";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || hasControlCharacter(path)) {
    return null;
  }

  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : "";
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
