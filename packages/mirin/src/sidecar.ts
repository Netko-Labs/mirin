/**
 * Sidecars — spawn a binary bundled into the `.app` (declared in
 * `mirin.config.ts` `sidecars`). A thin wrapper over `Bun.spawn` that resolves
 * the bundled path (dev or prod, via `runtime().sidecarDir`) and tracks the
 * child so it's killed when the app quits — the two things hand-rolled
 * `Bun.spawn` gets wrong (path resolution + orphaned processes).
 *
 * Sidecars run as separate OS processes, so they may do anything a CLI can; they
 * just can't touch the app's AppKit/CEF UI (nothing off the main thread can).
 */

import { join } from "node:path";
import { onNativeEvent, runtime } from "./runtime.ts";

export interface SidecarOptions {
  /** Arguments passed after the binary path. */
  args?: string[];
  cwd?: string;
  /** Extra env on top of the inherited environment. */
  env?: Record<string, string>;
  /** Defaults: stdin "pipe", stdout "pipe", stderr "inherit". */
  stdin?: Bun.SpawnOptions.Writable;
  stdout?: Bun.SpawnOptions.Readable;
  stderr?: Bun.SpawnOptions.Readable;
}

/** A running sidecar. Mirrors the subset of `Bun.Subprocess` apps need. */
export interface SidecarProcess {
  readonly pid: number;
  readonly stdin: Bun.Subprocess["stdin"];
  readonly stdout: Bun.Subprocess["stdout"];
  readonly stderr: Bun.Subprocess["stderr"];
  /** Resolves with the exit code when the process ends. */
  readonly exited: Promise<number>;
  /** Send a signal (default SIGTERM) and stop tracking it. */
  kill(signal?: number | NodeJS.Signals): void;
}

const children = new Set<Bun.Subprocess>();
let hooked = false;

function killAll(): void {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
  children.clear();
}

/** Register shutdown hooks once, so sidecars don't outlive the app. */
function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  // App fully quit (last window closed / Cmd-Q path surfaces here).
  onNativeEvent("window.all-closed", killAll);
  // Worker-process shutdown backstops (normal exit / signals). `terminate()` is
  // abrupt and won't fire these, hence the native-event hook above as well.
  for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) {
    process.on(sig, killAll);
  }
}

/**
 * Spawn a bundled sidecar binary by its config name. Throws if the runtime
 * isn't attached or no `sidecarDir` is known (e.g. run outside the host).
 */
export function sidecar(name: string, opts: SidecarOptions = {}): SidecarProcess {
  const dir = runtime().sidecarDir;
  if (!dir) {
    throw new Error(
      `app.sidecar("${name}"): no sidecar dir (is this running under the mirin host?)`,
    );
  }
  ensureHooks();

  const bin = join(dir, name);
  const child = Bun.spawn([bin, ...(opts.args ?? [])], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: opts.stdin ?? "pipe",
    stdout: opts.stdout ?? "pipe",
    stderr: opts.stderr ?? "inherit",
  });
  children.add(child);
  void child.exited.then(() => children.delete(child));

  return {
    get pid() {
      return child.pid;
    },
    get stdin() {
      return child.stdin;
    },
    get stdout() {
      return child.stdout;
    },
    get stderr() {
      return child.stderr;
    },
    exited: child.exited,
    kill(signal) {
      children.delete(child);
      child.kill(signal as number | undefined);
    },
  };
}
