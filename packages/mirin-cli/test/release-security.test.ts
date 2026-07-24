import { afterEach, describe, expect, test } from "bun:test";
import { validateReleaseChannel } from "../src/release/channel.ts";
import {
  fetchTrustedReleaseUrl,
  parsePreviousReleaseManifest,
  readPreviousReleaseManifest,
  releaseArtifactUrl,
  trustedReleaseBaseUrl,
} from "../src/release/previous.ts";
import { validateReleaseVersion } from "../src/release/semver.ts";
import {
  assertDeltaSourcesFitMemoryBudget,
  MAX_RELEASE_DELTA_SOURCE_BYTES,
  settleConcurrentReleaseTask,
  validateReleaseManifestBytes,
} from "../src/release.ts";

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
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("release channel validation", () => {
  test("accepts safe dotted channels and rejects path-like punctuation", () => {
    expect(validateReleaseChannel("beta.preview-2")).toBe("beta.preview-2");
    expect(() => validateReleaseChannel("../beta")).toThrow("safe channel name");
    expect(() => validateReleaseChannel("beta..preview")).toThrow("safe channel name");
    expect(() => validateReleaseChannel("stable.")).toThrow("safe channel name");
    expect(() => validateReleaseChannel("NUL")).toThrow("safe channel name");
    expect(() => validateReleaseChannel("con.preview")).toThrow("safe channel name");
  });
});

describe("release version validation", () => {
  test("matches the strict SemVer grammar consumed by the updater", () => {
    expect(validateReleaseVersion("1.2.3-beta.1+build.5")).toBe("1.2.3-beta.1+build.5");
    expect(() => validateReleaseVersion("v1.2.3")).toThrow("strict SemVer");
    expect(() => validateReleaseVersion("1.2.3-beta.01")).toThrow("strict SemVer");
  });
});

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

  test("requires legacy manifests to declare a reconstructed tar no larger than 8 GiB", () => {
    const { tarSize: _tarSize, ...legacy } = manifest;
    expect(() => parsePreviousReleaseManifest(legacy, expected)).toThrow(
      "invalid previous tar size",
    );
    const threeGiB = 3 * 1024 * 1024 * 1024;
    expect(parsePreviousReleaseManifest({ ...manifest, tarSize: threeGiB }, expected).tarSize).toBe(
      threeGiB,
    );
    expect(() =>
      parsePreviousReleaseManifest({ ...manifest, tarSize: 8 * 1024 * 1024 * 1024 + 1 }, expected),
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

  test("rejects an HTTP redirect hop before requesting it", async () => {
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      requested.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: "http://releases.example.com/manifest" },
      });
    };

    await expect(fetchTrustedReleaseUrl("https://releases.example.com/start")).rejects.toThrow(
      "must use HTTPS",
    );
    expect(requested).toEqual(["https://releases.example.com/start"]);
  });

  test("aborts a release request that exceeds its deadline", async () => {
    globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing abort signal"));
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });

    await expect(
      fetchTrustedReleaseUrl("https://releases.example.com/stalled", { timeoutMs: 10 }),
    ).rejects.toThrow();
  });
});

describe("release delta memory budget", () => {
  test("accepts bounded sources and rejects a source that would overcommit bsdiff", () => {
    expect(() =>
      assertDeltaSourcesFitMemoryBudget(
        MAX_RELEASE_DELTA_SOURCE_BYTES,
        MAX_RELEASE_DELTA_SOURCE_BYTES,
      ),
    ).not.toThrow();
    expect(() => assertDeltaSourcesFitMemoryBudget(MAX_RELEASE_DELTA_SOURCE_BYTES + 1, 1)).toThrow(
      "in-memory codec limit",
    );
  });
});

describe("release manifest output bounds", () => {
  test("matches the runtime's 256 KiB response ceiling before signing", () => {
    expect(() => validateReleaseManifestBytes(new Uint8Array(256 * 1024))).not.toThrow();
    expect(() => validateReleaseManifestBytes(new Uint8Array(256 * 1024 + 1))).toThrow(
      "release manifest exceeds",
    );
  });
});

describe("parallel release work", () => {
  test("observes installer rejection immediately as an always-settled result", async () => {
    const failure = new Error("installer failed");
    const rejected = settleConcurrentReleaseTask(Promise.reject(failure));
    const fulfilled = settleConcurrentReleaseTask(Promise.resolve("installer"));

    await Bun.sleep(10);
    expect(await rejected).toEqual({ status: "rejected", reason: failure });
    expect(await fulfilled).toEqual({ status: "fulfilled", value: "installer" });
  });
});
