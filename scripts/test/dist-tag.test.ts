import { describe, expect, test } from "bun:test";
import { distTagForVersion } from "../lib/dist-tag.ts";

describe("distTagForVersion", () => {
  test.each([
    ["1.2.3", "latest"],
    ["1.2.3-alpha.15", "alpha"],
    ["1.2.3-beta.2", "beta"],
    ["1.2.3-rc.1", "rc"],
    ["1.2.3-preview.4", "next"],
  ])("maps %s to %s", (version, expected) => {
    expect(distTagForVersion(version)).toBe(expected);
  });

  test("rejects invalid versions", () => {
    expect(() => distTagForVersion("v1.2.3")).toThrow("invalid package version");
  });
});
