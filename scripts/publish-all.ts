#!/usr/bin/env bun

/**
 * Publish the mirin packages to the registry in dependency order.
 *
 * We pack with `bun pm pack` (it rewrites `workspace:*` deps to the concrete
 * version and respects each package's file list), then publish the resulting
 * tarball with `bun publish`. CI passes registry auth through NPM_CONFIG_TOKEN.
 *
 * This is the local/emergency single-platform publisher. The release workflow
 * uses pack-release.ts + publish-packed.ts so all platforms gate the shared
 * packages. The current platform's native package must already be staged.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { distTagForVersion } from "./lib/dist-tag.ts";

const ROOT = join(import.meta.dir, "..");

// The prebuilt-native package for the host platform (one per OS/arch runner).
const NATIVE_PKG = `native-${process.platform}-${process.arch}`;
const NATIVE_FILES =
  process.platform === "win32"
    ? ["mirin_core.dll", "mirin-codec.exe", "mirin-helper.exe"]
    : process.platform === "linux"
      ? ["libmirin_core.so", "mirin-codec", "mirin-helper"]
      : ["libmirin_core.dylib", "mirin-codec", "mirin-helper"];

// The shared packages (runtime + CLI + scaffolder) are platform-agnostic and must
// be published exactly once. The primary release runner (macOS) publishes them with
// its native package; secondary runners (Windows/Linux) set
// MIRIN_PUBLISH_NATIVE_ONLY=1 to publish only their prebuilt-native package.
const NATIVE_ONLY = process.env.MIRIN_PUBLISH_NATIVE_ONLY === "1";

// Dependency order: native + create first, then runtime, then the CLI.
const PACKAGES = NATIVE_ONLY ? [NATIVE_PKG] : [NATIVE_PKG, "create-mirin", "mirin", "mirin-cli"];

for (const dir of PACKAGES) {
  const pkgDir = join(ROOT, "packages", dir);

  if (dir === NATIVE_PKG) {
    for (const filename of NATIVE_FILES) {
      const binary = join(pkgDir, filename);
      if (!existsSync(binary)) {
        throw new Error(`${dir}: prebuilt binary missing (${binary}) — build it first.`);
      }
    }
  }

  console.log(`\n=== publishing packages/${dir} ===`);

  // Clear any stale tarball, pack with Bun (rewrites workspace:* deps), then
  // publish that exact tarball without packing it a second time.
  for (const f of readdirSync(pkgDir)) {
    if (f.endsWith(".tgz")) rmSync(join(pkgDir, f));
  }
  await $`bun pm pack`.cwd(pkgDir);
  const tarball = readdirSync(pkgDir).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error(`${dir}: bun pm pack produced no tarball`);

  const packageJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    version: string;
  };
  const distTag = distTagForVersion(packageJson.version);
  console.log(`publishing ${packageJson.version} with registry tag ${distTag}`);
  await $`bun publish ${tarball} --access public --tag ${distTag} --tolerate-republish`.cwd(pkgDir);
  rmSync(join(pkgDir, tarball));
}

console.log("\n✓ all packages published");
