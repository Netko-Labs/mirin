import { MAX_MANIFEST_BYTES } from "./limits.ts";

function declaredLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error("invalid manifest content-length");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error("invalid manifest content-length");
  return value;
}

export async function readBoundedManifestJson(response: Response): Promise<unknown> {
  const length = declaredLength(response);
  if (length !== undefined && length > MAX_MANIFEST_BYTES) {
    throw new Error(`update manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  if (!response.body) throw new Error("update manifest has no response body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MANIFEST_BYTES) {
        await reader.cancel();
        throw new Error(`update manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("update manifest is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("update manifest is not valid JSON");
  }
}
