import { $ } from "bun";

export async function verifyArchiveLayout(archive: string, expectedRoot: string): Promise<void> {
  const root = archivePath(expectedRoot);
  if (!root || root.includes("/")) throw new Error(`invalid update bundle root: ${expectedRoot}`);

  // Entry names must all stay under the bundle root (no `..`, absolute, or
  // drive-letter paths).
  const listing = await $`tar -tf ${archive}`.quiet().text();
  let sawRoot = false;
  for (const rawEntry of listing.split(/\r?\n/)) {
    if (rawEntry.length === 0) continue;
    const entry = archivePath(rawEntry);
    if (!entry) throw new Error(`unsafe update archive entry: ${rawEntry}`);
    if (entry === root || entry.startsWith(`${root}/`)) {
      sawRoot = true;
      continue;
    }
    throw new Error(`update archive entry escapes ${root}: ${rawEntry}`);
  }
  if (!sawRoot) throw new Error(`update archive missing ${root}`);

  // The name check above can't see link targets. A symlink whose target escapes
  // the root lets a *later* entry be written through it, outside the extraction
  // dir. Inspect the verbose listing and reject unsafe links / special files.
  // (macOS `.app`s legitimately contain relative in-bundle symlinks, so those
  // are allowed — only escaping targets and device/fifo/socket nodes fail.)
  const verbose = await $`tar -tvf ${archive}`.quiet().text();
  for (const line of verbose.split(/\r?\n/)) {
    const problem = unsafeArchiveEntry(line);
    if (problem) throw new Error(`unsafe update archive entry: ${problem}`);
  }
}

/**
 * Classify a `tar -tvf` line; returns a reason string when the entry is unsafe
 * (an escaping symlink target, or a device/fifo/socket node) or `null` when it
 * is a benign file, directory, hardlink, or in-bundle relative symlink. Pure and
 * unit-tested; the leading mode char and trailing ` -> target` are formatted the
 * same way by GNU tar and BSD/libarchive tar.
 */
export function unsafeArchiveEntry(line: string): string | null {
  if (line.length === 0) return null;
  const type = line[0];
  // Block/char device, fifo, socket — never belong in an app bundle.
  if (type === "b" || type === "c" || type === "p" || type === "s") return line;
  // Symlinks carry an arbitrary target after ` -> `. Allow relative in-bundle
  // targets; reject absolute or `..`-bearing ones that can escape the root.
  const arrow = line.lastIndexOf(" -> ");
  if (arrow !== -1) {
    const target = line.slice(arrow + 4);
    if (isEscapingLinkTarget(target)) return line;
  }
  return null;
}

function isEscapingLinkTarget(target: string): boolean {
  if (target.length === 0) return true;
  const normalized = target.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return true;
  return normalized.split("/").includes("..");
}

function archivePath(raw: string): string | null {
  let path = raw.replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  if (
    path.length === 0 ||
    path === "." ||
    path.startsWith("/") ||
    path.startsWith("//") ||
    /^[A-Za-z]:/.test(path)
  ) {
    return null;
  }
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}
