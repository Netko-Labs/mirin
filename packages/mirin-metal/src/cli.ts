#!/usr/bin/env bun
/**
 * `mirin-metal run [bun flags] <entry> [args…]`: start a Metal app's driver
 * with the environment a resident app wants (`launch.ts`), as `bun` itself
 * would run it. The process becomes the app (`execve`): no launcher stays
 * behind it.
 *
 *   mirin-metal run app.tsx
 *   mirin-metal run --dev app.tsx      React's development build
 */

import { driverEnv } from "./launch.ts";

const USAGE = "usage: mirin-metal run [--dev] [bun flags] <entry> [args…]";

/** Replace this process with `command`, or run it and exit as it does where that can't be done. */
async function become(command: string[], env: Record<string, string>): Promise<never> {
  const [file = ""] = command;
  // Type-only cast: `process.execve` (POSIX) is newer than the Node typings in use.
  const execve = (
    process as { execve?: (file: string, args: string[], env: Record<string, string>) => never }
  ).execve;
  if (typeof execve === "function" && process.platform !== "win32") {
    execve.call(process, file, command, env);
  }
  const child = Bun.spawn(command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  process.exit(await child.exited);
}

const [verb, ...rest] = Bun.argv.slice(2);
if (verb !== "run" || rest.length === 0) {
  console.error(USAGE);
  process.exit(verb === "--help" || verb === "-h" ? 0 : 2);
}
const development = rest[0] === "--dev";
const args = development ? rest.slice(1) : rest;
if (args.length === 0) {
  console.error(USAGE);
  process.exit(2);
}
await become([process.execPath, ...args], driverEnv(process.env, { development }));
