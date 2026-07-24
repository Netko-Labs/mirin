import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertRuntimePackageCompatibility,
  resolveCliPackageFile,
  validateArchiveEntries,
  validateExtractedSymlinks,
  verifyFileSha256,
} from "../src/artifacts.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CLI dependency resolution", () => {
  test("resolves runtime and native packages from the CLI directory under an unrelated cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-resolution-test-"));
    temporaryDirectories.push(root);
    const cliDir = join(root, "installed-cli", "src");
    const modules = join(root, "installed-cli", "node_modules");
    const runtime = join(modules, "mirinjs");
    const native = join(modules, "@mirinjs", "test-platform");
    mkdirSync(cliDir, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    mkdirSync(native, { recursive: true });
    writeFileSync(
      join(runtime, "package.json"),
      JSON.stringify({
        name: "mirinjs",
        version: "1.2.3",
        exports: { ".": "./index.ts", "./host": "./host.ts" },
      }),
    );
    writeFileSync(join(runtime, "index.ts"), "export {};\n");
    writeFileSync(join(runtime, "host.ts"), "export {};\n");
    writeFileSync(join(native, "package.json"), JSON.stringify({ name: "@mirinjs/test-platform" }));

    const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "artifacts.ts")).href;
    const nativePackage = "@mirinjs/test-platform/package.json";
    const expectedHost = resolveCliPackageFile("mirinjs/host", cliDir);
    const expectedNative = resolveCliPackageFile(nativePackage, cliDir);
    const unrelated = join(root, "unrelated-app");
    mkdirSync(unrelated);
    const script = [
      `import { resolveCliPackageFile } from ${JSON.stringify(moduleUrl)};`,
      `const cliDir = ${JSON.stringify(cliDir)};`,
      `console.log(JSON.stringify([resolveCliPackageFile("mirinjs/host", cliDir), resolveCliPackageFile(${JSON.stringify(nativePackage)}, cliDir)]));`,
    ].join("\n");
    const result = Bun.spawnSync({ cmd: [process.execPath, "-e", script], cwd: unrelated });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual([expectedHost, expectedNative]);
  });

  test("rejects a project runtime that differs from the CLI-owned host runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-runtime-version-test-"));
    temporaryDirectories.push(root);
    const cliDir = join(root, "cli", "src");
    const cliRuntime = join(root, "cli", "node_modules", "mirinjs");
    const project = join(root, "project");
    const projectRuntime = join(project, "node_modules", "mirinjs");
    for (const runtime of [cliRuntime, projectRuntime]) {
      mkdirSync(runtime, { recursive: true });
      writeFileSync(join(runtime, "index.ts"), "export {};\n");
    }
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(
      join(cliRuntime, "package.json"),
      JSON.stringify({ name: "mirinjs", version: "1.2.3", exports: "./index.ts" }),
    );
    writeFileSync(
      join(projectRuntime, "package.json"),
      JSON.stringify({ name: "mirinjs", version: "1.2.4", exports: "./index.ts" }),
    );

    expect(() => assertRuntimePackageCompatibility(project, cliDir)).toThrow(
      "runtime version mismatch",
    );

    writeFileSync(
      join(projectRuntime, "package.json"),
      JSON.stringify({ name: "mirinjs", version: "1.2.3", exports: "./index.ts" }),
    );
    expect(assertRuntimePackageCompatibility(project, cliDir)).toBe("1.2.3");
  });
});

describe("CEF archive validation", () => {
  test("accepts the flat and framework archive layouts", () => {
    expect(() =>
      validateArchiveEntries(
        [
          "./",
          "./libcef.so",
          "./locales/en-US.pak",
          "Chromium Embedded Framework.framework/Versions/Current",
        ].join("\n"),
      ),
    ).not.toThrow();
  });

  test.each(["../escape", "nested/../../escape", "/absolute", "C:/absolute", "..\\escape"])(
    "rejects unsafe entry %s",
    (entry) => {
      expect(() => validateArchiveEntries(entry)).toThrow("unsafe CEF archive entry");
    },
  );

  test("accepts contained symlinks and rejects escaping symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-cef-test-"));
    temporaryDirectories.push(root);
    const nested = join(root, "framework", "Versions");
    mkdirSync(nested, { recursive: true });

    symlinkSync("../Resources", join(nested, "Contained"));
    expect(() => validateExtractedSymlinks(root)).not.toThrow();

    symlinkSync("../../../outside", join(nested, "Escaping"));
    expect(() => validateExtractedSymlinks(root)).toThrow("symlink escapes its cache");
  });

  test("verifies release asset checksums before extraction", async () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-cef-test-"));
    temporaryDirectories.push(root);
    const archive = join(root, "archive.tar.gz");
    writeFileSync(archive, "mirin");

    await expect(
      verifyFileSha256(
        archive,
        "36413cff904407f785f9fc2cda350203596faf365847dca195e34b4fb2f91794\n",
      ),
    ).resolves.toBeUndefined();
    await expect(verifyFileSha256(archive, "not-a-checksum")).rejects.toThrow(
      "invalid CEF SHA-256 checksum",
    );
    await expect(verifyFileSha256(archive, "0".repeat(64))).rejects.toThrow("CEF SHA-256 mismatch");
  });
});
