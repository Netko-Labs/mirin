#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { distTagForVersion } from "./lib/dist-tag.ts";

const ROOT = join(import.meta.dir, "..");
const inputArgument = Bun.argv[2];
if (!inputArgument) throw new Error("usage: bun scripts/publish-packed.ts <package-directory>");

const inputDirectory = resolve(inputArgument);
const packageDirectories = [
  "native-darwin-arm64",
  "native-win32-x64",
  "native-linux-x64",
  "create-mirin",
  "mirin",
  "mirin-cli",
];
const requiredNativeFiles: Record<string, string[]> = {
  "native-darwin-arm64": ["libmirin_core.dylib", "mirin-helper"],
  "native-win32-x64": ["mirin_core.dll", "mirin-helper.exe"],
  "native-linux-x64": ["libmirin_core.so", "mirin-helper"],
};

const packages: Array<{ archive: string; name: string; version: string }> = [];
for (const directory of packageDirectories) {
  const archive = join(inputDirectory, `${directory}.tgz`);
  if (!existsSync(archive)) throw new Error(`release package missing: ${archive}`);
  const expected = packageIdentity(
    readFileSync(join(ROOT, "packages", directory, "package.json"), "utf8"),
    `${directory} source manifest`,
  );
  const packed = packageIdentity(
    await $`tar -xOzf ${archive} package/package.json`.quiet().text(),
    `${directory} packed manifest`,
  );
  if (packed.name !== expected.name || packed.version !== expected.version) {
    throw new Error(
      `${directory}: packed ${packed.name}@${packed.version} does not match ` +
        `${expected.name}@${expected.version}`,
    );
  }
  const entries = new Set(
    (await $`tar -tzf ${archive}`.quiet().text()).split(/\r?\n/).filter(Boolean),
  );
  for (const required of requiredNativeFiles[directory] ?? []) {
    if (!entries.has(`package/${required}`)) {
      throw new Error(`${directory}: packed native binary missing (${required})`);
    }
  }
  packages.push({ archive, ...expected });
}

const versions = new Set(packages.map(({ version }) => version));
if (versions.size !== 1) throw new Error("release package versions are not synchronized");
if (process.env.MIRIN_PUBLISH_VALIDATE_ONLY === "1") {
  console.log(`validated ${packages.length} packed packages at ${packages[0]?.version}`);
  process.exit(0);
}

for (const releasePackage of packages) {
  const specifier = `${releasePackage.name}@${releasePackage.version}`;
  const distTag = distTagForVersion(releasePackage.version);
  console.log(`publishing ${specifier} with registry tag ${distTag}`);
  await $`bun publish ${releasePackage.archive} --access public --tag ${distTag} --tolerate-republish`;
}

function packageIdentity(source: string, label: string): { name: string; version: string } {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object") throw new Error(`${label} is not an object`);
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.version !== "string") {
    throw new Error(`${label} is missing name or version`);
  }
  return { name: record.name, version: record.version };
}
