import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

// Thin (LE/BE, 32/64-bit) and fat Mach-O magics. A fat header shares 0xCAFEBABE
// with Java class files; `nfat_arch` separates them (a class file has a version there).
const THIN_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);
const FAT_MAGICS = new Set([0xcafebabe, 0xcafebabf]);
const MAX_FAT_ARCHS = 32;

/** True when the file starts with a Mach-O header (thin or fat), regardless of extension. */
export function isMachO(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(8);
    if (readSync(fd, header, 0, 8, 0) < 8) return false;
    const magic = header.readUInt32BE(0);
    if (THIN_MAGICS.has(magic)) return true;
    if (!FAT_MAGICS.has(magic)) return false;
    const archCount = header.readUInt32BE(4);
    return archCount > 0 && archCount <= MAX_FAT_ARCHS;
  } finally {
    closeSync(fd);
  }
}

/** Every regular Mach-O file under `root` (symlinks skipped), sorted for stable signing. */
export function findMachOFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.isFile() && lstatSync(path).size >= 8 && isMachO(path)) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}
