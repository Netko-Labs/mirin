import { MAX_MANIFEST_BYTES } from "./limits.ts";

function declaredLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error("invalid manifest content-length");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error("invalid manifest content-length");
  return value;
}

export async function readBoundedManifestBytes(response: Response): Promise<Uint8Array> {
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

  return bytes;
}

export function parseManifestBytes(bytes: Uint8Array): unknown {
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

export async function readBoundedManifestJson(response: Response): Promise<unknown> {
  return parseManifestBytes(await readBoundedManifestBytes(response));
}

export async function readBoundedSignature(response: Response): Promise<string> {
  const maximum = 1024;
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null && (!/^\d+$/.test(rawLength) || Number(rawLength) > maximum)) {
    throw new Error("update manifest signature is too large");
  }
  if (!response.body) throw new Error("update manifest signature has no response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error("update manifest signature is too large");
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
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("update manifest signature is not valid UTF-8");
  }
}
