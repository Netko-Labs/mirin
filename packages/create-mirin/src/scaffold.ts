/**
 * Copy the starter template into a target directory, substituting the app name,
 * id, and the mirin version. Shared by `bun create mirinjs` and `mirin init`.
 */

import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { installSkill } from "./skill.ts";

const TEMPLATE_DIR = join(import.meta.dir, "..", "template");

export interface ScaffoldOptions {
  /** App / package name (kebab-case). Defaults to the directory name. */
  name?: string;
}

/** Scaffold a new mirin app into `targetDir`. Returns the resolved app name. */
export function scaffold(targetDir: string, options: ScaffoldOptions = {}): string {
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new Error(`target directory "${targetDir}" already exists and is not empty.`);
  }
  const appName = (options.name ?? basename(targetDir)).trim() || "mirin-app";
  const appId = `dev.local.${appName.replace(/[^a-z0-9]+/gi, "").toLowerCase() || "app"}`;
  const version = mirinVersion();

  cpSync(TEMPLATE_DIR, targetDir, { recursive: true });

  // npm strips a literal .gitignore from published packages; ship it as
  // `_gitignore` and restore the name on scaffold.
  const ignore = join(targetDir, "_gitignore");
  if (existsSync(ignore)) renameSync(ignore, join(targetDir, ".gitignore"));

  const replacements = [
    ["__APP_NAME__", appName],
    ["__APP_ID__", appId],
    ["__MIRIN_VERSION__", version],
  ] as const;
  for (const file of walk(targetDir)) applyReplacements(file, replacements);

  // After the replacement pass: the skill has no placeholders and must not be walked.
  installSkill(targetDir);

  return appName;
}

function applyReplacements(
  file: string,
  replacements: readonly (readonly [string, string])[],
): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return; // skip binary/unreadable files
  }
  let changed = text;
  for (const [from, to] of replacements) {
    changed = changed.split(from).join(to);
  }
  if (changed !== text) writeFileSync(file, changed);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

/** The version of this create-mirin package, pinned into the scaffold. */
function mirinVersion(): string {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
  return `^${pkg.version}`;
}
