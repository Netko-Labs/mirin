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
  MAX_INSTALL_SIBLING_AGE_MS,
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

  test("prunes leased install siblings without trusting a reused startup PID", async () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-install-staging-cleanup-"));
    const install = join(root, "install", installed.name);
    const resources = join(install, "resources");
    const parent = dirname(install);
    const prefix = `.${installed.name}.mirin-new-`;
    const nowMs = 1_800_000_000_000;
    const currentSession = "a".repeat(32);
    const owned = (pid: number, session: string, createdAtMs: number, uuid: string) =>
      join(parent, `${prefix}${pid}-${session}-${createdAtMs}-${uuid}`);
    const abandoned = owned(300, "c".repeat(32), nowMs, "11111111-1111-1111-1111-111111111111");
    const live = owned(200, "d".repeat(32), nowMs, "22222222-2222-2222-2222-222222222222");
    const current = owned(100, currentSession, nowMs, "33333333-3333-3333-3333-333333333333");
    const reusedCurrent = owned(100, "b".repeat(32), nowMs, "55555555-5555-5555-5555-555555555555");
    const agedLive = owned(
      201,
      "e".repeat(32),
      nowMs - MAX_INSTALL_SIBLING_AGE_MS - 1,
      "66666666-6666-6666-6666-666666666666",
    );
    const legacyCurrent = join(parent, `${prefix}100-77777777-7777-7777-7777-777777777777`);
    const unrelated = join(parent, `${prefix}300-not-a-uuid`);
    const outside = join(root, "outside");
    const linked = join(parent, `${prefix}400-44444444-4444-4444-4444-444444444444`);
    mkdirSync(resources, { recursive: true });
    for (const directory of [
      abandoned,
      live,
      current,
      reusedCurrent,
      agedLive,
      legacyCurrent,
      unrelated,
    ]) {
      mkdirSync(directory);
    }
    mkdirSync(outside);
    symlinkSync(outside, linked, "dir");

    try {
      await pruneInstallSiblingDirectories({
        resourcesDir: resources,
        platform: "linux",
        hasLiveHelper: true,
        currentPid: 100,
        currentSession,
        isProcessAlive: () => false,
        nowMs,
      });
      expect(existsSync(abandoned)).toBe(true);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(agedLive)).toBe(true);

      await pruneInstallSiblingDirectories({
        resourcesDir: resources,
        platform: "linux",
        currentPid: 100,
        currentSession,
        isProcessAlive: (pid) => pid === 100 || pid === 200 || pid === 201,
        nowMs,
      });
      expect(existsSync(abandoned)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(current)).toBe(true);
      expect(existsSync(reusedCurrent)).toBe(false);
      expect(existsSync(agedLive)).toBe(false);
      expect(existsSync(legacyCurrent)).toBe(false);
      expect(existsSync(unrelated)).toBe(true);
      expect(existsSync(linked)).toBe(true);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
