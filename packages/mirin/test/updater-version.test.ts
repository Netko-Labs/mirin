import { describe, expect, test } from "bun:test";
import { compareVersions, isNewerVersion } from "../src/updater/lib/version.ts";

describe("compareVersions", () => {
  test("orders numeric segments numerically, not lexically", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.1.2", "0.1.2")).toBe(0);
  });

  test("treats a missing segment as zero and ignores a leading v and build metadata", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("v1.2.1", "1.2.0+abc")).toBeGreaterThan(0);
  });

  test("sorts a prerelease below its release and prereleases among themselves", () => {
    expect(compareVersions("0.2.0-nightly.1", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("0.2.0-nightly.2", "0.2.0-nightly.10")).toBeLessThan(0);
    expect(compareVersions("0.2.0-nightly.1", "0.1.9")).toBeGreaterThan(0);
  });
});

describe("isNewerVersion", () => {
  test("only a strictly newer manifest counts as an update", () => {
    expect(isNewerVersion("0.1.2", "0.1.1")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(false);
    expect(isNewerVersion("0.1.1", "0.1.1")).toBe(false);
  });
});
