/**
 * Install the mirin agent skill into a project. Ships in this package because both
 * `bun create mirinjs` (no CLI) and `mirin skill`/`mirin init` need it.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const SKILL_DIR = join(import.meta.dir, "..", "skill");

/** Where a Claude Code project skill lives. */
const INSTALL_PATH = join(".claude", "skills", "mirin");

export interface InstallSkillResult {
  /** Absolute path the skill was written to. */
  path: string;
  /** Relative to the project, for printing. */
  relativePath: string;
  replaced: boolean;
}

/** Copy the skill into `projectDir/.claude/skills/mirin`. An existing install is
 *  replaced wholesale, not merged: a stale reference file would read as current. */
export function installSkill(projectDir: string): InstallSkillResult {
  if (!existsSync(SKILL_DIR)) {
    throw new Error(`mirin skill assets are missing from the package (${SKILL_DIR})`);
  }

  const path = join(projectDir, INSTALL_PATH);
  const replaced = existsSync(path) && readdirSync(path).length > 0;
  if (replaced) rmSync(path, { recursive: true, force: true });

  mkdirSync(path, { recursive: true });
  cpSync(SKILL_DIR, path, { recursive: true });

  return { path, relativePath: INSTALL_PATH, replaced };
}
