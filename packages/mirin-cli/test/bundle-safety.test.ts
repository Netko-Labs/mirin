import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLinuxBundle } from "../src/bundle/linux/app.ts";
import { buildAppBundle } from "../src/bundle/macos/app.ts";
import { buildWindowsBundle } from "../src/bundle/windows/app.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("bundle sink validation", () => {
  test("Windows rejects an invalid id before removing an existing app folder", async () => {
    const paths = fixture("Safe App");
    await expect(
      buildWindowsBundle({
        ...paths.common,
        appName: "Safe App",
        bundleId: "dev..unsafe",
        version: "1.2.3",
        channel: "stable",
        coreDll: paths.core,
        codecBin: paths.codec,
        helperExe: paths.helper,
      }),
    ).rejects.toThrow("invalid app id");
    expect(existsSync(paths.sentinel)).toBe(true);
  });

  test("Linux rejects an invalid channel before removing an existing app folder", async () => {
    const paths = fixture("Safe App");
    await expect(
      buildLinuxBundle({
        ...paths.common,
        appName: "Safe App",
        bundleId: "dev.example.safe-app",
        version: "1.2.3",
        channel: "../beta",
        coreDll: paths.core,
        codecBin: paths.codec,
        helperExe: paths.helper,
      }),
    ).rejects.toThrow("invalid release channel");
    expect(existsSync(paths.sentinel)).toBe(true);
  });

  test("macOS rejects an invalid version before removing an existing app bundle", async () => {
    const paths = fixture("Safe App.app");
    await expect(
      buildAppBundle({
        ...paths.common,
        appName: "Safe App",
        bundleId: "dev.example.safe-app",
        version: "1.2",
        channel: "stable",
        coreDylib: paths.core,
        codecBin: paths.codec,
        helperBin: paths.helper,
      }),
    ).rejects.toThrow("invalid app version");
    expect(existsSync(paths.sentinel)).toBe(true);
  });

  test("rejects path-bearing extra names before removing the app folder", async () => {
    const paths = fixture("Safe App");
    const sidecar = join(paths.root, "sidecar");
    writeFileSync(sidecar, "sidecar");

    await expect(
      buildWindowsBundle({
        ...paths.common,
        appName: "Safe App",
        bundleId: "dev.example.safe-app",
        version: "1.2.3",
        channel: "stable",
        coreDll: paths.core,
        codecBin: paths.codec,
        helperExe: paths.helper,
        resources: { sidecars: [{ name: "../escape", src: sidecar }] },
      }),
    ).rejects.toThrow("invalid sidecar name");
    expect(existsSync(paths.sentinel)).toBe(true);
  });

  test("rejects case-insensitive extra collisions before removing the app folder", async () => {
    const paths = fixture("Safe App");
    const sidecar = join(paths.root, "sidecar");
    writeFileSync(sidecar, "sidecar");

    await expect(
      buildWindowsBundle({
        ...paths.common,
        appName: "Safe App",
        bundleId: "dev.example.safe-app",
        version: "1.2.3",
        channel: "stable",
        coreDll: paths.core,
        codecBin: paths.codec,
        helperExe: paths.helper,
        resources: {
          sidecars: [
            { name: "Tool", src: sidecar },
            { name: "tool", src: sidecar },
          ],
        },
      }),
    ).rejects.toThrow("duplicate sidecar name");
    expect(existsSync(paths.sentinel)).toBe(true);
  });

  test("rejects a symlink or junction output root and preserves its sentinel", async () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-bundle-output-"));
    temporaryDirectories.push(root);
    const outside = mkdtempSync(join(tmpdir(), "mirin-bundle-outside-"));
    temporaryDirectories.push(outside);
    const sentinel = join(outside, "keep.txt");
    writeFileSync(sentinel, "keep");
    const outDir = join(root, "out");
    symlinkSync(outside, outDir, process.platform === "win32" ? "junction" : "dir");
    const cefPath = join(root, "cef");
    mkdirSync(join(cefPath, "locales"), { recursive: true });
    writeFileSync(join(cefPath, "libcef.dll"), "cef");
    const host = join(root, "host");
    const core = join(root, "core");
    const helper = join(root, "helper");
    const codec = join(root, "codec");
    writeFileSync(host, "host");
    writeFileSync(core, "core");
    writeFileSync(helper, "helper");
    writeFileSync(codec, "codec");

    await expect(
      buildWindowsBundle({
        projectDir: root,
        outDir,
        appName: "Safe App",
        bundleId: "dev.example.safe-app",
        version: "1.2.3",
        channel: "stable",
        hostExe: host,
        coreDll: core,
        codecBin: codec,
        helperExe: helper,
        cefPath,
      }),
    ).rejects.toThrow("symlink or reparse point");
    expect(existsSync(sentinel)).toBe(true);
  });

  test("rejects an icon outside the project before removing the app folder", async () => {
    const paths = fixture("Safe App");
    const outside = mkdtempSync(join(tmpdir(), "mirin-bundle-icon-outside-"));
    temporaryDirectories.push(outside);
    const icon = join(outside, "icon.png");
    writeFileSync(icon, "png");

    await expect(
      buildWindowsBundle({
        ...paths.common,
        appName: "Safe App",
        bundleId: "dev.example.safe-app",
        version: "1.2.3",
        channel: "stable",
        coreDll: paths.core,
        codecBin: paths.codec,
        helperExe: paths.helper,
        icon,
      }),
    ).rejects.toThrow("escapes the project root");
    expect(existsSync(paths.sentinel)).toBe(true);
  });
});

function fixture(appDirectoryName: string): {
  root: string;
  core: string;
  codec: string;
  helper: string;
  sentinel: string;
  common: {
    projectDir: string;
    outDir: string;
    hostExe: string;
    codecBin: string;
    cefPath: string;
  };
} {
  const root = mkdtempSync(join(tmpdir(), "mirin-bundle-safety-"));
  temporaryDirectories.push(root);
  const outDir = join(root, "out");
  const app = join(outDir, appDirectoryName);
  mkdirSync(app, { recursive: true });
  const sentinel = join(app, "keep.txt");
  writeFileSync(sentinel, "keep");
  const host = join(root, "host");
  const core = join(root, "core");
  const codec = join(root, "codec");
  const helper = join(root, "helper");
  writeFileSync(host, "host");
  writeFileSync(core, "core");
  writeFileSync(codec, "codec");
  writeFileSync(helper, "helper");
  return {
    root,
    core,
    codec,
    helper,
    sentinel,
    common: {
      projectDir: root,
      outDir,
      hostExe: host,
      codecBin: codec,
      cefPath: join(root, "missing-cef"),
    },
  };
}
