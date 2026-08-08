/**
 * Shaping HTTP traffic for the event stream. The stream is durable plaintext on
 * disk, so headers and URLs are redacted before they reach the sink. Bodies are
 * never recorded — fetch one on demand via `POST /cdp` with `Network.getResponseBody`.
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

/** Deliberately broad: a false positive costs one unreadable diagnostic value, a
 *  false negative writes a live token to disk. */
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

/** A CDP header bag with sensitive values replaced. Names are kept: that an
 *  `Authorization` header was *sent* is the diagnostic value. */
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
 * A URL with credentials hidden wherever they sit: authority userinfo, query, and
 * fragment (OAuth's implicit flow returns `#access_token=…`, which only
 * `Page.frameNavigated` ever sees). An unparseable URL is truncated rather than
 * dropped — a malformed URL is itself a finding.
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
    // A lexical pass, not `searchParams`: it decodes names, so `?api_key%3Dsecret`
    // becomes one *name* whose "redaction" would leave the secret in place.
    const query = parsed.search.slice(1);
    if (query.length > 0) {
      const redacted = redactQueryString(query);
      if (redacted !== query) {
        parsed.search = redacted;
        changed = true;
      }
    }
    // A fragment carries the same `a=b&c=d` shape in practice, so the same parser applies.
    const fragment = parsed.hash.slice(1);
    if (fragment.length > 0) {
      const redacted = redactQueryString(fragment);
      if (redacted !== fragment) {
        parsed.hash = `#${redacted}`;
        changed = true;
      }
    }
    // Re-serialize only on change: `toString()` normalizes, and an untouched URL
    // should be reported exactly as the app requested it.
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
  // Fragment off first: everything after `#` is fragment, including any `?` in it.
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

/** Pair separators. `;` is legacy (WHATWG dropped it) but servers still emit it,
 *  and a pair the splitter cannot see is one the heuristic never judges. */
const PAIR_SEPARATOR = /([&;])/;

/** An `=` that arrived percent-encoded (`#access_token%3D…`), which makes a
 *  name/value pair look like one opaque token. */
const ENCODED_EQUALS = /%3d/i;

/** Redact sensitive pairs, preserving separators so an untouched string is unchanged. */
function redactQueryString(query: string): string {
  return query
    .split(PAIR_SEPARATOR)
    .map((part) => (part === "&" || part === ";" ? part : redactPair(part)))
    .join("");
}

function redactPair(pair: string): string {
  const [name, value] = splitOnce(pair, "=");
  if (value !== undefined) {
    return isSensitiveName(decodeURIComponentSafe(name)) ? `${name}=${REDACTED}` : pair;
  }
  // Redact from the encoded separator so the name keeps its original spelling.
  const encoded = ENCODED_EQUALS.exec(pair);
  if (encoded === null) return pair;
  const encodedName = pair.slice(0, encoded.index);
  return isSensitiveName(decodeURIComponentSafe(encodedName))
    ? `${encodedName}${encoded[0]}${REDACTED}`
    : pair;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Severity for a response status. A 4xx is usually the app's own doing and must
 *  not fail `mirin check`; a 5xx is the server failing and should. */
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
