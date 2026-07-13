import { rmSync } from "node:fs";
import type { UpdateProgress } from "../types.ts";
import { assertTrustedUpdateUrl } from "./urls.ts";

/** Absolute ceiling on a streamed artifact, enforced even when the manifest
 *  omits `size`, so a hostile/oversized response can't fill the disk. */
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;

interface DownloadOptions {
  url: string;
  destination: string;
  sha256: string;
  size?: number;
  onProgress?: (progress: UpdateProgress) => void;
}

export async function downloadVerifiedArtifact(options: DownloadOptions): Promise<void> {
  const response = await fetch(options.url, { redirect: "follow" });
  assertTrustedUpdateUrl(response.url);
  if (!response.ok || !response.body) throw new Error(`download ${response.status}`);

  const total = Number(response.headers.get("content-length") ?? 0);
  if (options.size !== undefined && total > 0 && total !== options.size) {
    throw new Error(`download size mismatch (expected ${options.size}, got ${total})`);
  }

  const reader = response.body.getReader();
  const writer = Bun.file(options.destination).writer();
  const hasher = new Bun.CryptoHasher("sha256");
  let received = 0;
  try {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        // Bound the write by the declared size when present, and always by the
        // absolute ceiling — a manifest that omits `size` must not stream forever.
        if (options.size !== undefined && received > options.size) {
          throw new Error(`download exceeds expected size ${options.size}`);
        }
        if (received > MAX_ARTIFACT_BYTES) {
          throw new Error("download exceeds the maximum allowed size");
        }
        hasher.update(value);
        writer.write(value);
        options.onProgress?.({
          received,
          total,
          fraction: total ? received / total : 0,
        });
      }
    } finally {
      await writer.end();
    }
    if (options.size !== undefined && received !== options.size) {
      throw new Error(`download size mismatch (expected ${options.size}, got ${received})`);
    }
    if (hasher.digest("hex") !== options.sha256) throw new Error("download hash mismatch");
  } catch (error) {
    rmSync(options.destination, { force: true });
    throw error;
  }
}

export async function verifyFileSha256(
  path: string,
  expectedSha256: string,
  errorMessage: string,
): Promise<void> {
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  if (hasher.digest("hex") !== expectedSha256) throw new Error(errorMessage);
}
