#!/usr/bin/env bun
/**
 * Publish the mirin packages to the registry in dependency order.
 *
 * We pack with `bun pm pack` (it rewrites `workspace:*` deps to the concrete
 * version and respects each package's file list), then publish the resulting
 * tarball with `npm publish`. We deliberately do NOT use `bun publish`: it fails
 * to read `~/.npmrc` auth in GitHub Actions (oven-sh/bun#24124), surfacing as a
 * misleading `404 … does not exist in this registry`. `npm` reads the same
 * `~/.npmrc` correctly.
 *
 * Run from CI (release.yml) or locally with `~/.npmrc` auth in place. The native
 * package for the *current* platform (`native-darwin-arm64` / `native-win32-x64`)
 * must already contain its prebuilt binaries (each OS's CI runner stages its own).
 */

import { $ } from "bun";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// The prebuilt-native package for the host platform (one per OS/arch runner).
const NATIVE_PKG = `native-${process.platform}-${process.arch}`;
const NATIVE_CORE =
  process.platform === "win32"
    ? "mirin_core.dll"
    : process.platform === "linux"
      ? "libmirin_core.so"
      : "libmirin_core.dylib";

// The shared packages (runtime + CLI + scaffolder) are platform-agnostic and must
// be published exactly once. The primary release runner (macOS) publishes them with
// its native package; secondary runners (Windows) set MIRIN_PUBLISH_NATIVE_ONLY=1 to
// publish only their prebuilt-native package.
const NATIVE_ONLY = process.env.MIRIN_PUBLISH_NATIVE_ONLY === "1";

// Dependency order: native + create first, then runtime, then the CLI.
const PACKAGES = NATIVE_ONLY ? [NATIVE_PKG] : [NATIVE_PKG, "create-mirin", "mirin", "mirin-cli"];

for (const dir of PACKAGES) {
  const pkgDir = join(ROOT, "packages", dir);

  if (dir === NATIVE_PKG) {
    const core = join(pkgDir, NATIVE_CORE);
    if (!existsSync(core)) {
      throw new Error(`${dir}: prebuilt binaries missing (${core}) — build them first.`);
    }
  }

  console.log(`\n=== publishing packages/${dir} ===`);

  // Clear any stale tarball, pack with bun (rewrites workspace:* deps), then
  // publish the tarball with npm (reliable ~/.npmrc auth in CI).
  for (const f of readdirSync(pkgDir)) {
    if (f.endsWith(".tgz")) rmSync(join(pkgDir, f));
  }
  await $`bun pm pack`.cwd(pkgDir);
  const tarball = readdirSync(pkgDir).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error(`${dir}: bun pm pack produced no tarball`);

  await $`npm publish ${tarball} --access public`.cwd(pkgDir);
  rmSync(join(pkgDir, tarball));
}

console.log("\n✓ all packages published");
