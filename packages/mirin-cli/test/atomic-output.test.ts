import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomicOutputDirectory } from "../src/shared/fs/atomic-output.ts";

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
