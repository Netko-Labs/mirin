import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareInstallSibling } from "../src/updater/lib/install-staging.ts";
import { validateStagedBundle } from "../src/updater/lib/staged.ts";

const installed = {
  version: "1.0.0",
  channel: "stable",
  baseUrl: "https://updates.example.com",
  publicKey: "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
  name: "MirinApp",
  identifier: "com.example.mirin",
};

function createLinuxStage(version = "1.1.0"): {
  root: string;
  extractionRoot: string;
  staged: string;
  executable: string;
} {
  const root = mkdtempSync(join(tmpdir(), "mirin-staged-test-"));
  const extractionRoot = join(root, "extract");
  const staged = join(extractionRoot, installed.name);
  const resources = join(staged, "resources");
  mkdirSync(resources, { recursive: true });
  const executable = join(staged, installed.name);
  writeFileSync(executable, "#!/bin/sh\n");
  chmodSync(executable, 0o755);
  writeFileSync(join(resources, "version.json"), JSON.stringify({ ...installed, version }), "utf8");
  return { root, extractionRoot, staged, executable };
}

describe("staged update bundle validation", () => {
  test("requires an executable and exact staged identity", () => {
    const stage = createLinuxStage();
    try {
      expect(
        validateStagedBundle({
          staged: stage.staged,
          extractionRoot: stage.extractionRoot,
          platform: "linux",
          installed,
          expectedVersion: "1.1.0",
        }).version,
      ).toBe("1.1.0");
      expect(() =>
        validateStagedBundle({
          staged: stage.staged,
          extractionRoot: stage.extractionRoot,
          platform: "linux",
          installed,
          expectedVersion: "1.2.0",
        }),
      ).toThrow("identity does not match");
    } finally {
      rmSync(stage.root, { recursive: true, force: true });
    }
  });

  test("ensures owner execute only after validating a regular Linux executable", () => {
    const stage = createLinuxStage();
    try {
      chmodSync(stage.executable, 0o644);
      validateStagedBundle({
        staged: stage.staged,
        extractionRoot: stage.extractionRoot,
        platform: "linux",
        installed,
        expectedVersion: "1.1.0",
      });
      expect(statSync(stage.executable).mode & 0o100).toBe(0o100);

      rmSync(stage.executable);
      const outside = join(stage.root, "outside");
      writeFileSync(outside, "#!/bin/sh\n");
      symlinkSync(outside, stage.executable);
      expect(() =>
        validateStagedBundle({
          staged: stage.staged,
          extractionRoot: stage.extractionRoot,
          platform: "linux",
          installed,
          expectedVersion: "1.1.0",
        }),
      ).toThrow("symlink escapes the bundle");
    } finally {
      rmSync(stage.root, { recursive: true, force: true });
    }
  });

  test("revalidates a sibling stage on the install filesystem before handoff", async () => {
    const stage = createLinuxStage();
    const install = join(stage.root, "install", installed.name);
    const resources = join(install, "resources");
    mkdirSync(resources, { recursive: true });
    try {
      const sibling = await prepareInstallSibling({
        resourcesDir: resources,
        downloadedStage: stage.staged,
        platform: "linux",
        installed,
        expectedVersion: "1.1.0",
      });
      expect(dirname(sibling)).toBe(dirname(install));
      expect(
        validateStagedBundle({
          staged: sibling,
          extractionRoot: dirname(install),
          platform: "linux",
          installed,
          expectedVersion: "1.1.0",
        }).version,
      ).toBe("1.1.0");
    } finally {
      rmSync(stage.root, { recursive: true, force: true });
    }
  });
});
