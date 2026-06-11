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
 * Alpha supports macOS arm64 only.
 */

import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_SLUG = "Netko-Labs/mirin";

const CLI_DIR = import.meta.dir;
const REPO_ROOT = resolve(CLI_DIR, "..", "..", "..");
const IN_REPO = existsSync(join(REPO_ROOT, "crates", "mirin-core"));

export interface Artifacts {
  /** libmirin_core.dylib — dlopened by the host. */
  coreDylib: string;
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

export async function resolveArtifacts(opts: { release: boolean }): Promise<Artifacts> {
  assertSupportedPlatform();
  const cefPath = await ensureCef();

  if (IN_REPO) {
    const profile = opts.release ? "release" : "debug";
    console.log(`[mirin] building native core + helper (${profile})…`);
    const flags = opts.release ? ["--release"] : [];
    await $`cargo build -p mirin-core -p mirin-helper ${flags}`.cwd(REPO_ROOT);
    const target = join(REPO_ROOT, "target", profile);
    return {
      coreDylib: join(target, "libmirin_core.dylib"),
      helperBin: join(target, "mirin-helper"),
      hostEntry: join(REPO_ROOT, "packages", "mirin", "src", "host.ts"),
      cefPath,
    };
  }

  const nativeDir = resolveNativeDir();
  return {
    coreDylib: join(nativeDir, "libmirin_core.dylib"),
    helperBin: join(nativeDir, "mirin-helper"),
    hostEntry: resolvePackageFile("mirinjs/host"),
    cefPath,
  };
}

function assertSupportedPlatform(): void {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(
      `mirin alpha supports macOS arm64 only (got ${process.platform}/${process.arch}).`,
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
        `(it is an optional dependency of @mirinjs/cli for your platform).`,
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

async function ensureCef(): Promise<string> {
  if (IN_REPO) {
    const vendor = join(REPO_ROOT, "vendor", "cef");
    if (existsSync(join(vendor, "Chromium Embedded Framework.framework"))) return vendor;
    console.error(
      "[mirin] vendor/cef missing — run `bun scripts/fetch-cef.ts` in the monorepo first.",
    );
    return vendor;
  }

  const version = cliVersion();
  const cacheDir = join(homedir(), ".mirinjs", "cef", `${version}-${platformTag()}`);
  if (existsSync(join(cacheDir, "Chromium Embedded Framework.framework"))) return cacheDir;

  mkdirSync(cacheDir, { recursive: true });
  const asset = `cef-${platformTag()}.tar.gz`;
  const url = `https://github.com/${REPO_SLUG}/releases/download/v${version}/${asset}`;
  console.log(`[mirin] downloading CEF for ${platformTag()} (one-time, ~hundreds of MB)…`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`mirin: failed to download CEF from ${url} (HTTP ${res.status}).`);
  }
  const archive = join(tmpdir(), asset);
  await Bun.write(archive, res);
  await $`tar -xzf ${archive} -C ${cacheDir}`;
  rmSync(archive, { force: true });
  return cacheDir;
}
