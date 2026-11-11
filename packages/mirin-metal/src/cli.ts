#!/usr/bin/env bun
/**
 * `mirin-metal run [bun flags] <entry> [args…]`: start a Metal app's driver
 * with the environment a resident app wants (`launch.ts`), as `bun` itself
 * would run it. The process becomes the app (`execve`): no launcher stays
 * behind it.
 *
 *   mirin-metal run app.tsx
 *   mirin-metal run --dev app.tsx      React's development build, from the sources
 *
 * Without `--dev` (and without bun flags before the entry), the app starts
 * from a bundle of itself kept in the user's cache when one was built from
 * its files as they are now, and otherwise from its sources while a bundle
 * is built in the background for the next start (`lib/bundle-cache.ts`).
 * `MIRIN_METAL_BUNDLE=0` always starts from the sources.
 */

import { driverEnv } from "./launch.ts";
import { cachedBundle, claimBuild } from "./lib/bundle-cache.ts";

const USAGE = "usage: mirin-metal run [--dev] [bun flags] <entry> [args…]";
/** The builder's own verb (`mirin-metal __bundle <entry>`), started by `run`. */
const BUILD = "__bundle";
/** How long the builder waits before it builds: the app it was started beside is starting. */
const BUILD_DELAY_MS = 1500;

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

/** The entry as an absolute path, when the first argument is a script (not a bun flag). */
function scriptOf(first: string | undefined): string | null {
  if (first === undefined || first.startsWith("-")) return null;
  if (!/\.[cm]?[jt]sx?$/.test(first)) return null;
  // The file itself, made absolute (no `node:path`: a start loads as little as it can).
  try {
    return Bun.resolveSync(first.startsWith("/") ? first : `./${first}`, process.cwd());
  } catch {
    return null;
  }
}

/**
 * Build the bundle in a process of its own that outlives this one, after a
 * pause (`BUILD_DELAY_MS`). A shell starts it and exits, so it is nobody's
 * child: the app this process becomes never has it to reap.
 */
async function buildInBackground(entry: string, env: Record<string, string>): Promise<void> {
  const shell = Bun.spawn(
    [
      "/bin/sh",
      "-c",
      'exec "$0" "$@" </dev/null >/dev/null 2>&1 &',
      process.execPath,
      import.meta.path,
      BUILD,
      entry,
    ],
    { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  await shell.exited;
}

const [verb, ...rest] = Bun.argv.slice(2);
if (verb === BUILD) {
  const [entry = ""] = rest;
  await Bun.sleep(BUILD_DELAY_MS);
  // Loaded here alone: a start never needs it.
  const { buildBundle } = await import("./lib/bundle-build.ts");
  await buildBundle(entry, process.env.NODE_ENV ?? "production", process.env);
  process.exit(0);
}
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
const env = driverEnv(process.env, { development });
let command = [process.execPath, ...args];
const entry = development || env.MIRIN_METAL_BUNDLE === "0" ? null : scriptOf(args[0]);
if (entry && process.platform !== "win32") {
  const cached = await cachedBundle(entry, env.NODE_ENV ?? "production", env);
  if (cached.state === "fresh") command = [process.execPath, cached.bundle, ...args.slice(1)];
  else if (
    cached.state === "stale" &&
    (await claimBuild(entry, env.NODE_ENV ?? "production", env))
  ) {
    await buildInBackground(entry, env);
  }
}
await become(command, env);
