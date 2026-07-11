import { describe, expect, test } from "bun:test";
import { parseManifest } from "../src/updater/lib/manifest.ts";

const expected = { channel: "stable", platform: "darwin", arch: "arm64" };
const manifest = {
  version: "1.2.3",
  ...expected,
  tarHash: "a".repeat(64),
  bundle: {
    url: "stable-darwin-arm64-Anko.app.tar.zst",
    sha256: "b".repeat(64),
    size: 1024,
  },
  patches: [],
};

describe("updater manifest validation", () => {
  test("accepts a bounded manifest for the running target", () => {
    expect(parseManifest(manifest, expected)).toEqual(manifest);
  });

  test("accepts markdown release notes", () => {
    expect(parseManifest({ ...manifest, body: "## Notes\n- **Fixed** things" }, expected)).toEqual({
      ...manifest,
      body: "## Notes\n- **Fixed** things",
    });
  });

  test("rejects path-bearing versions and artifact names", () => {
    expect(() => parseManifest({ ...manifest, version: "../../escape" }, expected)).toThrow(
      "invalid update manifest version",
    );
    expect(() =>
      parseManifest(
        { ...manifest, bundle: { ...manifest.bundle, url: "../bundle.tar.zst" } },
        expected,
      ),
    ).toThrow("unsafe update artifact name");
  });

  test("rejects artifacts larger than the updater limit", () => {
    expect(() =>
      parseManifest(
        { ...manifest, bundle: { ...manifest.bundle, size: 9 * 1024 * 1024 * 1024 } },
        expected,
      ),
    ).toThrow("invalid update manifest field: size");
  });
});
