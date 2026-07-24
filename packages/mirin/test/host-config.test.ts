import { describe, expect, test } from "bun:test";
import { resolveHostSingleInstance } from "../src/host-config.ts";
import { hasExclusiveUpdaterCapability } from "../src/runtime.ts";
import { EXCLUSIVE_UPDATER_CAPABILITY, HOST_RUNTIME_PROTOCOL } from "../src/update-handoff.ts";

describe("native host single-instance resolution", () => {
  test("passes the effective native override to the Worker", () => {
    expect(resolveHostSingleInstance(undefined, undefined)).toBe(true);
    expect(resolveHostSingleInstance(true, true)).toBe(true);
    expect(resolveHostSingleInstance(false, true)).toBe(false);
    expect(resolveHostSingleInstance(true, false)).toBe(false);
    expect(resolveHostSingleInstance(undefined, false)).toBe(false);
  });

  test("requires an explicit versioned positive updater capability", () => {
    expect(hasExclusiveUpdaterCapability({})).toBe(false);
    expect(
      hasExclusiveUpdaterCapability({
        runtimeProtocol: HOST_RUNTIME_PROTOCOL,
      }),
    ).toBe(false);
    expect(
      hasExclusiveUpdaterCapability({
        runtimeProtocol: HOST_RUNTIME_PROTOCOL - 1,
        updaterApplyCapability: EXCLUSIVE_UPDATER_CAPABILITY,
      }),
    ).toBe(false);
    expect(
      hasExclusiveUpdaterCapability({
        runtimeProtocol: HOST_RUNTIME_PROTOCOL,
        updaterApplyCapability: EXCLUSIVE_UPDATER_CAPABILITY,
      }),
    ).toBe(true);
  });
});
