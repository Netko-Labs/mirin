import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { safeDestructiveDirectory } from "./project-source.ts";

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

    if (backup) rmSync(backup, { recursive: true, force: true });
    return result;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
