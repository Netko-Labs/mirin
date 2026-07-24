import { describe, expect, test } from "bun:test";
import { macBundleVersion } from "../src/bundle/macos/app.ts";

describe("macOS bundle version metadata", () => {
  test.each([
    ["1.2.3", "1.2.3"],
    ["1.2.3-beta.1+build.5", "1.2.3"],
    ["0.0.0-preview", "0.0.0"],
  ])("maps %s to Apple's numeric format", (version, expected) => {
    expect(macBundleVersion(version)).toBe(expected);
  });

  test("rejects a value without a numeric SemVer core", () => {
    expect(() => macBundleVersion("preview")).toThrow("invalid app version");
  });
});
