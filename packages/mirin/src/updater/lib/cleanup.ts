import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const GENERATION_DIRECTORY = /^generation-[1-9]\d*-[0-9A-Za-z][0-9A-Za-z.+-]*-[a-f0-9]{16}$/;

export function removePathBestEffort(path: string, recursive = false): void {
  try {
    rmSync(path, { recursive, force: true });
  } catch {
    // Cleanup must not mask the updater operation that made the path disposable.
  }
}

export function pruneGenerationDirectories(updatesDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(updatesDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!GENERATION_DIRECTORY.test(entry)) continue;
    const path = join(updatesDir, entry);
    try {
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
    } catch {
      continue;
    }
    removePathBestEffort(path, true);
  }
}
