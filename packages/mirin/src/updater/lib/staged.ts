import { chmodSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { VersionInfo } from "../types.ts";
import { MAX_ARCHIVE_ENTRIES } from "./limits.ts";
import { readVersionJsonFile } from "./version.ts";

export type UpdatePlatform = "darwin" | "linux" | "win32";

interface StagedValidationOptions {
  staged: string;
  extractionRoot: string;
  platform: UpdatePlatform;
  installed: VersionInfo;
  expectedVersion: string;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function regularFile(path: string, label: string): void {
  const link = lstatSync(path);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error(`${label} is not a regular file`);
}

function validateExtractedTree(root: string): void {
  const directories = [root];
  let entries = 0;
  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) break;
    for (const name of readdirSync(directory)) {
      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES) throw new Error("staged update has too many entries");
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        const target = realpathSync(path);
        if (!isWithin(root, target))
          throw new Error(`staged update symlink escapes the bundle: ${path}`);
      } else if (metadata.isDirectory()) {
        directories.push(path);
      } else if (!metadata.isFile()) {
        throw new Error(`staged update contains a special file: ${path}`);
      }
    }
  }
}

export function validateStagedBundle(options: StagedValidationOptions): VersionInfo {
  const extractionRoot = realpathSync(options.extractionRoot);
  const rootLink = lstatSync(options.staged);
  if (rootLink.isSymbolicLink() || !rootLink.isDirectory()) {
    throw new Error("staged update root is not a real directory");
  }
  const staged = realpathSync(options.staged);
  if (!isWithin(extractionRoot, staged) || staged === extractionRoot) {
    throw new Error("staged update root escapes its extraction directory");
  }
  validateExtractedTree(staged);

  const resources =
    options.platform === "darwin"
      ? join(staged, "Contents", "Resources")
      : join(staged, "resources");
  const executable =
    options.platform === "darwin"
      ? join(staged, "Contents", "MacOS", options.installed.name)
      : join(
          staged,
          options.platform === "win32" ? `${options.installed.name}.exe` : options.installed.name,
        );
  const versionPath = join(resources, "version.json");
  regularFile(executable, "staged update executable");
  regularFile(versionPath, "staged update version metadata");

  const realExecutable = realpathSync(executable);
  const realVersion = realpathSync(versionPath);
  if (!isWithin(staged, realExecutable) || !isWithin(staged, realVersion)) {
    throw new Error("staged update identity files escape the bundle");
  }
  const executableMode = statSync(executable).mode;
  if (options.platform === "linux") {
    if ((executableMode & 0o100) === 0) chmodSync(executable, executableMode | 0o100);
    if ((statSync(executable).mode & 0o100) === 0) {
      throw new Error("staged update executable is not owner-executable");
    }
  } else if (options.platform === "darwin" && (executableMode & 0o111) === 0) {
    throw new Error("staged update executable is not executable");
  }

  const stagedVersion = readVersionJsonFile(versionPath);
  if (
    stagedVersion.version !== options.expectedVersion ||
    stagedVersion.name !== options.installed.name ||
    stagedVersion.identifier !== options.installed.identifier ||
    stagedVersion.channel !== options.installed.channel
  ) {
    throw new Error("staged update identity does not match the pending update");
  }
  return stagedVersion;
}
