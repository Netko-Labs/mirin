import { $ } from "bun";

export async function verifyArchiveLayout(archive: string, expectedRoot: string): Promise<void> {
  const root = archivePath(expectedRoot);
  if (!root || root.includes("/")) throw new Error(`invalid update bundle root: ${expectedRoot}`);

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
