import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLinuxBundle } from "../src/bundle/linux/app.ts";
import { normalizeSidecars, normalizeWorkers, safeExtraAssetName } from "../src/extras.ts";
import { copyProjectFile } from "../src/shared/fs/project-source.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("extra source containment", () => {
  test("canonicalizes contained files and rejects symlink escapes", () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "tool"), "tool");
    writeFileSync(join(outside, "outside"), "outside");
    symlinkSync(join(outside, "outside"), join(root, "bin", "escape"));

    expect(normalizeSidecars(root, { tool: "bin/tool" })[0]?.src).toBe(
      realpathSync(join(root, "bin", "tool")),
    );
    expect(() => normalizeSidecars(root, { escape: "bin/escape" })).toThrow(
      "escapes the project root",
    );
    expect(() => normalizeWorkers(root, { escape: "bin/escape" })).toThrow(
      "escapes the project root",
    );
  });

  test("rejects missing files and directories", () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, "directory"));

    expect(() => normalizeSidecars(root, { missing: "missing" })).toThrow("does not exist");
    expect(() => normalizeSidecars(root, { directory: "directory" })).toThrow(
      "must be a regular file",
    );
    expect(() => normalizeWorkers(root, { directory: "directory" })).toThrow(
      "must be a regular file",
    );
  });

  if (process.platform !== "win32") {
    test("rejects special files", () => {
      const root = temporaryDirectory();
      const fifo = join(root, "events.pipe");
      const result = Bun.spawnSync({ cmd: ["mkfifo", fifo] });
      expect(result.exitCode).toBe(0);
      expect(() => normalizeSidecars(root, { events: "events.pipe" })).toThrow(
        "must be a regular file",
      );
    });
  }

  test("revalidates canonical containment immediately before copying", () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    const source = join(root, "tool");
    const destination = join(root, "copy");
    const external = join(outside, "external");
    writeFileSync(source, "inside");
    writeFileSync(external, "outside");
    const [sidecar] = normalizeSidecars(root, { tool: "tool" });
    if (!sidecar) throw new Error("expected normalized sidecar");

    rmSync(source);
    symlinkSync(external, source);

    expect(() => copyProjectFile(root, sidecar.src, destination, "sidecar tool")).toThrow(
      "escapes the project root",
    );
    expect(existsSync(destination)).toBe(false);
  });
});

describe("extra asset names", () => {
  test.each([
    "con",
    "prn",
    "aux",
    "nul",
    "NUL.txt",
    "COM1.exe",
    "lpt9.log",
    "trailing.",
    "nested/name",
    "nested\\name",
    "name:stream",
    "a".repeat(121),
  ])("rejects non-portable name %s", (name) => {
    expect(() => safeExtraAssetName(name, "asset name")).toThrow("invalid asset name");
  });

  test("rejects case-insensitive sidecar and worker collisions", () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "one"), "one");
    writeFileSync(join(root, "two"), "two");

    expect(() => normalizeSidecars(root, { Tool: "one", tool: "two" })).toThrow(
      "duplicate sidecar name",
    );
    expect(() => normalizeWorkers(root, { Worker: "one", worker: "two" })).toThrow(
      "duplicate worker name",
    );
  });
});

describe("sidecar bundle copies", () => {
  test("dereferences contained symlinks without changing source mode", async () => {
    const root = temporaryDirectory();
    const outDir = join(root, "out");
    const cefPath = join(root, "cef");
    const binDir = join(root, "bin");
    mkdirSync(join(cefPath, "locales"), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(join(cefPath, "libcef.so"), "cef");
    const host = join(root, "host");
    const core = join(root, "libmirin_core.so");
    const helper = join(root, "mirin-helper");
    const codec = join(root, "mirin-codec");
    writeFileSync(host, "host");
    writeFileSync(core, "core");
    writeFileSync(helper, "helper");
    writeFileSync(codec, "codec");

    const source = join(binDir, "tool");
    const link = join(binDir, "tool-link");
    writeFileSync(source, "sidecar");
    chmodSync(source, 0o640);
    symlinkSync("tool", link);
    const [sidecar] = normalizeSidecars(root, { tool: "bin/tool-link" });
    if (!sidecar) throw new Error("expected normalized sidecar");

    const { app } = await buildLinuxBundle({
      appName: "Safe App",
      bundleId: "dev.example.safe-app",
      version: "1.2.3",
      channel: "stable",
      projectDir: root,
      outDir,
      hostExe: host,
      coreDll: core,
      codecBin: codec,
      helperExe: helper,
      cefPath,
      resources: { sidecars: [sidecar] },
    });

    const bundled = join(app, "resources", "sidecars", "tool");
    const bundledCodec = join(app, "mirin-codec");
    expect(lstatSync(bundled).isFile()).toBe(true);
    expect(lstatSync(bundled).isSymbolicLink()).toBe(false);
    expect(statSync(source).mode & 0o777).toBe(0o640);
    expect(statSync(bundled).mode & 0o777).toBe(0o755);
    expect(lstatSync(bundledCodec).isFile()).toBe(true);
    expect(statSync(bundledCodec).mode & 0o777).toBe(0o755);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mirin-extras-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
