import { describe, expect, test } from "bun:test";
import {
  parsePreviousReleaseManifest,
  readPreviousReleaseManifest,
  releaseArtifactUrl,
  trustedReleaseBaseUrl,
} from "../src/release/previous.ts";

const expected = { channel: "stable", platform: "linux", arch: "x64" };
const manifest = {
  version: "1.2.3-beta.1",
  channel: "stable",
  platform: "linux",
  arch: "x64",
  tarSize: 100,
  bundle: {
    url: "stable-linux-x64-Anko.app.tar.zst",
    sha256: "a".repeat(64),
    size: 42,
  },
};

describe("previous release validation", () => {
  test("accepts a matching release manifest with compressed and tar bounds", () => {
    expect(parsePreviousReleaseManifest(manifest, expected)).toEqual({
      version: manifest.version,
      tarSize: manifest.tarSize,
      bundle: manifest.bundle,
    });
  });

  test("rejects target drift, invalid SemVer, and path-bearing remote values", () => {
    expect(() =>
      parsePreviousReleaseManifest({ ...manifest, platform: "darwin" }, expected),
    ).toThrow("target mismatch");
    expect(() =>
      parsePreviousReleaseManifest({ ...manifest, version: "1.2.3-beta.01" }, expected),
    ).toThrow("invalid previous update version");
    expect(() =>
      parsePreviousReleaseManifest(
        { ...manifest, bundle: { ...manifest.bundle, url: "../bundle.tar.zst" } },
        expected,
      ),
    ).toThrow("unsafe previous update artifact name");
  });

  test("requires legacy manifests to declare a bounded reconstructed tar size", () => {
    const { tarSize: _tarSize, ...legacy } = manifest;
    expect(() => parsePreviousReleaseManifest(legacy, expected)).toThrow(
      "invalid previous tar size",
    );
    expect(() =>
      parsePreviousReleaseManifest({ ...manifest, tarSize: 1024 * 1024 * 1024 + 1 }, expected),
    ).toThrow("invalid previous tar size");
  });

  test("bounds the previous manifest response before JSON parsing", async () => {
    await expect(
      readPreviousReleaseManifest(
        new Response("{}", { headers: { "content-length": String(256 * 1024 + 1) } }),
        expected,
      ),
    ).rejects.toThrow("manifest is too large");
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
