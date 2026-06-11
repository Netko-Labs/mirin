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
 * Run from CI (release.yml) or locally with `~/.npmrc` auth in place.
 * `@mirinjs/darwin-arm64` must already contain its prebuilt binaries (CI stages
 * them; see release.yml).
 */

import { $ } from "bun";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// Dependency order: native + create first, then runtime, then the CLI.
const PACKAGES = ["native-darwin-arm64", "create-mirin", "mirin", "mirin-cli"];

for (const dir of PACKAGES) {
  const pkgDir = join(ROOT, "packages", dir);

  if (dir === "native-darwin-arm64") {
    const dylib = join(pkgDir, "libmirin_core.dylib");
    if (!existsSync(dylib)) {
      throw new Error(`${dir}: prebuilt binaries missing (${dylib}) — build them first.`);
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
