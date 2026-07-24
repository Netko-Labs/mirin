import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateScaffoldName } from "create-mirinjs";
import { build } from "../src/build.ts";
import { dev } from "../src/dev.ts";
import { resolveProjectIcon } from "../src/shared/fs/project-source.ts";
import {
  DEFAULT_APP_VERSION,
  resolveAppVersion,
  validateAppIdentity,
  validateAppName,
  validateAppVersion,
  validateBundleId,
  validateReleaseChannel,
  validateReleaseNotes,
} from "../src/shared/validation/config.ts";

const temporaryDirectories: string[] = [];
const originalVersionOverride = process.env.MIRIN_APP_VERSION;

afterEach(() => {
  if (originalVersionOverride == null) delete process.env.MIRIN_APP_VERSION;
  else process.env.MIRIN_APP_VERSION = originalVersionOverride;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CLI app identity validation", () => {
  test("accepts portable names, reverse-DNS ids, flat channels, and strict SemVer", () => {
    expect(
      validateAppIdentity({
        appName: "Mirin App (Beta)",
        bundleId: "dev.example.mirin-app",
        channel: "beta.1",
        version: "1.2.3-beta.1+build.5",
      }),
    ).toEqual({
      appName: "Mirin App (Beta)",
      bundleId: "dev.example.mirin-app",
      channel: "beta.1",
      version: "1.2.3-beta.1+build.5",
    });
  });

  test.each(["../escape", "nested/name", "nested\\name", "CON", "NUL.txt", "trailing.", " app"])(
    "rejects unsafe app name %s",
    (value) => expect(() => validateAppName(value)).toThrow("invalid app name"),
  );

  test.each(["single", "dev..app", "dev.-app", "dev.app-", "con.example"])(
    "rejects unsafe app id %s",
    (value) => expect(() => validateBundleId(value)).toThrow("invalid app id"),
  );

  test("bounds app ids below portable filesystem component limits", () => {
    const maximum = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(41)}`;
    const tooLong = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(42)}`;
    expect(maximum).toHaveLength(233);
    expect(tooLong).toHaveLength(234);
    expect(validateBundleId(maximum)).toBe(maximum);
    expect(() => validateBundleId(tooLong)).toThrow("up to 233 total characters");
  });

  test.each([
    "../beta",
    "nested/beta",
    "NUL",
    "beta.",
    "beta_",
    "beta..preview",
    "beta--preview",
    "space channel",
  ])("rejects unsafe release channel %s", (value) =>
    expect(() => validateReleaseChannel(value)).toThrow("invalid release channel"),
  );

  test.each(["1", "1.2", "01.2.3", "1.2.3-01", "v1.2.3", "1.2.3/"])(
    "rejects non-strict version %s",
    (value) => expect(() => validateAppVersion(value)).toThrow("invalid app version"),
  );

  test.each(["a", "app1", "my-app", "a1-b2-c3", "a".repeat(63)])(
    "accepts scaffold name %s as a CLI app name",
    (value) => expect(validateAppName(validateScaffoldName(value))).toBe(value),
  );

  test("uses a macOS-compatible version when package.json omits one", () => {
    delete process.env.MIRIN_APP_VERSION;
    const root = project({});
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "safe-app" })}\n`);

    expect(resolveAppVersion(root)).toBe(DEFAULT_APP_VERSION);
    expect(DEFAULT_APP_VERSION).toBe("1.0.0");
  });

  test("bounds release notes to the runtime manifest contract", () => {
    expect(validateReleaseNotes("x".repeat(64 * 1024))).toHaveLength(64 * 1024);
    expect(() => validateReleaseNotes("x".repeat(64 * 1024 + 1))).toThrow("invalid release notes");
  });
});

describe("build and dev preflight", () => {
  test.each([
    ["name", "../escape"],
    ["id", "dev..escape"],
    ["channel", "../beta"],
    ["version", "1.2"],
  ] as const)("rejects invalid %s before touching sentinel files", async (field, value) => {
    delete process.env.MIRIN_APP_VERSION;
    const root = project({ [field]: value });
    const stale = join(root, ".keep.bun-build");
    const buildSentinel = join(root, "build", "keep.txt");
    const workSentinel = join(root, ".mirin", "keep.txt");
    writeFileSync(stale, "keep");
    mkdirSync(join(root, "build"), { recursive: true });
    mkdirSync(join(root, ".mirin"), { recursive: true });
    writeFileSync(buildSentinel, "keep");
    writeFileSync(workSentinel, "keep");

    await expect(build(root)).rejects.toThrow(
      `invalid ${field === "id" ? "app id" : field === "channel" ? "release channel" : field === "version" ? "app version" : "app name"}`,
    );
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(buildSentinel)).toBe(true);
    expect(existsSync(workSentinel)).toBe(true);
  });

  test("rejects unsafe release metadata before touching sentinel files", async () => {
    delete process.env.MIRIN_APP_VERSION;
    const root = project({ baseUrl: "http://example.com/releases" });
    const stale = join(root, ".release.bun-build");
    writeFileSync(stale, "keep");

    await expect(build(root)).rejects.toThrow("must use HTTPS");
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(join(root, "build"))).toBe(false);
    expect(existsSync(join(root, ".mirin"))).toBe(false);
  });

  test("rejects oversized release notes before touching output", async () => {
    delete process.env.MIRIN_APP_VERSION;
    const root = project({ notes: "x".repeat(64 * 1024 + 1) });

    await expect(build(root)).rejects.toThrow("invalid release notes");
    expect(existsSync(join(root, "build"))).toBe(false);
    expect(existsSync(join(root, ".mirin"))).toBe(false);
  });

  test("dev rejects invalid identity before creating or sweeping .mirin", async () => {
    delete process.env.MIRIN_APP_VERSION;
    const root = project({ id: "not-reverse-dns" });
    const stale = join(root, ".dev.bun-build");
    writeFileSync(stale, "keep");

    await expect(dev(root)).rejects.toThrow("invalid app id");
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(join(root, ".mirin"))).toBe(false);
  });
});

describe("app icon source validation", () => {
  test("rejects an icon outside the project", () => {
    const root = project({});
    const outside = mkdtempSync(join(tmpdir(), "mirin-icon-outside-"));
    temporaryDirectories.push(outside);
    const icon = join(outside, "icon.png");
    writeFileSync(icon, "png");

    expect(() => resolveProjectIcon(root, icon, "app icon")).toThrow("relative to the project");
  });

  test("rejects symlinked files inside an iconset", () => {
    const root = project({});
    const outside = mkdtempSync(join(tmpdir(), "mirin-iconset-outside-"));
    temporaryDirectories.push(outside);
    const externalPng = join(outside, "icon.png");
    writeFileSync(externalPng, "png");
    const iconset = join(root, "app.iconset");
    mkdirSync(iconset);
    symlinkSync(externalPng, join(iconset, "icon_256x256.png"), "file");

    expect(() => resolveProjectIcon(root, "app.iconset", "app icon")).toThrow(
      "must contain only regular files",
    );
  });
});

function project(overrides: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mirin-config-test-"));
  temporaryDirectories.push(root);
  const config = {
    id: overrides.id ?? "dev.example.safe-app",
    name: overrides.name ?? "Safe App",
    main: "main/main.ts",
    windows: {},
    release: {
      channel: overrides.channel ?? "stable",
      ...(overrides.baseUrl === undefined ? {} : { baseUrl: overrides.baseUrl }),
      ...(overrides.notes === undefined ? {} : { notes: overrides.notes }),
    },
  };
  writeFileSync(join(root, "mirin.config.ts"), `export default ${JSON.stringify(config)};\n`);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "safe-app", version: overrides.version ?? "1.2.3" })}\n`,
  );
  mkdirSync(join(root, "main"));
  writeFileSync(join(root, "main", "main.ts"), "export {};\n");
  return root;
}
