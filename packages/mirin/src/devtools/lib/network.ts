/**
 * Shaping HTTP traffic for the event stream.
 *
 * The stream is written to `events.jsonl` in plain text and served over the
 * inspector, so anything recorded here is durable and readable. Request and
 * response *metadata* is what makes a network bug diagnosable — method, URL,
 * status, type, size, time to headers — and that carries no secrets. Headers
 * frequently do, and so do URLs (`?api_key=…`), so both are redacted before they
 * reach the sink.
 *
 * Bodies are deliberately not recorded at all. When one is genuinely needed, the
 * `requestId` on every event fetches it on demand through `POST /cdp` with
 * `Network.getResponseBody` — an explicit act, not a standing capture.
 */

import type { DevEventLevel } from "../types.ts";
import { asNumber, asRecord, asString } from "./parse.ts";

const REDACTED = "[redacted]";

/** Header names that are secrets outright, regardless of the app. */
const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "www-authenticate",
  "proxy-authenticate",
]);

/**
 * Names that carry a credential often enough to redact on sight. Deliberately
 * broad: a false positive costs one unreadable diagnostic value, a false negative
 * writes a live token to disk.
 */
const SECRET_PATTERN = /auth|token|secret|password|passwd|credential|session|api[-_]?key|\bkey\b/i;

/** Caps, so one pathological request cannot crowd out the rest of the buffer. */
const MAX_HEADERS = 32;
const MAX_VALUE_LENGTH = 256;
const MAX_URL_LENGTH = 512;

/** Whether a header or query-parameter name should have its value hidden. */
export function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_HEADERS.has(lower) || SECRET_PATTERN.test(lower);
}

/**
 * A CDP header bag, reduced to strings with sensitive values replaced. Header
 * names are kept: knowing an `Authorization` header was *sent* is most of the
 * diagnostic value, and its content is none of it.
 */
export function redactHeaders(value: unknown): Record<string, string> {
  const headers = asRecord(value);
  if (headers === undefined) return {};

  const out: Record<string, string> = {};
  let kept = 0;
  for (const [name, raw] of Object.entries(headers)) {
    if (kept >= MAX_HEADERS) {
      out["…"] = `${Object.keys(headers).length - kept} more`;
      break;
    }
    kept++;
    if (isSensitiveName(name)) {
      out[name] = REDACTED;
      continue;
    }
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    out[name] =
      text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}… (truncated)` : text;
  }
  return out;
}

/** `scheme://user:password@host` — the credential is in the authority, not the query. */
const USERINFO = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/[^/?#]*@/;

/**
 * A URL with its credentials hidden, wherever they sit: `user:password@` in the
 * authority, and any query **or fragment** parameter whose name looks like a
 * secret. An unparseable URL is truncated rather than dropped — a malformed URL is
 * itself a finding.
 *
 * All three halves matter, and the fragment is the one that is easy to forget:
 *
 * - A URL with no query string still carries basic-auth userinfo, so this must not
 *   short-circuit on the absence of a `?`.
 * - OAuth's implicit flow returns `#access_token=…`, which is the shape a desktop
 *   app hits most, because a custom-scheme redirect cannot hold a client secret.
 *   A fragment is never sent to the server, so it does not appear in any network
 *   event — `Page.frameNavigated` is the only place it surfaces, which makes
 *   `navigation` precisely the sink that must handle it.
 */
export function redactUrl(url: string): string {
  const capped = url.length > MAX_URL_LENGTH ? `${url.slice(0, MAX_URL_LENGTH)}…` : url;

  try {
    const parsed = new URL(capped);
    let changed = false;
    if (parsed.username !== "" || parsed.password !== "") {
      parsed.username = "";
      parsed.password = "";
      changed = true;
    }
    for (const name of [...parsed.searchParams.keys()]) {
      if (!isSensitiveName(name)) continue;
      parsed.searchParams.set(name, REDACTED);
      changed = true;
    }
    // A fragment is not structured, but in practice it carries the same
    // `a=b&c=d` shape the query does, so the same parser applies.
    const fragment = parsed.hash.slice(1);
    if (fragment.length > 0) {
      const redacted = redactQueryString(fragment);
      if (redacted !== fragment) {
        parsed.hash = `#${redacted}`;
        changed = true;
      }
    }
    // Only re-serialize when something changed: `toString()` normalizes, and an
    // untouched URL should be reported exactly as the app requested it.
    return changed ? parsed.toString() : capped;
  } catch {
    return redactOpaqueUrl(capped);
  }
}

/** The same rules applied lexically, for a relative or non-standard-scheme URL. */
function redactOpaqueUrl(url: string): string {
  const withoutUserinfo = url.replace(
    USERINFO,
    (match) => `${match.slice(0, match.lastIndexOf("//") + 2)}${REDACTED}@`,
  );
  // Split the fragment off first: everything after `#` is fragment, including a
  // `?` inside it, so splitting on `?` first would misattribute the two.
  const [beforeFragment, fragment] = splitOnce(withoutUserinfo, "#");
  const [path, query] = splitOnce(beforeFragment, "?");
  return [
    path,
    query !== undefined ? `?${redactQueryString(query)}` : "",
    fragment !== undefined ? `#${redactQueryString(fragment)}` : "",
  ].join("");
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  return index < 0 ? [value, undefined] : [value.slice(0, index), value.slice(index + 1)];
}

function redactQueryString(query: string): string {
  return query
    .split("&")
    .map((pair) => {
      const [name, value] = splitOnce(pair, "=");
      if (value === undefined) return pair;
      return isSensitiveName(decodeURIComponentSafe(name)) ? `${name}=${REDACTED}` : pair;
    })
    .join("&");
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Severity for a response status. A 4xx is usually the app's own doing (a missing
 * favicon, an expected 404 probe) and must not fail `mirin check`; a 5xx is the
 * server failing and should.
 */
export function statusLevel(status: number): DevEventLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "debug";
}

/** Milliseconds from request start to response headers, when CDP reported timing. */
export function headersMs(timing: unknown): number | undefined {
  const received = asNumber(asRecord(timing)?.receiveHeadersEnd);
  return received !== undefined && received >= 0 ? Math.round(received) : undefined;
}

/** `POST` for a request whose method CDP reported, else `GET`. */
export function requestMethod(value: unknown): string {
  return asString(value)?.toUpperCase() ?? "GET";
}
