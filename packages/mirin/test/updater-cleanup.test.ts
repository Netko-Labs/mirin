import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneGenerationDirectories } from "../src/updater/lib/cleanup.ts";

describe("updater generation cleanup", () => {
  test("prunes strict generation directories without following symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-updater-cleanup-"));
    const updates = join(root, "updates");
    const abandoned = join(updates, "generation-1-1.2.3-beta.1-aaaaaaaaaaaaaaaa");
    const unrelated = join(updates, "notes");
    const outside = join(root, "outside");
    const linked = join(updates, "generation-2-1.2.4-bbbbbbbbbbbbbbbb");
    mkdirSync(abandoned, { recursive: true });
    mkdirSync(unrelated);
    mkdirSync(outside);
    symlinkSync(outside, linked, "dir");

    try {
      pruneGenerationDirectories(updates);
      expect(existsSync(abandoned)).toBe(false);
      expect(existsSync(unrelated)).toBe(true);
      expect(existsSync(linked)).toBe(true);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
