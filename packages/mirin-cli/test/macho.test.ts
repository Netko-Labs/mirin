import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMachOFiles, isMachO } from "../src/bundle/macos/macho.ts";

function header(magic: number, second = 0): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeUInt32BE(magic, 0);
  buf.writeUInt32BE(second, 4);
  return buf;
}

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), "mirin-macho-"));
  mkdirSync(join(dir, "node_modules", "addon", "build"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "addon", "build", "addon.node"), header(0xcffaedfe));
  writeFileSync(join(dir, "node_modules", "addon", "lib.dylib"), header(0xfeedfacf));
  writeFileSync(join(dir, "fat"), header(0xcafebabe, 2));
  writeFileSync(join(dir, "Foo.class"), header(0xcafebabe, 52));
  writeFileSync(join(dir, "index.js"), "export {}\n");
  writeFileSync(join(dir, "tiny"), Buffer.from([0xcf, 0xfa]));
  symlinkSync(join(dir, "fat"), join(dir, "fat-link"));
  return dir;
}

describe("isMachO", () => {
  test("recognises thin and fat headers", () => {
    const dir = tree();
    expect(isMachO(join(dir, "node_modules", "addon", "build", "addon.node"))).toBe(true);
    expect(isMachO(join(dir, "fat"))).toBe(true);
  });

  test("rejects text, truncated files, and Java class files", () => {
    const dir = tree();
    expect(isMachO(join(dir, "index.js"))).toBe(false);
    expect(isMachO(join(dir, "tiny"))).toBe(false);
    expect(isMachO(join(dir, "Foo.class"))).toBe(false);
  });
});

describe("findMachOFiles", () => {
  test("walks nested directories, skips symlinks, sorts the result", () => {
    const dir = tree();
    expect(findMachOFiles(dir)).toEqual([
      join(dir, "fat"),
      join(dir, "node_modules", "addon", "build", "addon.node"),
      join(dir, "node_modules", "addon", "lib.dylib"),
    ]);
  });
});
