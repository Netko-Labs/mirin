import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareSemVer, isStrictlyNewer, parseSemVer } from "../src/updater/lib/semver.ts";
import {
  parseVersionInfo,
  parseVersionJson,
  readVersionJsonFile,
} from "../src/updater/lib/version.ts";
import { stableMacCodeRequirement } from "../src/updater/updater.ts";

const installed = {
  version: "1.2.3",
  channel: "stable",
  baseUrl: "https://updates.example.com/",
  publicKey: "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
  name: "Mirin App",
  identifier: "com.example.mirin",
};
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("updater SemVer ordering", () => {
  test("implements SemVer precedence and ignores build metadata", () => {
    expect(compareSemVer("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareSemVer("1.0.0-beta.11", "1.0.0-rc.1")).toBeLessThan(0);
    expect(compareSemVer("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareSemVer("1.2.3+build.2", "1.2.3+build.1")).toBe(0);
    expect(isStrictlyNewer("1.2.4", "1.2.3")).toBe(true);
    expect(isStrictlyNewer("1.2.2", "1.2.3")).toBe(false);
  });

  test("rejects invalid numeric and prerelease identifiers", () => {
    expect(() => parseSemVer("01.2.3")).toThrow("invalid SemVer");
    expect(() => parseSemVer("1.2.3-beta.01")).toThrow("invalid SemVer");
    expect(() => parseSemVer("1.2.3-beta..1")).toThrow("invalid SemVer");
  });
});

describe("installed updater metadata", () => {
  test("parses and normalizes the signed version identity with safe dotted channels", () => {
    expect(parseVersionInfo({ ...installed, channel: "beta.preview-2" })).toEqual({
      ...installed,
      channel: "beta.preview-2",
      baseUrl: "https://updates.example.com",
    });
  });

  test("fails closed for malformed path and identity fields", () => {
    expect(() => parseVersionInfo({ ...installed, name: "../Mirin" })).toThrow(
      "invalid installed version field: name",
    );
    expect(() => parseVersionInfo({ ...installed, channel: "../stable" })).toThrow(
      "invalid installed version field: channel",
    );
    expect(() => parseVersionInfo({ ...installed, channel: "beta..preview" })).toThrow(
      "invalid installed version field: channel",
    );
    expect(() => parseVersionInfo({ ...installed, channel: "stable." })).toThrow(
      "invalid installed version field: channel",
    );
    expect(() => parseVersionInfo({ ...installed, channel: "NUL" })).toThrow(
      "invalid installed version field: channel",
    );
    expect(() => parseVersionInfo({ ...installed, identifier: "com..mirin" })).toThrow(
      "invalid installed version field: identifier",
    );
    expect(() => parseVersionInfo({ ...installed, publicKey: "not-base64" })).toThrow(
      "invalid installed version field: publicKey",
    );
    expect(() => parseVersionInfo({ ...installed, version: "1.2" })).toThrow("invalid SemVer");
  });

  test("bounds and structurally parses version.json", () => {
    expect(parseVersionJson(JSON.stringify(installed)).version).toBe("1.2.3");
    expect(() => parseVersionJson("{")).toThrow("invalid installed version metadata JSON");
    expect(() => parseVersionJson(`{"padding":"${"x".repeat(20 * 1024)}"}`)).toThrow(
      "installed version metadata is too large",
    );
  });

  test("bounds version.json before allocating or decoding its contents", () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-version-test-"));
    temporaryDirectories.push(root);
    const path = join(root, "version.json");
    writeFileSync(path, JSON.stringify(installed));
    expect(readVersionJsonFile(path).version).toBe("1.2.3");

    writeFileSync(path, Buffer.alloc(20 * 1024, 0x20));
    expect(() => readVersionJsonFile(path)).toThrow("too large");
  });
});

describe("macOS update code identity", () => {
  test("pins stable requirements but permits a newly authenticated ad-hoc build", () => {
    expect(
      stableMacCodeRequirement(
        'designated => identifier "dev.example.app" and anchor apple generic',
      ),
    ).toBe('identifier "dev.example.app" and anchor apple generic');
    expect(
      stableMacCodeRequirement('# designated => cdhash H"abc" or cdhash H"def"'),
    ).toBeUndefined();
  });
});
