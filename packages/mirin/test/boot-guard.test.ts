import { afterEach, describe, expect, test } from "bun:test";
import { claimBootSlot } from "../src/runtime.ts";

const BOOT_SLOT = Symbol.for("mirinjs.runtime.booted");

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[BOOT_SLOT];
});

describe("claimBootSlot", () => {
  test("first claim wins, second is refused", () => {
    expect(claimBootSlot()).toBe(true);
    expect(claimBootSlot()).toBe(false);
  });

  test("uses the cross-copy Symbol.for namespace", () => {
    // A duplicate mirinjs copy has its own module state but shares globalThis;
    // the marker must be visible through Symbol.for, not a module symbol.
    (globalThis as Record<symbol, unknown>)[Symbol.for("mirinjs.runtime.booted")] = true;
    expect(claimBootSlot()).toBe(false);
  });
});
