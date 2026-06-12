/**
 * mirin/logger — a small leveled logger for the Bun main process.
 *
 * Exported from `mirinjs` so app code and mirin itself log consistently. The
 * level defaults from the `MIRIN_LOG` env var (`debug` | `info` | `warn` |
 * `error` | `silent`), falling back to `info`; change it at runtime with
 * `logger.setLevel(...)`. `warn`/`error` go to stderr, `debug`/`info` to stdout.
 *
 *   import { logger } from "mirinjs";
 *   logger.info("server listening", port);
 *   const db = logger.child("db");
 *   db.debug("query", sql);            // → [mirin:db] debug query …
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const COLOR = {
  debug: "\x1b[2m", // dim
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  dim: "\x1b[2m",
  reset: "\x1b[0m",
} as const;

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error", "silent"];

function envLevel(): LogLevel {
  const v = (process.env.MIRIN_LOG ?? "").toLowerCase() as LogLevel;
  return LEVELS.includes(v) ? v : "info";
}

// Shared across every logger instance so `setLevel` is global.
let currentLevel: LogLevel = envLevel();
const useColor = Boolean(process.stderr.isTTY) && process.env.NO_COLOR == null;

/** Set the global minimum level. Messages below it are dropped. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** The current global log level. */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

export class Logger {
  /** @param scope optional dotted scope shown as `[mirin:scope]`. */
  constructor(private readonly scope?: string) {}

  /** Derive a scoped child logger (e.g. `logger.child("db")`). */
  child(scope: string): Logger {
    return new Logger(this.scope ? `${this.scope}:${scope}` : scope);
  }

  /** Set the global level (same as the exported `setLogLevel`). */
  setLevel(level: LogLevel): void {
    setLogLevel(level);
  }

  get level(): LogLevel {
    return currentLevel;
  }

  debug(...args: unknown[]): void {
    this.#emit("debug", args);
  }
  info(...args: unknown[]): void {
    this.#emit("info", args);
  }
  warn(...args: unknown[]): void {
    this.#emit("warn", args);
  }
  error(...args: unknown[]): void {
    this.#emit("error", args);
  }

  #emit(level: Exclude<LogLevel, "silent">, args: unknown[]): void {
    if (ORDER[level] < ORDER[currentLevel]) return;
    const name = this.scope ? `[mirin:${this.scope}]` : "[mirin]";
    const prefix = useColor ? `${COLOR.dim}${name}${COLOR.reset}` : name;
    const tag = useColor ? `${COLOR[level]}${level}${COLOR.reset}` : level;
    const sink = level === "warn" || level === "error" ? console.error : console.log;
    sink(`${prefix} ${tag}`, ...args);
  }
}

/** The default mirin logger. Import and use directly, or derive children. */
export const logger = new Logger();
