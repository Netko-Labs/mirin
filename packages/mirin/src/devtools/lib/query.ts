/**
 * Log query parsing and matching. Pure — the inspector parses untrusted URL
 * search params here, and the sink applies the result to its ring buffer.
 */

import type { DevEvent, DevEventLevel, DevEventQuery, DevEventSource } from "../types.ts";

const LEVEL_ORDER: Record<DevEventLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SOURCES: DevEventSource[] = ["main", "renderer", "native", "rpc", "app"];
const LEVELS: DevEventLevel[] = ["debug", "info", "warn", "error"];

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;

function isLevel(value: string): value is DevEventLevel {
  return (LEVELS as string[]).includes(value);
}

function isSource(value: string): value is DevEventSource {
  return (SOURCES as string[]).includes(value);
}

/** Split a repeatable comma-or-multi param into trimmed, non-empty parts. */
function list(params: URLSearchParams, key: string): string[] {
  return params
    .getAll(key)
    .flatMap((raw) => raw.split(","))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function positiveInt(raw: string | null): number | undefined {
  if (raw == null) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Parse `/logs` search params into a query. Unknown or malformed values are
 *  dropped, not rejected: a slightly-wrong guess should still get an answer. */
export function parseQuery(params: URLSearchParams): DevEventQuery {
  const query: DevEventQuery = {};

  const since = positiveInt(params.get("since"));
  if (since !== undefined) query.since = since;

  const level = params.get("level")?.trim().toLowerCase();
  if (level !== undefined && isLevel(level)) query.level = level;

  const src = list(params, "src").filter(isSource);
  if (src.length > 0) query.src = src;

  const window = list(params, "window")
    .map((raw) => Number(raw))
    .filter((value) => Number.isSafeInteger(value));
  if (window.length > 0) query.window = window;

  const type = list(params, "type");
  if (type.length > 0) query.type = type;

  const contains = params.get("contains");
  if (contains != null && contains.length > 0) query.contains = contains;

  const limit = positiveInt(params.get("limit"));
  query.limit = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  return query;
}

export function matches(event: DevEvent, query: DevEventQuery): boolean {
  if (query.since !== undefined && event.seq <= query.since) return false;
  if (query.level !== undefined && LEVEL_ORDER[event.level] < LEVEL_ORDER[query.level])
    return false;
  if (query.src !== undefined && !query.src.includes(event.src)) return false;
  if (query.window !== undefined) {
    if (event.window === undefined || !query.window.includes(event.window)) return false;
  }
  if (query.type !== undefined && !query.type.some((prefix) => event.type.startsWith(prefix))) {
    return false;
  }
  if (query.contains !== undefined) {
    if (!event.msg.toLowerCase().includes(query.contains.toLowerCase())) return false;
  }
  return true;
}

/** The most recent `limit` events matching `query`, oldest first. */
export function selectEvents(events: readonly DevEvent[], query: DevEventQuery): DevEvent[] {
  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const hits: DevEvent[] = [];
  // Walk newest → oldest so `limit` keeps the tail, then restore order.
  for (let i = events.length - 1; i >= 0 && hits.length < limit; i--) {
    const event = events[i];
    if (event !== undefined && matches(event, query)) hits.push(event);
  }
  return hits.reverse();
}
