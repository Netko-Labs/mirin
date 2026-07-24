import { validateAppVersion } from "../shared/validation/config.ts";

export interface PreviousReleaseManifest {
  version: string;
  tarSize: number;
  bundle: {
    url: string;
    sha256: string;
    size: number;
  };
}

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_TAR_BYTES = 8 * 1024 * 1024 * 1024;

export function parsePreviousReleaseManifest(
  value: unknown,
  expected: { channel: string; platform: string; arch: string },
): PreviousReleaseManifest {
  const manifest = record(value, "manifest");
  for (const key of ["channel", "platform", "arch"] as const) {
    if (stringField(manifest, key, 64) !== expected[key]) {
      throw new Error(`previous update manifest target mismatch: ${key}`);
    }
  }

  const version = stringField(manifest, "version", 128);
  try {
    validateAppVersion(version);
  } catch {
    throw new Error("invalid previous update version");
  }
  const tarSize = sizeField(manifest.tarSize, MAX_TAR_BYTES, "tar size");
  const bundle = record(manifest.bundle, "bundle");
  const url = stringField(bundle, "url", 255);
  releaseArtifactUrl("https://example.invalid", url);
  const sha256 = stringField(bundle, "sha256", 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("invalid previous bundle checksum");
  const size = sizeField(bundle.size, MAX_ARTIFACT_BYTES, "bundle size");

  return { version, tarSize, bundle: { url, sha256, size } };
}

export async function readPreviousReleaseManifest(
  response: Response,
  expected: { channel: string; platform: string; arch: string },
): Promise<{ manifest: PreviousReleaseManifest; bytes: Uint8Array }> {
  const bytes = await readBoundedResponse(response, MAX_MANIFEST_BYTES, "previous update manifest");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid previous update manifest JSON");
  }
  return { manifest: parsePreviousReleaseManifest(value, expected), bytes };
}

export async function readPreviousReleaseSignature(response: Response): Promise<string> {
  const bytes = await readBoundedResponse(response, 1024, "previous update manifest signature");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid previous update manifest signature");
  }
}

async function readBoundedResponse(
  response: Response,
  maximum: number,
  label: string,
): Promise<Uint8Array> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^\d+$/.test(rawLength) || Number(rawLength) > maximum) {
      throw new Error(`${label} is too large`);
    }
  }
  if (!response.body) throw new Error(`${label} has no body`);

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
        throw new Error(`${label} is too large`);
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

function sizeField(value: unknown, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`invalid previous ${label}`);
  }
  return value;
}

export function trustedReleaseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid release baseUrl: ${raw}`);
  }
  assertTrustedReleaseUrl(url.toString());
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export function assertTrustedReleaseUrl(raw: string): void {
  const url = new URL(raw);
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
  throw new Error("release URLs must use HTTPS, except loopback HTTP for local testing");
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_TRUSTED_REDIRECTS = 10;
export const RELEASE_METADATA_TIMEOUT_MS = 30_000;
export const RELEASE_ARTIFACT_TIMEOUT_MS = 15 * 60_000;

/** Follow redirects manually so an intermediate HTTP hop cannot bypass policy. */
export async function fetchTrustedReleaseUrl(
  raw: string,
  options: { timeoutMs?: number } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? RELEASE_METADATA_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30 * 60_000) {
    throw new Error("invalid release request timeout");
  }
  let current = raw;
  for (let redirects = 0; redirects <= MAX_TRUSTED_REDIRECTS; redirects += 1) {
    assertTrustedReleaseUrl(current);
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("release redirect is missing a location");
    if (redirects === MAX_TRUSTED_REDIRECTS) {
      throw new Error("release redirect limit exceeded");
    }
    current = new URL(location, current).toString();
  }
  throw new Error("release redirect limit exceeded");
}

export function releaseArtifactUrl(base: string, fileName: string): string {
  if (
    fileName.length === 0 ||
    fileName.length > 255 ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("?") ||
    fileName.includes("#") ||
    fileName === "." ||
    fileName === ".."
  ) {
    throw new Error(`unsafe previous update artifact name: ${fileName}`);
  }
  return `${base}/${fileName}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid previous update ${label}`);
  }
  return value as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, key: string, maximum: number): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`invalid previous update field: ${key}`);
  }
  return value;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
