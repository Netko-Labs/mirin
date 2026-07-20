import { rmSync, statSync } from "node:fs";
import type { UpdateProgress } from "../types.ts";
import { MAX_ARTIFACT_BYTES, MAX_TAR_BYTES } from "./limits.ts";
import { assertTrustedUpdateUrl } from "./urls.ts";

interface DownloadOptions {
  url: string;
  destination: string;
  sha256: string;
  size: number;
  onProgress?: (progress: UpdateProgress) => void;
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error("invalid download content-length");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error("invalid download content-length");
  return value;
}

export async function downloadVerifiedArtifact(options: DownloadOptions): Promise<void> {
  if (
    !Number.isSafeInteger(options.size) ||
    options.size <= 0 ||
    options.size > MAX_ARTIFACT_BYTES
  ) {
    throw new Error("download requires a bounded declared size");
  }

  rmSync(options.destination, { force: true });
  try {
    const response = await fetch(options.url, { redirect: "follow" });
    assertTrustedUpdateUrl(response.url);
    if (!response.ok || !response.body) throw new Error(`download ${response.status}`);

    const declared = contentLength(response);
    if (declared !== undefined && declared !== options.size) {
      throw new Error(`download size mismatch (expected ${options.size}, got ${declared})`);
    }

    const reader = response.body.getReader();
    const writer = Bun.file(options.destination).writer();
    const hasher = new Bun.CryptoHasher("sha256");
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > options.size || received > MAX_ARTIFACT_BYTES) {
          await reader.cancel();
          throw new Error(`download exceeds expected size ${options.size}`);
        }
        hasher.update(value);
        const written = writer.write(value);
        if (written !== value.byteLength) throw new Error("download write was incomplete");
        options.onProgress?.({
          received,
          total: options.size,
          fraction: received / options.size,
        });
      }
    } finally {
      reader.releaseLock();
      await writer.end();
    }
    if (received !== options.size) {
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
  expectedSize: number,
): Promise<void> {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize <= 0 ||
    expectedSize > MAX_TAR_BYTES ||
    statSync(path).size !== expectedSize
  ) {
    throw new Error(`${errorMessage}: invalid file size`);
  }

  const hasher = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(path).stream().getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > expectedSize) throw new Error(`${errorMessage}: file exceeds expected size`);
    hasher.update(value);
  }
  if (received !== expectedSize || hasher.digest("hex") !== expectedSha256) {
    throw new Error(errorMessage);
  }
}
