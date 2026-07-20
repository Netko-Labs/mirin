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
const MAX_TAR_BYTES = 1024 * 1024 * 1024;
const SEMVER_IDENTIFIER = /^[0-9A-Za-z-]+$/;

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
  assertSemVer(version);
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
): Promise<PreviousReleaseManifest> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^\d+$/.test(rawLength) || Number(rawLength) > MAX_MANIFEST_BYTES) {
      throw new Error("previous update manifest is too large");
    }
  }
  if (!response.body) throw new Error("previous update manifest has no body");

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
        throw new Error("previous update manifest is too large");
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
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid previous update manifest JSON");
  }
  return parsePreviousReleaseManifest(value, expected);
}

function assertSemVer(value: string): void {
  const plus = value.indexOf("+");
  if (plus !== -1 && value.indexOf("+", plus + 1) !== -1) {
    throw new Error("invalid previous update version");
  }
  const withoutBuild = plus === -1 ? value : value.slice(0, plus);
  if (plus !== -1) assertIdentifiers(value.slice(plus + 1), false);
  const hyphen = withoutBuild.indexOf("-");
  const core = hyphen === -1 ? withoutBuild : withoutBuild.slice(0, hyphen);
  if (hyphen !== -1) assertIdentifiers(withoutBuild.slice(hyphen + 1), true);
  const parts = core.split(".");
  if (
    parts.length !== 3 ||
    parts.some((part) => !/^\d+$/.test(part) || (part.length > 1 && part.startsWith("0")))
  ) {
    throw new Error("invalid previous update version");
  }
}

function assertIdentifiers(value: string, rejectNumericLeadingZero: boolean): void {
  const parts = value.split(".");
  if (
    parts.some(
      (part) =>
        !SEMVER_IDENTIFIER.test(part) ||
        (rejectNumericLeadingZero && /^\d+$/.test(part) && part.length > 1 && part.startsWith("0")),
    )
  ) {
    throw new Error("invalid previous update version");
  }
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
