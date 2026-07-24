import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneGenerationDirectories } from "../src/updater/lib/cleanup.ts";
import { generationDirectoryName } from "../src/updater/lib/transaction.ts";

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

  test("preserves generations owned by live updater processes", () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-updater-owners-"));
    const updates = join(root, "updates");
    mkdirSync(updates);
    const snapshot = { generation: 1, version: "1.2.3", tarHash: "a".repeat(64) };
    const current = join(
      updates,
      generationDirectoryName(snapshot, { pid: 100, session: "b".repeat(32) }),
    );
    const reusedPid = join(
      updates,
      generationDirectoryName(snapshot, { pid: 100, session: "c".repeat(32) }),
    );
    const live = join(
      updates,
      generationDirectoryName(snapshot, { pid: 200, session: "d".repeat(32) }),
    );
    const abandoned = join(
      updates,
      generationDirectoryName(snapshot, { pid: 300, session: "e".repeat(32) }),
    );
    for (const directory of [current, reusedPid, live, abandoned]) {
      mkdirSync(directory);
    }

    try {
      pruneGenerationDirectories(updates, {
        currentPid: 100,
        currentSession: "b".repeat(32),
        isProcessAlive: (pid) => pid === 200,
      });
      expect(existsSync(current)).toBe(true);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(reusedPid)).toBe(false);
      expect(existsSync(abandoned)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
