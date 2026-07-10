import { describe, expect, test } from "bun:test";
import {
  parsePreviousReleaseManifest,
  releaseArtifactUrl,
  trustedReleaseBaseUrl,
} from "../src/release/previous.ts";

const expected = { channel: "stable", platform: "linux", arch: "x64" };
const manifest = {
  version: "1.2.3-beta.1",
  channel: "stable",
  platform: "linux",
  arch: "x64",
  bundle: {
    url: "stable-linux-x64-Anko.app.tar.zst",
    sha256: "a".repeat(64),
    size: 42,
  },
};

describe("previous release validation", () => {
  test("accepts a matching, bounded release manifest", () => {
    expect(parsePreviousReleaseManifest(manifest, expected)).toEqual({
      version: manifest.version,
      bundle: manifest.bundle,
    });
  });

  test("rejects target drift and path-bearing remote values", () => {
    expect(() =>
      parsePreviousReleaseManifest({ ...manifest, platform: "darwin" }, expected),
    ).toThrow("target mismatch");
    expect(() =>
      parsePreviousReleaseManifest({ ...manifest, version: "../../escape" }, expected),
    ).toThrow("invalid previous update version");
    expect(() =>
      parsePreviousReleaseManifest(
        { ...manifest, bundle: { ...manifest.bundle, url: "../bundle.tar.zst" } },
        expected,
      ),
    ).toThrow("unsafe previous update artifact name");
  });

  test("requires HTTPS except for explicit loopback testing", () => {
    expect(trustedReleaseBaseUrl("https://example.com/releases/latest/download/")).toBe(
      "https://example.com/releases/latest/download",
    );
    expect(trustedReleaseBaseUrl("http://localhost:4000")).toBe("http://localhost:4000");
    expect(() => trustedReleaseBaseUrl("http://example.com/releases")).toThrow("must use HTTPS");
    expect(() => releaseArtifactUrl("https://example.com", "nested/file")).toThrow(
      "unsafe previous update artifact name",
    );
  });
});
