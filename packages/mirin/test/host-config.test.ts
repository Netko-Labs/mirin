import { describe, expect, test } from "bun:test";
import { resolveHostSingleInstance } from "../src/host-config.ts";

describe("native host single-instance resolution", () => {
  test("passes the effective native override to the Worker", () => {
    expect(resolveHostSingleInstance(undefined, undefined)).toBe(true);
    expect(resolveHostSingleInstance(true, true)).toBe(true);
    expect(resolveHostSingleInstance(false, true)).toBe(false);
    expect(resolveHostSingleInstance(true, false)).toBe(false);
    expect(resolveHostSingleInstance(undefined, false)).toBe(false);
  });
});
