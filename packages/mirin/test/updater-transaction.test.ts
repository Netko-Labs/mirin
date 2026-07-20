import { describe, expect, test } from "bun:test";
import {
  generationDirectoryName,
  SingleFlight,
  UpdateTransactionState,
} from "../src/updater/lib/transaction.ts";

describe("updater transaction generations", () => {
  test("rejects stale completion and guards concurrent download/apply operations", () => {
    const state = new UpdateTransactionState();
    const firstGeneration = state.beginCheck();
    const first = state.commitCheck(firstGeneration, "1.1.0", "a".repeat(64));
    expect(first).not.toBeNull();
    const oldDownload = state.beginDownload();

    const secondGeneration = state.beginCheck();
    const second = state.commitCheck(secondGeneration, "1.2.0", "b".repeat(64));
    expect(second).not.toBeNull();
    expect(state.completeDownload(oldDownload, "/stale", "/stale-work")).toBe(false);

    const currentDownload = state.beginDownload();
    expect(() => state.beginDownload()).toThrow("already in progress");
    expect(state.completeDownload(currentDownload, "/staged", "/work")).toBe(true);
    const staged = state.beginApply();
    expect(staged.version).toBe("1.2.0");
    expect(() => state.beginApply()).toThrow("already in progress");
    state.finishApply(false);
    expect(state.staged).toBeNull();
  });

  test("uses generation, version, and hash in work-directory identity", () => {
    expect(
      generationDirectoryName({ generation: 7, version: "2.0.0-beta.1", tarHash: "c".repeat(64) }),
    ).toBe(`generation-7-2.0.0-beta.1-${"c".repeat(16)}`);
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
