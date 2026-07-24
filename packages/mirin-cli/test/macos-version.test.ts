import { describe, expect, test } from "bun:test";
import { macBundleVersions } from "../src/bundle/macos/app.ts";

describe("macOS bundle version metadata", () => {
  test.each([
    ["1.2.3", { shortVersion: "1.2.3", buildVersion: "1.2.3" }],
    ["1.2.3-beta.1+build.5", { shortVersion: "1.2.3", buildVersion: "1.2.3b1" }],
    ["1.2.3-preview.255", { shortVersion: "1.2.3", buildVersion: "1.2.3d255" }],
    ["9999.99.99-rc", { shortVersion: "9999.99.99", buildVersion: "9999.99.99fc1" }],
  ])("maps %s to Apple's marketing and build formats", (version, expected) => {
    expect(macBundleVersions(version)).toEqual(expected);
  });

  test.each([
    "preview",
    "0.1.0",
    "10000.1.1",
    "1.100.1",
    "1.1.100",
    "1.2.3-canary.1",
    "1.2.3-beta.0",
    "1.2.3-beta.256",
  ])("rejects %s when it cannot produce valid Apple metadata", (version) => {
    expect(() => macBundleVersions(version)).toThrow("macOS");
  });
});
