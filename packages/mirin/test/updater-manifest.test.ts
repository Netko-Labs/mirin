import { describe, expect, test } from "bun:test";
import { parseManifest } from "../src/updater/lib/manifest.ts";

const expected = { channel: "stable", platform: "darwin", arch: "arm64" };
const manifest = {
  version: "1.2.3",
  ...expected,
  tarHash: "a".repeat(64),
  tarSize: 4096,
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

  test("accepts bounded patches and markdown release notes", () => {
    const value = {
      ...manifest,
      body: "## Notes\n- **Fixed** things",
      patches: [
        {
          fromVersion: "1.2.2",
          url: "stable-darwin-arm64-1.2.2.patch",
          sha256: "c".repeat(64),
          size: 500,
          uncompressedSize: 900,
        },
      ],
    };
    expect(parseManifest(value, expected)).toEqual(value);
  });

  test("rejects invalid SemVer and path-bearing artifact names", () => {
    expect(() => parseManifest({ ...manifest, version: "1.2.3-beta.01" }, expected)).toThrow(
      "invalid update manifest version",
    );
    expect(() =>
      parseManifest(
        { ...manifest, bundle: { ...manifest.bundle, url: "../bundle.tar.zst" } },
        expected,
      ),
    ).toThrow("unsafe update artifact name");
  });

  test("requires compressed, patch, and reconstructed-output bounds", () => {
    const { size: _size, ...bundleWithoutSize } = manifest.bundle;
    expect(() => parseManifest({ ...manifest, bundle: bundleWithoutSize }, expected)).toThrow(
      "invalid update manifest field: size",
    );
    const { tarSize: _tarSize, ...withoutTarSize } = manifest;
    expect(() => parseManifest(withoutTarSize, expected)).toThrow(
      "invalid update manifest field: tarSize",
    );
    expect(() =>
      parseManifest(
        {
          ...manifest,
          patches: [
            {
              fromVersion: "1.2.2",
              url: "patch.zst",
              sha256: "c".repeat(64),
              size: 12,
            },
          ],
        },
        expected,
      ),
    ).toThrow("invalid update manifest field: uncompressedSize");
  });

  test("allows existing multi-gigabyte tars and rejects values above 8 GiB", () => {
    const threeGiB = 3 * 1024 * 1024 * 1024;
    expect(parseManifest({ ...manifest, tarSize: threeGiB }, expected).tarSize).toBe(threeGiB);
    expect(() =>
      parseManifest(
        { ...manifest, bundle: { ...manifest.bundle, size: 513 * 1024 * 1024 } },
        expected,
      ),
    ).toThrow("invalid update manifest field: size");
    expect(() =>
      parseManifest({ ...manifest, tarSize: 8 * 1024 * 1024 * 1024 + 1 }, expected),
    ).toThrow("invalid update manifest field: tarSize");
  });
});
