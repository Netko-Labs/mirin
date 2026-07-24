import { copyFileSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

/** Resolve a real project root once so containment checks share one anchor. */
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

  const root = canonicalProjectRoot(projectRoot);
  const lexicalPath = resolve(root, file);
  assertContained(root, lexicalPath, label, file);
  return assertProjectFile(root, lexicalPath, label);
}

/** Resolve an app icon, which may be a regular file or a flat `.iconset` directory. */
export function resolveProjectIcon(projectRoot: string, icon: unknown, label: string): string {
  if (typeof icon !== "string" || icon.length === 0) {
    throw new Error(`[mirin] ${label} must be a non-empty project-relative path.`);
  }
  if (isAbsolute(icon) || win32.isAbsolute(icon)) {
    throw new Error(`[mirin] ${label} must be relative to the project root: ${icon}`);
  }

  const root = canonicalProjectRoot(projectRoot);
  const lexicalPath = resolve(root, icon);
  assertContained(root, lexicalPath, label, icon);
  return assertProjectIcon(root, lexicalPath, label);
}

/** Re-resolve a source at its point of use and prove it remains in the project. */
export function assertProjectFile(projectRoot: string, source: string, label: string): string {
  const root = canonicalProjectRoot(projectRoot);
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(source);
  } catch {
    throw new Error(`[mirin] ${label} does not exist: ${source}`);
  }
  assertContained(root, canonicalPath, label, source);
  if (!statSync(canonicalPath).isFile()) {
    throw new Error(`[mirin] ${label} must be a regular file: ${source}`);
  }
  return canonicalPath;
}

/** Revalidate a project-owned app icon immediately before a bundle or package reads it. */
export function assertProjectIcon(projectRoot: string, source: string, label: string): string {
  const root = canonicalProjectRoot(projectRoot);
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(source);
  } catch {
    throw new Error(`[mirin] ${label} does not exist: ${source}`);
  }
  assertContained(root, canonicalPath, label, source);

  const metadata = statSync(canonicalPath);
  if (metadata.isFile()) return canonicalPath;
  if (!metadata.isDirectory() || !canonicalPath.toLowerCase().endsWith(".iconset")) {
    throw new Error(`[mirin] ${label} must be a regular file or .iconset directory: ${source}`);
  }

  for (const entry of readdirSync(canonicalPath)) {
    const child = join(canonicalPath, entry);
    const childMetadata = lstatSync(child);
    if (childMetadata.isSymbolicLink() || !childMetadata.isFile()) {
      throw new Error(`[mirin] ${label} .iconset must contain only regular files: ${child}`);
    }
    assertContained(root, realpathSync(child), label, child);
  }
  return canonicalPath;
}

/** Copy project-owned bytes so the destination cannot remain a source symlink. */
export function copyProjectFile(
  projectRoot: string,
  source: string,
  destination: string,
  label: string,
): void {
  copyFileSync(assertProjectFile(projectRoot, source, label), destination);
}

/**
 * Validate an owned output directory, including every existing path component.
 * Symlinks and Windows junction/reparse links are rejected before cleanup.
 */
export function validateOwnedOutputDirectory(
  projectRoot: string,
  directory: string,
  label: string,
): string {
  const root = canonicalProjectRoot(projectRoot);
  const suppliedRoot = resolve(projectRoot);
  const suppliedCandidate = resolve(suppliedRoot, directory);
  let fromRoot = relative(suppliedRoot, suppliedCandidate);
  if (!isContainedRelative(fromRoot)) {
    const canonicalCandidate = resolve(root, directory);
    fromRoot = relative(root, canonicalCandidate);
    if (!isContainedRelative(fromRoot)) {
      throw new Error(`[mirin] ${label} escapes the project root: ${directory}`);
    }
  }
  const candidate = resolve(root, fromRoot);

  let current = root;
  for (const part of fromRoot.split(sep).filter(Boolean)) {
    current = join(current, part);
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(current);
    } catch (error) {
      if (isMissingPathError(error)) break;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`[mirin] ${label} must not be a symlink or reparse point: ${current}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`[mirin] ${label} must be a directory: ${current}`);
    }
    assertContained(root, realpathSync(current), label, current);
  }
  return candidate;
}

/** Validate an output directory immediately before recursive removal. */
export function safeDestructiveDirectory(
  projectRoot: string,
  directory: string,
  label: string,
): string {
  const root = canonicalProjectRoot(projectRoot);
  const candidate = validateOwnedOutputDirectory(projectRoot, directory, label);
  if (relative(root, candidate) === "") {
    throw new Error(`[mirin] ${label} must not be the project root: ${directory}`);
  }
  return candidate;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertContained(root: string, candidate: string, label: string, original: string): void {
  if (!isContainedRelative(relative(root, candidate))) {
    throw new Error(`[mirin] ${label} escapes the project root: ${original}`);
  }
}

function isContainedRelative(fromRoot: string): boolean {
  return !(
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot) ||
    win32.isAbsolute(fromRoot)
  );
}
