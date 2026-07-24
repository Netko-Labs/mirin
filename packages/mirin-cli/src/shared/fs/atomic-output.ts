import { randomUUID } from "node:crypto";
import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { safeDestructiveDirectory } from "./project-source.ts";

const STALE_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;

/** Cleanup after a committed swap must never turn that successful commit into a failure. */
export function removeAtomicOutputDirectoryBestEffort(
  directory: string,
  label: string,
  remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true }),
  warn: (message: string) => void = console.warn,
): boolean {
  try {
    remove(directory);
    return true;
  } catch (error) {
    warn(
      `[mirin] could not remove ${label} at ${directory}: ${
        error instanceof Error ? error.message : error
      }`,
    );
    return false;
  }
}

/**
 * A crashed or cleanup-constrained successful run can leave its old output as a
 * backup. Later runs prune only aged real directories while a canonical output
 * exists, avoiding live rollback state and never following symlinks.
 */
export function pruneStaleAtomicOutputBackups(
  projectRoot: string,
  destination: string,
  label: string,
  now = Date.now(),
): void {
  const finalDirectory = safeDestructiveDirectory(projectRoot, destination, label);
  if (!existsSync(finalDirectory)) return;

  const parent = dirname(finalDirectory);
  const prefix = `.${basename(finalDirectory)}.mirin-backup-`;
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(parent, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    console.warn(
      `[mirin] could not scan stale ${label} backups: ${
        error instanceof Error ? error.message : error
      }`,
    );
    return;
  }

  for (const entry of entries) {
    if (!entry.name.startsWith(prefix) || !entry.isDirectory()) continue;
    const candidate = join(parent, entry.name);
    try {
      const metadata = lstatSync(candidate);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        now - metadata.mtimeMs < STALE_BACKUP_AGE_MS
      ) {
        continue;
      }
      const backup = safeDestructiveDirectory(
        projectRoot,
        candidate,
        `${label} stale backup directory`,
      );
      removeAtomicOutputDirectoryBestEffort(backup, `${label} stale backup directory`);
    } catch (error) {
      console.warn(
        `[mirin] could not validate stale ${label} backup at ${candidate}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
}

/**
 * Assemble a directory beside its final destination, then replace the previous
 * output only after assembly succeeds. The sibling rename keeps the final swap
 * on one filesystem and lets a failed build restore the previous output.
 */
export async function writeAtomicOutputDirectory<T>(
  projectRoot: string,
  destination: string,
  label: string,
  write: (staging: string) => Promise<T> | T,
): Promise<T> {
  const finalDirectory = safeDestructiveDirectory(projectRoot, destination, label);
  const parent = dirname(finalDirectory);
  mkdirSync(parent, { recursive: true });
  pruneStaleAtomicOutputBackups(projectRoot, finalDirectory, label);

  const staging = safeDestructiveDirectory(
    projectRoot,
    mkdtempSync(join(parent, `.${basename(finalDirectory)}.mirin-stage-`)),
    `${label} staging directory`,
  );
  let backup: string | undefined;

  try {
    const result = await write(staging);
    safeDestructiveDirectory(projectRoot, staging, `${label} staging directory`);
    safeDestructiveDirectory(projectRoot, finalDirectory, label);

    if (existsSync(finalDirectory)) {
      backup = safeDestructiveDirectory(
        projectRoot,
        join(parent, `.${basename(finalDirectory)}.mirin-backup-${process.pid}-${randomUUID()}`),
        `${label} backup directory`,
      );
      renameSync(finalDirectory, backup);
    }

    try {
      renameSync(staging, finalDirectory);
    } catch (error) {
      if (backup && !existsSync(finalDirectory)) renameSync(backup, finalDirectory);
      throw error;
    }

    if (backup) removeAtomicOutputDirectoryBestEffort(backup, `${label} committed backup`);
    return result;
  } finally {
    removeAtomicOutputDirectoryBestEffort(staging, `${label} staging directory`);
  }
}
