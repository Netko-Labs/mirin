import { describe, expect, test } from "bun:test";
import { win32 } from "node:path";
import {
  assertDownloadCanStart,
  generationDirectoryName,
  SingleFlight,
  UpdateTransactionState,
  updaterSupportPathComponents,
} from "../src/updater/lib/transaction.ts";
import { assertUpdaterApplyAllowed } from "../src/updater/updater.ts";

describe("updater transaction generations", () => {
  test("rejects automatic apply when the app permits multiple running instances", () => {
    expect(() => assertUpdaterApplyAllowed(true)).not.toThrow();
    expect(() => assertUpdaterApplyAllowed(false)).toThrow("acquired exclusive app lock");
  });

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
    expect(() => state.beginDownload()).toThrow("already staged");
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

  test("bounds maximum valid Windows updater work paths deterministically", () => {
    const identifier = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(41)}`;
    const channel = "c".repeat(64);
    const version = `1.0.0-${"v".repeat(122)}`;
    const owner = { pid: Number.MAX_SAFE_INTEGER, session: "d".repeat(32) };
    const support = updaterSupportPathComponents(identifier, channel, "win32");
    const generation = generationDirectoryName(
      { generation: Number.MAX_SAFE_INTEGER, version, tarHash: "e".repeat(64) },
      owner,
      "win32",
    );
    const workPath = win32.join(
      "C:\\Users\\ordinary-user\\AppData\\Local",
      ...support,
      "updates",
      generation,
      "extract",
    );

    expect(identifier).toHaveLength(233);
    expect(channel).toHaveLength(64);
    expect(version).toHaveLength(128);
    expect(support).toEqual([".mirin-compact", expect.stringMatching(/^[a-f0-9]{32}$/)]);
    expect(updaterSupportPathComponents(identifier, channel, "win32")).toEqual(support);
    expect(
      updaterSupportPathComponents(`${identifier.slice(0, -1)}e`, channel, "win32"),
    ).not.toEqual(support);
    expect(generation).toMatch(
      new RegExp(`^generation-${Number.MAX_SAFE_INTEGER}-${"d".repeat(32)}-g[a-f0-9]{32}$`),
    );
    expect(
      generationDirectoryName(
        { generation: Number.MAX_SAFE_INTEGER, version, tarHash: "e".repeat(64) },
        owner,
        "win32",
      ),
    ).toBe(generation);
    expect(
      generationDirectoryName(
        { generation: Number.MAX_SAFE_INTEGER - 1, version, tarHash: "e".repeat(64) },
        owner,
        "win32",
      ),
    ).not.toBe(generation);
    expect(workPath.length).toBeLessThan(200);
  });

  test("preserves ordinary and non-Windows updater work path names", () => {
    const snapshot = { generation: 7, version: "2.0.0-beta.1", tarHash: "c".repeat(64) };
    const owner = { pid: 42, session: "d".repeat(32) };
    const generation = `generation-42-${"d".repeat(32)}-7-2.0.0-beta.1-${"c".repeat(16)}`;

    expect(updaterSupportPathComponents("dev.example.app", "stable", "win32")).toEqual([
      "dev.example.app",
      "stable",
    ]);
    expect(updaterSupportPathComponents("a".repeat(41), "stable", "linux")).toEqual([
      "a".repeat(41),
      "stable",
    ]);
    expect(generationDirectoryName(snapshot, owner, "win32")).toBe(generation);
    expect(
      generationDirectoryName({ ...snapshot, version: `1.0.0-${"v".repeat(122)}` }, owner, "linux"),
    ).toContain(`1.0.0-${"v".repeat(122)}`);
  });

  test("allocates distinct generations across public updater instances", () => {
    const first = new UpdateTransactionState();
    const second = new UpdateTransactionState();
    const firstGeneration = first.beginCheck();
    const secondGeneration = second.beginCheck();
    const version = "2.0.0";
    const tarHash = "e".repeat(64);
    const owner = { pid: 42, session: "f".repeat(32) };

    expect(firstGeneration).not.toBe(secondGeneration);
    expect(
      generationDirectoryName({ generation: firstGeneration, version, tarHash }, owner),
    ).not.toBe(generationDirectoryName({ generation: secondGeneration, version, tarHash }, owner));
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
