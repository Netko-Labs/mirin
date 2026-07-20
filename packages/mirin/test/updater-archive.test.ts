import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateArchiveEntries, verifyArchiveLayout } from "../src/updater/lib/archive.ts";

function writeString(target: Uint8Array, offset: number, length: number, value: string): void {
  target.set(new TextEncoder().encode(value).subarray(0, length), offset);
}

function tarWithEntry(name: string, type: string, linkTarget = ""): Uint8Array {
  const header = new Uint8Array(512);
  writeString(header, 0, 100, name);
  writeString(header, 100, 8, "0000755\0");
  writeString(header, 108, 8, "0000000\0");
  writeString(header, 116, 8, "0000000\0");
  writeString(header, 124, 12, "00000000000\0");
  writeString(header, 136, 12, "00000000000\0");
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  writeString(header, 157, 100, linkTarget);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const archive = new Uint8Array(1536);
  archive.set(header, 0);
  return archive;
}

describe("updater archive validation", () => {
  test("accepts contained links and rejects escaping or invalid hardlinks", () => {
    expect(() =>
      validateArchiveEntries(
        [
          { path: "App.app/", kind: "directory" },
          { path: "App.app/Versions/A/file", kind: "file" },
          {
            path: "App.app/Versions/Current",
            kind: "symlink",
            linkTarget: "A",
          },
          {
            path: "App.app/file-link",
            kind: "hardlink",
            linkTarget: "App.app/Versions/A/file",
          },
        ],
        "App.app",
      ),
    ).not.toThrow();

    expect(() =>
      validateArchiveEntries(
        [
          { path: "App.app/", kind: "directory" },
          { path: "App.app/link", kind: "symlink", linkTarget: "../../outside" },
        ],
        "App.app",
      ),
    ).toThrow("symlink escapes");
    expect(() =>
      validateArchiveEntries(
        [
          { path: "App.app/", kind: "directory" },
          { path: "App.app/link", kind: "hardlink", linkTarget: "App.app/missing" },
        ],
        "App.app",
      ),
    ).toThrow("not a regular file");
  });

  test("rejects special tar nodes and a linked staged root", async () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-archive-test-"));
    try {
      const fifo = join(root, "fifo.tar");
      writeFileSync(fifo, tarWithEntry("App.app/pipe", "6"));
      await expect(verifyArchiveLayout(fifo, "App.app")).rejects.toThrow(
        "unsupported update archive entry type",
      );

      const linkedRoot = join(root, "linked-root.tar");
      writeFileSync(linkedRoot, tarWithEntry("App.app", "2", "elsewhere"));
      await expect(verifyArchiveLayout(linkedRoot, "App.app")).rejects.toThrow(
        "root is not a directory",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
