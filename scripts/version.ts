#!/usr/bin/env bun
/**
 * Set the version across every mirin package and the Cargo workspace so a tag
 * and the published packages always agree.
 *
 *   bun scripts/version.ts 0.0.1-alpha.1
 *   git commit -am "v0.0.1-alpha.1" && git tag v0.0.1-alpha.1 && git push --tags
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { distTagForVersion } from "./lib/dist-tag.ts";

const version = Bun.argv[2];
if (!isSupportedVersion(version)) {
  console.error("usage: bun scripts/version.ts <semver>  (e.g. 0.0.1-alpha.1)");
  process.exit(1);
}

function isSupportedVersion(value: string | undefined): value is string {
  if (!value) return false;
  try {
    distTagForVersion(value);
    return true;
  } catch {
    return false;
  }
}

const ROOT = join(import.meta.dir, "..");
const PACKAGES = [
  "mirin",
  "mirin-cli",
  "native-darwin-arm64",
  "native-win32-x64",
  "native-linux-x64",
  "create-mirin",
];
const previousVersions = new Set<string>();

for (const dir of PACKAGES) {
  const file = join(ROOT, "packages", dir, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (typeof pkg.version === "string") previousVersions.add(pkg.version);
  pkg.version = version;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`packages/${dir} → ${version}`);
}

// Cargo workspace version (single source for both crates).
const cargoPath = join(ROOT, "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8").replace(
  /(\[workspace\.package\][^[]*?version\s*=\s*)"[^"]+"/,
  `$1"${version}"`,
);
writeFileSync(cargoPath, cargo);
console.log(`Cargo.toml [workspace.package] → ${version}`);

// Sync inter-package dependency versions to CONCRETE versions (never
// `workspace:*`). bun pm pack rewrites `workspace:*` to the stale lockfile
// version at publish time, which skews e.g. @mirinjs/cli's @mirinjs/darwin-arm64
// pin from the runtime — so we keep real versions here and bump them in lockstep.
//   - published packages (@mirinjs/cli → create-mirinjs / @mirinjs/darwin-arm64):
//     EXACT pin, so the prebuilt dylib can never drift from the runtime.
//   - in-repo examples: `^<version>` so they read as copyable real apps; the
//     monorepo install still links them to local source for development.
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
const isMirinDep = (dep: string) =>
  dep === "mirinjs" || dep === "create-mirinjs" || dep.startsWith("@mirinjs/");

function syncDeps(baseDir: string, label: string, range: string) {
  for (const name of readdirSync(baseDir)) {
    const file = join(baseDir, name, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    let changed = false;
    for (const field of DEP_FIELDS) {
      for (const dep of Object.keys(pkg[field] ?? {})) {
        if (isMirinDep(dep)) {
          pkg[field][dep] = range;
          changed = true;
        }
      }
    }
    if (changed) {
      writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
      console.log(`${label}/${name} → mirin deps ${range}`);
    }
  }
}

syncDeps(join(ROOT, "packages"), "packages", version);
syncDeps(join(ROOT, "examples"), "examples", `^${version}`);

// Bun currently leaves workspace package versions stale when only manifests
// change. Keep exact previous-version values synchronized without touching
// registry dependency resolutions elsewhere in the generated lockfile.
const bunLockPath = join(ROOT, "bun.lock");
let bunLock = readFileSync(bunLockPath, "utf8");
Bun.JSONC.parse(bunLock);
for (const previous of previousVersions) {
  bunLock = bunLock.replaceAll(`"${previous}"`, `"${version}"`);
}
Bun.JSONC.parse(bunLock);
writeFileSync(bunLockPath, bunLock);
console.log(`bun.lock workspace versions → ${version}`);

console.log(
  `\nNext: git commit -am "v${version}" && git tag v${version} && git push --follow-tags`,
);
