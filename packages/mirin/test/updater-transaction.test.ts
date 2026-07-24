import { describe, expect, test } from "bun:test";
import {
  assertDownloadCanStart,
  generationDirectoryName,
  SingleFlight,
  UpdateTransactionState,
} from "../src/updater/lib/transaction.ts";

describe("updater transaction generations", () => {
  test("rejects checks during download and stale completion after invalidation", () => {
    const state = new UpdateTransactionState();
    const firstGeneration = state.beginCheck();
    const first = state.commitCheck(firstGeneration, "1.1.0", "a".repeat(64));
    expect(first).not.toBeNull();
    const oldDownload = state.beginDownload();

    expect(() => state.beginCheck()).toThrow("cannot check while an update is downloading");
    expect(() => state.beginDownload()).toThrow("already in progress");
    expect(() => state.beginApply()).toThrow("cannot apply while an update is downloading");

    state.invalidate();
    expect(state.completeDownload(oldDownload, "/stale", "/stale-work")).toBe(false);

    const secondGeneration = state.beginCheck();
    const second = state.commitCheck(secondGeneration, "1.2.0", "b".repeat(64));
    expect(second).not.toBeNull();
    const currentDownload = state.beginDownload();
    expect(state.completeDownload(currentDownload, "/staged", "/work")).toBe(true);
    expect(() => state.beginCheck()).toThrow("cannot check while an update is staged");
    expect(state.staged?.workDir).toBe("/work");
    const staged = state.beginApply();
    expect(staged.version).toBe("1.2.0");
    expect(() => state.beginApply()).toThrow("already in progress");
    state.finishApply(false);
    expect(state.staged).toBeNull();
  });

  test("keeps successful helper handoff terminal until process exit", () => {
    const state = new UpdateTransactionState();
    const generation = state.beginCheck();
    state.commitCheck(generation, "1.1.0", "a".repeat(64));
    const download = state.beginDownload();
    state.completeDownload(download, "/staged", "/work");
    state.beginApply();
    state.finishApply(true);

    expect(state.isHandedOff).toBe(true);
    state.finishApply(false);
    expect(state.isHandedOff).toBe(true);
    expect(() => state.beginCheck()).toThrow("cannot check for updates while applying");
    expect(() => state.beginDownload()).toThrow("cannot download an update while applying");
    expect(() => state.beginApply()).toThrow("already in progress");
  });

  test("uses generation, version, and hash in work-directory identity", () => {
    expect(
      generationDirectoryName(
        { generation: 7, version: "2.0.0-beta.1", tarHash: "c".repeat(64) },
        { pid: 42, session: "d".repeat(32) },
      ),
    ).toBe(`generation-42-${"d".repeat(32)}-7-2.0.0-beta.1-${"c".repeat(16)}`);
  });

  test("allows an event listener to download after the in-flight check commits", () => {
    const state = new UpdateTransactionState();
    const generation = state.beginCheck();
    expect(() => assertDownloadCanStart(state, true)).toThrow("check is in progress");

    state.commitCheck(generation, "1.1.0", "a".repeat(64));
    expect(() => assertDownloadCanStart(state, true)).not.toThrow();
    expect(state.beginDownload().generation).toBe(generation);
  });
});

describe("updater single-flight checks", () => {
  test("shares one in-flight operation and permits a later check", async () => {
    const flight = new SingleFlight<number>();
    let calls = 0;
    let release: (() => void) | undefined;
    const operation = (): Promise<number> => {
      calls += 1;
      return new Promise((resolve) => {
        release = () => resolve(calls);
      });
    };

    const first = flight.run(operation);
    const second = flight.run(operation);
    expect(second).toBe(first);
    expect(calls).toBe(1);
    release?.();
    await expect(first).resolves.toBe(1);
    await Promise.resolve();
    const third = flight.run(async () => 2);
    expect(third).not.toBe(first);
    await expect(third).resolves.toBe(2);
  });
});
