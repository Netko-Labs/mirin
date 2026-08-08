/**
 * HTTP plumbing for the inspector. Binding loopback is not by itself a boundary —
 * any local browser page can reach `127.0.0.1` — so every request must present
 * the session token and a loopback `Host` header.
 */

/** Hostnames a legitimate inspector request can address. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Nothing here is cacheable: every response is a live reading.
      "cache-control": "no-store",
    },
  });
}

export function jsonError(
  message: string,
  status: number,
  extra?: Record<string, unknown>,
): Response {
  return json({ error: message, ...extra }, status);
}

/** Length-checked, branch-free comparison so a token cannot be probed byte by byte. */
export function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The token presented by a request, from a bearer header or the `token` param. */
export function presentedToken(req: Request, url: URL): string | undefined {
  const header = req.headers.get("authorization");
  if (header !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return url.searchParams.get("token") ?? undefined;
}

/** Whether a `Host` header names loopback. Rejecting anything else stops
 *  DNS-rebinding: a page on `evil.example` whose DNS resolves to `127.0.0.1`. */
export function isLoopbackHost(host: string | null): boolean {
  if (host === null || host.length === 0) return false;
  // Strip the port; IPv6 literals keep their brackets.
  const name = host.startsWith("[")
    ? (host.match(/^\[[^\]]*\]/)?.[0] ?? host)
    : (host.split(":")[0] ?? host);
  return LOOPBACK_HOSTS.has(name.toLowerCase());
}

/** `undefined` when the request may proceed, otherwise the response to send. */
export function rejectUnauthorized(req: Request, url: URL, token: string): Response | undefined {
  if (!isLoopbackHost(req.headers.get("host"))) {
    return jsonError("inspector accepts loopback requests only", 403);
  }
  const presented = presentedToken(req, url);
  if (presented === undefined) {
    return jsonError(
      "missing token — pass ?token=… or an Authorization: Bearer header " +
        "(the token is in .mirin/dev/<session>/inspector.json)",
      401,
    );
  }
  if (!secretEquals(presented, token)) return jsonError("invalid token", 401);
  return undefined;
}
