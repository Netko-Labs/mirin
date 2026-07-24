import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPLY_HELPER_PID_FILE,
  GENERATION_OWNER_FILE,
  hasLiveApplyHelper,
  MAX_APPLY_HELPER_AGE_MS,
  MAX_GENERATION_OWNER_AGE_MS,
  pruneGenerationDirectories,
} from "../src/updater/lib/cleanup.ts";
import { generationDirectoryName } from "../src/updater/lib/transaction.ts";

describe("updater generation cleanup", () => {
  test("prunes strict generation directories without following symlinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-updater-cleanup-"));
    const updates = join(root, "updates");
    const abandoned = join(updates, "generation-1-1.2.3-beta.1-aaaaaaaaaaaaaaaa");
    const unrelated = join(updates, "notes");
    const outside = join(root, "outside");
    const linked = join(updates, "generation-2-1.2.4-bbbbbbbbbbbbbbbb");
    mkdirSync(abandoned, { recursive: true });
    mkdirSync(unrelated);
    mkdirSync(outside);
    writeFileSync(join(outside, APPLY_HELPER_PID_FILE), "999");
    symlinkSync(outside, linked, "dir");

    try {
      expect(await hasLiveApplyHelper(updates, { isProcessAlive: () => true })).toBe(false);
      await pruneGenerationDirectories(updates);
      expect(existsSync(abandoned)).toBe(false);
      expect(existsSync(unrelated)).toBe(true);
      expect(existsSync(linked)).toBe(true);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leases generations owned by non-current live updater processes", async () => {
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
    writeFileSync(join(live, GENERATION_OWNER_FILE), "200|live-token");
    const liveMtimeMs = statSync(live).mtimeMs;

    try {
      await pruneGenerationDirectories(updates, {
        currentPid: 100,
        currentSession: "b".repeat(32),
        isOwnerAlive: (identity) => identity.pid === 200 && identity.token === "live-token",
        nowMs: liveMtimeMs,
      });
      expect(existsSync(current)).toBe(true);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(reusedPid)).toBe(false);
      expect(existsSync(abandoned)).toBe(false);

      await pruneGenerationDirectories(updates, {
        currentPid: 100,
        currentSession: "b".repeat(32),
        isOwnerAlive: (identity) => identity.pid === 200 && identity.token === "live-token",
        nowMs: liveMtimeMs + MAX_GENERATION_OWNER_AGE_MS + 1,
      });
      expect(existsSync(current)).toBe(true);
      expect(existsSync(live)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves a generation transferred to a live apply helper within its lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-updater-helper-owner-"));
    const updates = join(root, "updates");
    const generation = join(
      updates,
      generationDirectoryName(
        { generation: 1, version: "1.2.3", tarHash: "a".repeat(64) },
        { pid: 300, session: "e".repeat(32) },
      ),
    );
    const reusedHelperGeneration = join(
      updates,
      generationDirectoryName(
        { generation: 2, version: "1.2.4", tarHash: "b".repeat(64) },
        { pid: 301, session: "f".repeat(32) },
      ),
    );
    mkdirSync(generation, { recursive: true });
    mkdirSync(reusedHelperGeneration);
    const helperMarker = join(generation, APPLY_HELPER_PID_FILE);
    writeFileSync(helperMarker, "400|helper-token");
    writeFileSync(join(reusedHelperGeneration, APPLY_HELPER_PID_FILE), "100|reused-token");
    const markerMtimeMs = statSync(helperMarker).mtimeMs;

    try {
      expect(
        await hasLiveApplyHelper(updates, {
          currentPid: 400,
          isProcessAlive: (identity) => identity.pid === 400,
        }),
      ).toBe(false);
      expect(
        await hasLiveApplyHelper(updates, {
          currentPid: 100,
          isProcessAlive: (identity) => identity.pid === 400 && identity.token === "helper-token",
        }),
      ).toBe(true);
      await pruneGenerationDirectories(updates, {
        currentPid: 100,
        currentSession: "b".repeat(32),
        isHelperAlive: (identity) => identity.pid === 400 && identity.token === "helper-token",
      });
      expect(existsSync(generation)).toBe(true);
      expect(existsSync(reusedHelperGeneration)).toBe(false);

      const expiredNowMs = markerMtimeMs + MAX_APPLY_HELPER_AGE_MS + 1;
      expect(
        await hasLiveApplyHelper(updates, {
          currentPid: 100,
          isProcessAlive: (identity) => identity.pid === 400,
          nowMs: expiredNowMs,
        }),
      ).toBe(false);
      await pruneGenerationDirectories(updates, {
        currentPid: 100,
        currentSession: "b".repeat(32),
        isHelperAlive: (identity) => identity.pid === 400,
        nowMs: expiredNowMs,
      });
      expect(existsSync(generation)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
