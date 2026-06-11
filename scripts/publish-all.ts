#!/usr/bin/env bun
/**
 * Publish the mirin packages to the registry in dependency order. `bun publish` rewrites
 * `workspace:*` deps to the concrete version. Run from CI (release.yml) with
 * ~/.npmrc auth in place, or locally with ~/.npmrc auth in place.
 *
 * `@mirinjs/darwin-arm64` must already contain its prebuilt binaries (CI stages
 * them; see release.yml).
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
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
  await $`bun publish`.cwd(pkgDir);
}

console.log("\n✓ all packages published");
