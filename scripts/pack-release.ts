#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");
const outputArgument = Bun.argv[2];
if (!outputArgument) throw new Error("usage: bun scripts/pack-release.ts <output-directory>");

const outputDirectory = resolve(outputArgument);
const nativeArch = process.env.MIRIN_PACK_NATIVE_ARCH ?? process.arch;
if (!/^(arm64|x64)$/.test(nativeArch)) {
  throw new Error(`invalid MIRIN_PACK_NATIVE_ARCH: ${nativeArch}`);
}
const nativePackage = `native-${process.platform}-${nativeArch}`;
const nativeOnly = process.env.MIRIN_PACK_NATIVE_ONLY === "1";
const packages = nativeOnly
  ? [nativePackage]
  : [nativePackage, "create-mirin", "mirin", "mirin-cli"];

const nativeFiles =
  process.platform === "win32"
    ? ["mirin_core.dll", "mirin-codec.exe", "mirin-helper.exe"]
    : process.platform === "linux"
      ? ["libmirin_core.so", "mirin-codec", "mirin-helper"]
      : ["libmirin_core.dylib", "mirin-codec", "mirin-helper"];

for (const file of nativeFiles) {
  const path = join(ROOT, "packages", nativePackage, file);
  if (!existsSync(path)) throw new Error(`${nativePackage}: staged binary missing (${path})`);
}

mkdirSync(outputDirectory, { recursive: true });
for (const directory of packages) {
  const packageDirectory = join(ROOT, "packages", directory);
  const packageJson = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as {
    version: string;
  };
  const filename = `${directory}.tgz`;
  const destination = join(outputDirectory, filename);
  rmSync(destination, { force: true });
  console.log(`packing ${directory}@${packageJson.version} -> ${filename}`);
  await $`bun pm pack --filename ${destination} --quiet`.cwd(packageDirectory);
}
