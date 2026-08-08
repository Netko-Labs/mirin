/**
 * Narrowing helpers for the devtools trust boundaries. Every helper is total —
 * `undefined` instead of a throw, so a malformed field degrades one value rather
 * than failing a whole request.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Parse JSON text without throwing. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Parse JSON text that must be an object. */
export function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  return asRecord(parseJson(text));
}

/** One of `allowed`, or `undefined`. Keeps string unions honest at boundaries. */
export function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const text = asString(value);
  return text !== undefined && (allowed as readonly string[]).includes(text)
    ? (text as T)
    : undefined;
}
