/**
 * Remove `bun build --compile` scratch files (`.*.bun-build`) from a directory.
 *
 * `bun build --compile` writes these temp files into the working directory and
 * normally cleans them up — but a hard-killed build leaves them behind, where
 * they accumulate in the project root. The dev/build commands sweep them first.
 */

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function sweepBuildTemps(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.endsWith(".bun-build")) {
      rmSync(join(dir, name), { force: true });
    }
  }
}
