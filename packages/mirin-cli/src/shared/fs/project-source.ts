import { copyFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

/** Resolve a real project root once so symlink containment checks share one anchor. */
export function canonicalProjectRoot(projectDir: string): string {
  let root: string;
  try {
    root = realpathSync(projectDir);
  } catch {
    throw new Error(`[mirin] project root does not exist: ${projectDir}`);
  }
  if (!statSync(root).isDirectory()) {
    throw new Error(`[mirin] project root is not a directory: ${projectDir}`);
  }
  return root;
}

/**
 * Resolve a project-relative source through symlinks, reject escapes, and require
 * a regular file. The returned path is canonical and safe to pass to build tools.
 */
export function resolveProjectFile(projectRoot: string, file: unknown, label: string): string {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error(`[mirin] ${label} must be a non-empty project-relative path.`);
  }
  if (isAbsolute(file) || win32.isAbsolute(file)) {
    throw new Error(`[mirin] ${label} must be relative to the project root: ${file}`);
  }

  const lexicalPath = resolve(projectRoot, file);
  assertContained(projectRoot, lexicalPath, label, file);

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(lexicalPath);
  } catch {
    throw new Error(`[mirin] ${label} does not exist: ${file}`);
  }
  assertContained(projectRoot, canonicalPath, label, file);
  return assertRegularFile(canonicalPath, label);
}

/** Require a source to resolve to a regular file immediately before copying it. */
export function assertRegularFile(source: string, label: string): string {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(source);
  } catch {
    throw new Error(`[mirin] ${label} does not exist: ${source}`);
  }
  if (!statSync(canonicalPath).isFile()) {
    throw new Error(`[mirin] ${label} must be a regular file: ${source}`);
  }
  return canonicalPath;
}

/** Copy a source as bytes so the destination cannot remain a source symlink. */
export function copyRegularFile(source: string, destination: string, label: string): void {
  copyFileSync(assertRegularFile(source, label), destination);
}

function assertContained(root: string, candidate: string, label: string, original: string): void {
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot) ||
    win32.isAbsolute(fromRoot)
  ) {
    throw new Error(`[mirin] ${label} escapes the project root: ${original}`);
  }
}
