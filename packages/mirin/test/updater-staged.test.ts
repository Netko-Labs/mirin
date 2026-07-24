import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  prepareInstallSibling,
  pruneInstallSiblingDirectories,
} from "../src/updater/lib/install-staging.ts";
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

function createMacStage(version = "1.1.0"): {
  root: string;
  staged: string;
} {
  const root = mkdtempSync(join(tmpdir(), "mirin-mac-staged-test-"));
  const staged = join(root, "download", `${installed.name}.app`);
  const contents = join(staged, "Contents");
  const executable = join(contents, "MacOS", installed.name);
  const resources = join(contents, "Resources");
  const framework = join(contents, "Frameworks", "Chromium Embedded Framework.framework");
  const frameworkVersion = join(framework, "Versions", "A");
  mkdirSync(dirname(executable), { recursive: true });
  mkdirSync(resources, { recursive: true });
  mkdirSync(join(frameworkVersion, "Resources"), { recursive: true });
  writeFileSync(executable, "#!/bin/sh\n");
  chmodSync(executable, 0o755);
  writeFileSync(join(resources, "version.json"), JSON.stringify({ ...installed, version }), "utf8");
  writeFileSync(join(frameworkVersion, "Resources", "fixture.txt"), "framework");
  symlinkSync("A", join(framework, "Versions", "Current"));
  symlinkSync("Versions/Current/Resources", join(framework, "Resources"));
  return { root, staged };
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

  test("preserves relative macOS framework symlinks in the install-side copy", async () => {
    const stage = createMacStage();
    const install = join(stage.root, "install", `${installed.name}.app`);
    const resources = join(install, "Contents", "Resources");
    mkdirSync(resources, { recursive: true });
    try {
      const sibling = await prepareInstallSibling({
        resourcesDir: resources,
        downloadedStage: stage.staged,
        platform: "darwin",
        installed,
        expectedVersion: "1.1.0",
        verifyMacIdentity: async () => {},
      });
      const framework = join(
        sibling,
        "Contents",
        "Frameworks",
        "Chromium Embedded Framework.framework",
      );
      expect(readlinkSync(join(framework, "Versions", "Current"))).toBe("A");
      expect(readlinkSync(join(framework, "Resources"))).toBe("Versions/Current/Resources");
    } finally {
      rmSync(stage.root, { recursive: true, force: true });
    }
  });

  test("prunes only dead-owned install siblings and preserves live helper work", () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-install-staging-cleanup-"));
    const install = join(root, "install", installed.name);
    const resources = join(install, "resources");
    const parent = dirname(install);
    const prefix = `.${installed.name}.mirin-new-`;
    const abandoned = join(parent, `${prefix}300-11111111-1111-1111-1111-111111111111`);
    const live = join(parent, `${prefix}200-22222222-2222-2222-2222-222222222222`);
    const unrelated = join(parent, `${prefix}300-not-a-uuid`);
    const outside = join(root, "outside");
    const linked = join(parent, `${prefix}400-44444444-4444-4444-4444-444444444444`);
    mkdirSync(resources, { recursive: true });
    mkdirSync(abandoned);
    mkdirSync(live);
    mkdirSync(unrelated);
    mkdirSync(outside);
    symlinkSync(outside, linked, "dir");

    try {
      pruneInstallSiblingDirectories({
        resourcesDir: resources,
        platform: "linux",
        hasLiveHelper: true,
        isProcessAlive: () => false,
      });
      expect(existsSync(abandoned)).toBe(true);
      expect(existsSync(live)).toBe(true);

      pruneInstallSiblingDirectories({
        resourcesDir: resources,
        platform: "linux",
        isProcessAlive: (pid) => pid === 200,
      });
      expect(existsSync(abandoned)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
      expect(existsSync(linked)).toBe(true);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
