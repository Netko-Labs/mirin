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

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** Whether `raw` is a well-formed URL pointing at loopback (local testing). */
export function isLoopbackUpdateUrl(raw: string): boolean {
  try {
    return isLoopbackHost(new URL(raw).hostname);
  } catch {
    return false;
  }
}

export function artifactUrl(base: string, fileName: string): string {
  if (
    fileName.length === 0 ||
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
