import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeResources } from "../src/extras.ts";

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "mirin-extras-"));
  mkdirSync(join(dir, "vendor", "server"), { recursive: true });
  writeFileSync(join(dir, "vendor", "file.txt"), "x");
  return dir;
}

describe("normalizeResources", () => {
  test("resolves a project-relative directory", () => {
    const dir = project();
    expect(normalizeResources(dir, { server: "vendor/server" })).toEqual([
      { name: "server", src: join(dir, "vendor", "server") },
    ]);
  });

  test("rejects names that are not a single path segment", () => {
    const dir = project();
    expect(() => normalizeResources(dir, { "../up": "vendor/server" })).toThrow(
      /invalid resource name/,
    );
  });

  test("rejects paths that escape the project root", () => {
    const dir = project();
    expect(() => normalizeResources(dir, { server: "../outside" })).toThrow(
      /escapes the project root/,
    );
  });

  test("rejects files and missing directories", () => {
    const dir = project();
    expect(() => normalizeResources(dir, { file: "vendor/file.txt" })).toThrow(/not a directory/);
    expect(() => normalizeResources(dir, { nope: "vendor/missing" })).toThrow(/not a directory/);
  });
});
