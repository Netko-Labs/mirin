import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pruneStaleAtomicOutputBackups,
  removeAtomicOutputDirectoryBestEffort,
  writeAtomicOutputDirectory,
} from "../src/shared/fs/atomic-output.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("atomic output directories", () => {
  test("preserves the previous output when assembly fails", async () => {
    const root = temporaryDirectory();
    const output = join(root, "build", "app");
    await writeAtomicOutputDirectory(root, output, "test output", (staging) => {
      writeFileSync(join(staging, "version.txt"), "old");
    });

    await expect(
      writeAtomicOutputDirectory(root, output, "test output", (staging) => {
        writeFileSync(join(staging, "version.txt"), "partial");
        throw new Error("assembly failed");
      }),
    ).rejects.toThrow("assembly failed");

    expect(readFileSync(join(output, "version.txt"), "utf8")).toBe("old");
    expect(stageEntries(root)).toEqual([]);
  });

  test("replaces the previous output only after successful assembly", async () => {
    const root = temporaryDirectory();
    const output = join(root, "build", "app");
    await writeAtomicOutputDirectory(root, output, "test output", (staging) => {
      writeFileSync(join(staging, "version.txt"), "old");
    });
    await writeAtomicOutputDirectory(root, output, "test output", (staging) => {
      writeFileSync(join(staging, "version.txt"), "new");
    });

    expect(readFileSync(join(output, "version.txt"), "utf8")).toBe("new");
    expect(stageEntries(root)).toEqual([]);
  });

  test("does not report a committed output as failed when backup cleanup fails", () => {
    const warnings: string[] = [];
    const removed = removeAtomicOutputDirectoryBestEffort(
      "/synthetic/committed-backup",
      "test committed backup",
      () => {
        throw new Error("permission denied");
      },
      (message) => warnings.push(message),
    );

    expect(removed).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("permission denied");
  });

  test("prunes aged committed backups on a later run", async () => {
    const root = temporaryDirectory();
    const output = join(root, "build", "app");
    await writeAtomicOutputDirectory(root, output, "test output", (staging) => {
      writeFileSync(join(staging, "version.txt"), "current");
    });
    const backup = join(
      root,
      "build",
      ".app.mirin-backup-123-12345678-1234-1234-1234-123456789abc",
    );
    mkdirSync(backup);
    writeFileSync(join(backup, "version.txt"), "old");
    utimesSync(backup, new Date(0), new Date(0));

    pruneStaleAtomicOutputBackups(root, output, "test output", Date.now(), () => false);

    expect(existsSync(backup)).toBe(false);
    expect(readFileSync(join(output, "version.txt"), "utf8")).toBe("current");
  });

  test("preserves aged prefix-sharing directories without an owned backup name", async () => {
    const root = temporaryDirectory();
    const output = join(root, "build", "release");
    await writeAtomicOutputDirectory(root, output, "test output", (staging) => {
      writeFileSync(join(staging, "version.txt"), "current");
    });
    const lookalike = join(root, "build", ".release.mirin-backup-manual");
    mkdirSync(lookalike);
    writeFileSync(join(lookalike, "sentinel.txt"), "user data");
    utimesSync(lookalike, new Date(0), new Date(0));

    pruneStaleAtomicOutputBackups(root, output, "test output", Date.now(), () => false);

    expect(readFileSync(join(lookalike, "sentinel.txt"), "utf8")).toBe("user data");
  });

  test("preserves an aged owned backup while its process is alive", async () => {
    const root = temporaryDirectory();
    const output = join(root, "build", "release");
    await writeAtomicOutputDirectory(root, output, "test output", (staging) => {
      writeFileSync(join(staging, "version.txt"), "current");
    });
    const backup = join(
      root,
      "build",
      ".release.mirin-backup-456-12345678-1234-1234-1234-123456789abc",
    );
    mkdirSync(backup);
    writeFileSync(join(backup, "version.txt"), "live");
    utimesSync(backup, new Date(0), new Date(0));

    pruneStaleAtomicOutputBackups(root, output, "test output", Date.now(), (pid) => pid === 456);

    expect(readFileSync(join(backup, "version.txt"), "utf8")).toBe("live");
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mirin-atomic-output-"));
  temporaryDirectories.push(directory);
  return directory;
}

function stageEntries(root: string): string[] {
  const build = join(root, "build");
  if (!existsSync(build)) return [];
  return Array.from(new Bun.Glob(".*.mirin-{stage,backup}-*").scanSync({ cwd: build }));
}
