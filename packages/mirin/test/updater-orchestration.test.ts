import { describe, expect, test } from "bun:test";
import { runDownloadOperation, UpdateTransactionState } from "../src/updater/lib/transaction.ts";

describe("updater download failure orchestration", () => {
  test("releases the download latch before reporting and best-effort cleanup", async () => {
    const state = new UpdateTransactionState();
    const generation = state.beginCheck();
    state.commitCheck(generation, "1.1.0", "a".repeat(64));
    const snapshot = state.beginDownload();
    const original = new Error("filesystem setup failed");
    const order: string[] = [];

    const result = runDownloadOperation({
      state,
      snapshot,
      operation: async () => {
        throw original;
      },
      onCurrentFailure: () => {
        expect(state.isDownloading).toBe(false);
        order.push("reported");
        throw new Error("reporting failed");
      },
      cleanup: () => {
        expect(state.isDownloading).toBe(false);
        order.push("cleaned");
        throw new Error("cleanup failed");
      },
    });

    await expect(result).rejects.toBe(original);
    expect(order).toEqual(["reported", "cleaned"]);
    expect(() => state.beginCheck()).not.toThrow();
  });
});
