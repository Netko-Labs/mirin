export function trustedBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid update baseUrl: ${raw}`);
  }
  assertTrustedUpdateUrl(url.toString());
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export function assertTrustedUpdateUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid update URL: ${raw}`);
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
  throw new Error("update URLs must use HTTPS, except loopback HTTP for local testing");
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_TRUSTED_REDIRECTS = 10;

/** Follow redirects manually so every requested hop satisfies the HTTPS policy. */
export async function fetchTrustedUpdateUrl(raw: string): Promise<Response> {
  let current = raw;
  for (let redirects = 0; redirects <= MAX_TRUSTED_REDIRECTS; redirects += 1) {
    assertTrustedUpdateUrl(current);
    const response = await fetch(current, { redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("update redirect is missing a location");
    if (redirects === MAX_TRUSTED_REDIRECTS) {
      throw new Error("update redirect limit exceeded");
    }
    current = new URL(location, current).toString();
  }
  throw new Error("update redirect limit exceeded");
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function artifactUrl(base: string, fileName: string): string {
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
    throw new Error(`unsafe update artifact name: ${fileName}`);
  }
  return `${base}/${fileName}`;
}
