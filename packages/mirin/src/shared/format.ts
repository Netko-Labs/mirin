/**
 * Rendering arbitrary log arguments into a bounded single-line string.
 *
 * Shared by `logger` (main-process log lines) and the devtools taps (renderer
 * console output), both of which need the same answer to "what does this
 * `unknown[]` look like as one message?".
 *
 * Bounded on purpose: a diagnostic stream that an agent reads is only useful if
 * one accidental `logger.info(hugeArray)` cannot bury everything around it.
 */

/** Longest rendered message kept; the remainder becomes an ellipsis marker. */
const MAX_MESSAGE_CHARS = 2000;

/** Longest single argument kept, so one big value can't consume the whole budget. */
const MAX_ARG_CHARS = 800;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(+${text.length - max} chars)`;
}

/** One argument as a string. Errors keep their name and message; the stack is
 *  reported separately by callers that have somewhere structured to put it. */
export function formatArg(value: unknown): string {
  if (typeof value === "string") return truncate(value, MAX_ARG_CHARS);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (value instanceof Error) {
    return truncate(`${value.name}: ${value.message}`, MAX_ARG_CHARS);
  }
  switch (typeof value) {
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "symbol":
    case "function":
      return truncate(String(value), MAX_ARG_CHARS);
    default:
      break;
  }
  try {
    return truncate(JSON.stringify(value) ?? String(value), MAX_ARG_CHARS);
  } catch {
    // Cyclic or non-serializable (a live handle, a Proxy that throws).
    return truncate(Object.prototype.toString.call(value), MAX_ARG_CHARS);
  }
}

/** Log arguments joined into one bounded message, console-style. */
export function formatArgs(args: readonly unknown[]): string {
  return truncate(args.map(formatArg).join(" "), MAX_MESSAGE_CHARS);
}

/** The first `Error` among `args`, if any — the useful source of a stack trace. */
export function firstError(args: readonly unknown[]): Error | undefined {
  return args.find((arg): arg is Error => arg instanceof Error);
}

/** A bounded stack trace, split into frames for structured consumers. */
export function formatStack(error: Error, maxFrames = 12): string[] {
  return (error.stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxFrames);
}
