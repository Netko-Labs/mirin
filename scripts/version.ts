#!/usr/bin/env bun
/**
 * Set the version across every mirin package and the Cargo workspace so a tag
 * and the published packages always agree.
 *
 *   bun scripts/version.ts 0.0.1-alpha.1
 *   git commit -am "v0.0.1-alpha.1" && git tag v0.0.1-alpha.1 && git push --tags
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const version = Bun.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("usage: bun scripts/version.ts <semver>  (e.g. 0.0.1-alpha.1)");
  process.exit(1);
}

const ROOT = join(import.meta.dir, "..");
const PACKAGES = ["mirin", "mirin-cli", "native-darwin-arm64", "create-mirin"];

for (const dir of PACKAGES) {
  const file = join(ROOT, "packages", dir, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.version = version;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`packages/${dir} → ${version}`);
}

// Cargo workspace version (single source for both crates).
const cargoPath = join(ROOT, "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8").replace(
  /(\[workspace\.package\][^\[]*?version\s*=\s*)"[^"]+"/,
  `$1"${version}"`,
);
writeFileSync(cargoPath, cargo);
console.log(`Cargo.toml [workspace.package] → ${version}`);

// Keep the in-repo examples in sync. They depend on the published packages
// (`^<version>`) rather than `workspace:*`, so they stay copyable as real apps;
// the monorepo install still links them to local source for development.
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
const examplesDir = join(ROOT, "examples");
for (const name of readdirSync(examplesDir)) {
  const file = join(examplesDir, name, "package.json");
  if (!existsSync(file)) continue;
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  let changed = false;
  for (const field of DEP_FIELDS) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (dep === "mirinjs" || dep.startsWith("@mirinjs/")) {
        pkg[field][dep] = `^${version}`;
        changed = true;
      }
    }
  }
  if (changed) {
    writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`examples/${name} → mirin deps ^${version}`);
  }
}

console.log(`\nNext: git commit -am "v${version}" && git tag v${version} && git push --follow-tags`);
