import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleLinuxPackageBuilds } from "../src/package/linux/package.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parallel Linux package settlement", () => {
  test("waits for sibling jobs and removes successful artifacts before propagating failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-linux-package-settlement-"));
    temporaryDirectories.push(root);
    const artifact = join(root, "late.deb");
    let finishSibling: (() => void) | undefined;
    let siblingSettled = false;
    const sibling = new Promise<{
      format: "deb";
      path: string;
      size: number;
    }>((resolve) => {
      finishSibling = () => {
        writeFileSync(artifact, "package");
        siblingSettled = true;
        resolve({ format: "deb", path: artifact, size: 7 });
      };
    });

    const operation = settleLinuxPackageBuilds([Promise.reject(new Error("rpm failed")), sibling]);
    await Promise.resolve();
    expect(siblingSettled).toBe(false);
    finishSibling?.();

    await expect(operation).rejects.toThrow("rpm failed");
    expect(siblingSettled).toBe(true);
    expect(existsSync(artifact)).toBe(false);
  });
});
