import { writeSync } from "node:fs";
import { format } from "node:util";
import { record } from "../devtools/sink.ts";
import type { DevEventLevel } from "../devtools/types.ts";
import { firstError, formatArgs, formatStack } from "./format.ts";

export type LineWriter = (fd: 1 | 2, line: string) => void;

// The app Worker's console normally hands output to the main thread, which sits
// inside CEF's message loop for the life of the app, so nothing is ever written.
// A direct fd write from the Worker thread bypasses that.
export function writeLine(fd: 1 | 2, line: string): void {
  try {
    writeSync(fd, line.endsWith("\n") ? line : `${line}\n`);
  } catch {
    // A closed pipe (parent gone) must not take the app down with a log line.
  }
}

const CONSOLE_LEVELS = {
  log: "info",
  info: "info",
  debug: "debug",
  warn: "warn",
  error: "error",
} as const satisfies Record<string, DevEventLevel>;

export type ConsoleMethod = keyof typeof CONSOLE_LEVELS;

/** Route `console.*` from the Worker to fd 1/2 directly and into the devtools sink. */
export function installWorkerConsole(write: LineWriter = writeLine): void {
  for (const method of Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]) {
    const level = CONSOLE_LEVELS[method];
    console[method] = (...args: unknown[]) => {
      write(level === "warn" || level === "error" ? 2 : 1, format(...args));
      const error = firstError(args);
      record({
        src: "main",
        level,
        type: "console",
        msg: formatArgs(args),
        data: { method, ...(error !== undefined ? { stack: formatStack(error) } : {}) },
      });
    };
  }
}
