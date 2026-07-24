import { randomUUID } from "node:crypto";
import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { safeDestructiveDirectory } from "./project-source.ts";

const STALE_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;
const ATOMIC_SWAP_DURABILITY_EXIT_CODE = 2;
const OWNED_BACKUP_SUFFIX =
  /^([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AtomicOutputOperations {
  syncTree(path: string): void;
  syncParent?(path: string): void;
  validateSwap(left: string, right: string): void;
  atomicSwap(left: string, right: string): "durable" | "visible" | undefined;
  durableMove(source: string, destination: string): void;
}

export class AtomicOutputDurabilityError extends Error {
  constructor(cause?: unknown) {
    super("atomic output replacement is visible but its parent directory could not be synced", {
      cause,
    });
    this.name = "AtomicOutputDurabilityError";
  }
}

export function createAtomicOutputOperations(
  codec: string,
  runCodec: (command: string[]) => { exitCode: number } = (command) =>
    Bun.spawnSync(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }),
): AtomicOutputOperations {
  const run = (operation: string, ...paths: string[]) => {
    const result = runCodec([codec, operation, ...paths]);
    if (result.exitCode !== 0) {
      throw new Error(`codec ${operation} failed for atomic output`);
    }
  };
  return {
    syncTree(path) {
      run("sync-tree", path);
    },
    syncParent(path) {
      run("sync-parent", path);
    },
    validateSwap(left, right) {
      run("validate-swap", left, right);
    },
    atomicSwap(left, right) {
      const result = runCodec([codec, "atomic-swap", left, right]);
      if (result.exitCode === ATOMIC_SWAP_DURABILITY_EXIT_CODE) return "visible";
      if (result.exitCode !== 0) {
        throw new Error("codec atomic-swap failed for atomic output");
      }
      return "durable";
    },
    durableMove(source, destination) {
      run("durable-move", source, destination);
    },
  };
}

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
  isProcessAlive: (pid: number) => boolean = processIsAlive,
  operations?: AtomicOutputOperations,
): void {
  const finalDirectory = safeDestructiveDirectory(projectRoot, destination, label);
  const parent = dirname(finalDirectory);
  const backupPrefix = `.${basename(finalDirectory)}.mirin-backup-`;
  const stagePrefix = `.${basename(finalDirectory)}.mirin-stage-`;
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

  let restoredPath: string | undefined;
  if (!existsSync(finalDirectory)) {
    const restorable = entries
      .filter((entry) => entry.name.startsWith(backupPrefix) && entry.isDirectory())
      .map((entry) => {
        const owner = OWNED_BACKUP_SUFFIX.exec(entry.name.slice(backupPrefix.length));
        if (!owner) return undefined;
        const ownerPid = Number(owner[1]);
        if (!Number.isSafeInteger(ownerPid) || isProcessAlive(ownerPid)) return undefined;
        const path = join(parent, entry.name);
        try {
          const metadata = lstatSync(path);
          if (metadata.isSymbolicLink() || !metadata.isDirectory()) return undefined;
          return { path, modifiedAtMs: metadata.mtimeMs };
        } catch {
          return undefined;
        }
      })
      .filter(
        (candidate): candidate is { path: string; modifiedAtMs: number } => candidate !== undefined,
      )
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)[0];
    if (restorable) {
      try {
        const backup = safeDestructiveDirectory(
          projectRoot,
          restorable.path,
          `${label} interrupted backup directory`,
        );
        if (operations) operations.durableMove(backup, finalDirectory);
        else renameSync(backup, finalDirectory);
        restoredPath = backup;
      } catch (error) {
        console.warn(
          `[mirin] could not restore interrupted ${label}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
  if (!existsSync(finalDirectory)) return;

  for (const entry of entries) {
    const prefix = entry.name.startsWith(backupPrefix)
      ? backupPrefix
      : entry.name.startsWith(stagePrefix)
        ? stagePrefix
        : undefined;
    if (!prefix || !entry.isDirectory()) continue;
    const owner = OWNED_BACKUP_SUFFIX.exec(entry.name.slice(prefix.length));
    if (!owner) continue;
    const ownerPid = Number(owner[1]);
    if (!Number.isSafeInteger(ownerPid) || isProcessAlive(ownerPid)) continue;
    const candidate = join(parent, entry.name);
    if (candidate === restoredPath) continue;
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
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
  operations: AtomicOutputOperations,
  write: (staging: string) => Promise<T> | T,
): Promise<T> {
  const finalDirectory = safeDestructiveDirectory(projectRoot, destination, label);
  const parent = dirname(finalDirectory);
  mkdirSync(parent, { recursive: true });
  pruneStaleAtomicOutputBackups(
    projectRoot,
    finalDirectory,
    label,
    Date.now(),
    processIsAlive,
    operations,
  );

  const staging = safeDestructiveDirectory(
    projectRoot,
    join(parent, `.${basename(finalDirectory)}.mirin-stage-${process.pid}-${randomUUID()}`),
    `${label} staging directory`,
  );
  mkdirSync(staging);
  let preserveStaging = false;

  try {
    const result = await write(staging);
    safeDestructiveDirectory(projectRoot, staging, `${label} staging directory`);
    safeDestructiveDirectory(projectRoot, finalDirectory, label);
    operations.syncTree(staging);

    if (existsSync(finalDirectory)) {
      operations.validateSwap(finalDirectory, staging);
      const swapOutcome = operations.atomicSwap(finalDirectory, staging);
      if (swapOutcome === "visible") {
        // The exchange already placed the new output at finalDirectory and the
        // previous output at staging. Preserve both until a parent sync proves
        // the namespace transition durable.
        preserveStaging = true;
        if (!operations.syncParent) throw new AtomicOutputDurabilityError();
        try {
          operations.syncParent(finalDirectory);
        } catch (error) {
          throw new AtomicOutputDurabilityError(error);
        }
        preserveStaging = false;
      }
      removeAtomicOutputDirectoryBestEffort(staging, `${label} committed previous output`);
    } else {
      operations.durableMove(staging, finalDirectory);
    }

    return result;
  } finally {
    if (!preserveStaging) {
      removeAtomicOutputDirectoryBestEffort(staging, `${label} staging directory`);
    }
  }
}
