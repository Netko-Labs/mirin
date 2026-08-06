/**
 * Install the mirin agent skill into a project.
 *
 * The skill teaches a coding agent how to verify and drive a mirin app — `mirin
 * check`, the session artifacts, scenarios, and the inspector. It ships here rather
 * than in the CLI because both entry points need it: `bun create mirinjs` (which has
 * no CLI) and `mirin skill` / `mirin init` (which depend on this package).
 *
 * Assets live in `skill/` as plain Markdown. Nothing is templated — the skill
 * describes the tool, not the app — so installing is a copy.
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
  /** True when an existing install was replaced. */
  replaced: boolean;
}

/**
 * Copy the skill into `projectDir/.claude/skills/mirin`.
 *
 * An existing install is replaced wholesale rather than merged: a stale reference
 * file left behind by an older version would be read as current.
 */
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
