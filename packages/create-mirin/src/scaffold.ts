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
import { join, posix, win32 } from "node:path";

const TEMPLATE_DIR = join(import.meta.dir, "..", "template");
const SCAFFOLD_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SCAFFOLD_NAME_LENGTH = 63;

export interface ScaffoldOptions {
  /** App / package name (lowercase kebab-case). Defaults to the directory name. */
  name?: string;
}

/** Scaffold a new mirin app into `targetDir`. Returns the validated app name. */
export function scaffold(targetDir: string, options: ScaffoldOptions = {}): string {
  const appName = validateScaffoldName(options.name ?? scaffoldBasename(targetDir));
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new Error(`target directory "${targetDir}" already exists and is not empty.`);
  }
  const appId = `dev.local.${appName.replaceAll("-", "")}`;
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

  return appName;
}

/** Return a basename for POSIX or Windows-style paths on every host platform. */
export function scaffoldBasename(path: string): string {
  const withoutTrailingSeparators = path.replace(/[\\/]+$/, "");
  return win32.basename(posix.basename(withoutTrailingSeparators));
}

/** Enforce the package-safe name documented by the scaffold command. */
export function validateScaffoldName(value: string): string {
  if (value.length === 0 || value.length > MAX_SCAFFOLD_NAME_LENGTH || !SCAFFOLD_NAME.test(value)) {
    throw new Error(
      `invalid app name ${JSON.stringify(value)} — use 1–${MAX_SCAFFOLD_NAME_LENGTH} ` +
        'lowercase letters or digits separated by single hyphens (for example "my-app").',
    );
  }
  return value;
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

/** The version of this create-mirin package, pinned into the scaffold. */
function mirinVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("create-mirinjs package metadata is invalid.");
  }
  const version = (parsed as Record<string, unknown>).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("create-mirinjs package version is invalid.");
  }
  return `^${version}`;
}
