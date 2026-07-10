export interface PreviousReleaseManifest {
  version: string;
  bundle: {
    url: string;
    sha256: string;
    size: number;
  };
}

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;

export function parsePreviousReleaseManifest(
  value: unknown,
  expected: { channel: string; platform: string; arch: string },
): PreviousReleaseManifest {
  const manifest = record(value, "manifest");
  for (const key of ["channel", "platform", "arch"] as const) {
    if (stringField(manifest, key) !== expected[key]) {
      throw new Error(`previous update manifest target mismatch: ${key}`);
    }
  }

  const version = stringField(manifest, "version");
  if (
    version.length > 128 ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      version,
    )
  ) {
    throw new Error("invalid previous update version");
  }

  const bundle = record(manifest.bundle, "bundle");
  const url = stringField(bundle, "url");
  releaseArtifactUrl("https://example.invalid", url);
  const sha256 = stringField(bundle, "sha256").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("invalid previous bundle checksum");
  const size = bundle.size;
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_ARTIFACT_BYTES
  ) {
    throw new Error("invalid previous bundle size");
  }

  return { version, bundle: { url, sha256, size } };
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

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid previous update field: ${key}`);
  }
  return value;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
