import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadVerifiedArtifact, verifyFileSha256 } from "../src/updater/lib/integrity.ts";

const sha256 = "36413cff904407f785f9fc2cda350203596faf365847dca195e34b4fb2f91794";

describe("updater artifact integrity", () => {
  test("streams a bounded artifact and removes hash mismatches", async () => {
    const root = mkdtempSync(join(tmpdir(), "mirin-updater-test-"));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("mirin"),
    });
    const url = `http://127.0.0.1:${server.port}/bundle.tar.zst`;
    const destination = join(root, "bundle.tar.zst");
    const progress: number[] = [];

    try {
      await downloadVerifiedArtifact({
        url,
        destination,
        sha256,
        size: 5,
        onProgress: (value) => progress.push(value.received),
      });
      expect(await Bun.file(destination).text()).toBe("mirin");
      expect(progress.at(-1)).toBe(5);
      await expect(
        verifyFileSha256(destination, sha256, "integrity mismatch"),
      ).resolves.toBeUndefined();

      await expect(
        downloadVerifiedArtifact({
          url,
          destination,
          sha256: "0".repeat(64),
          size: 5,
        }),
      ).rejects.toThrow("download hash mismatch");
      expect(existsSync(destination)).toBe(false);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
