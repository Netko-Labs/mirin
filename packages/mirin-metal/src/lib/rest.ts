/**
 * One collection when the app goes quiet, in place of Bun's timer. Bun
 * collects once a second while the heap changes size and for half a minute
 * after, each time waking the collector's threads: an app at rest wakes
 * several times a second for that half minute after anything it does.
 * `driverEnv()` turns that timer off (`BUN_GC_TIMER_DISABLE`), and then a
 * driver collects once, `QUIET_MS` after its last commit, so what a burst of
 * work left behind is still freed while the app rests. Collections while it
 * works are JavaScriptCore's own, as allocation calls for them. The
 * collection is on the main thread (an asynchronous one never finishes in
 * a process that sleeps): about 1 ms for a small app, 10 to 25 ms for the
 * example browser after a hundred interactions, once per burst, where Bun's
 * timer collects thirty times.
 *
 * Nothing here runs when the timer is on: Bun collects then.
 */

/** How long without a commit counts as quiet. */
export const QUIET_MS = 2000;

const enabled =
  typeof Bun !== "undefined" &&
  process.env.BUN_GC_TIMER_DISABLE !== undefined &&
  process.env.BUN_GC_TIMER_DISABLE !== "0";

let timer: ReturnType<typeof setTimeout> | null = null;
let lastCommit = 0;

/** A commit happened: collect once it has been quiet for `QUIET_MS`. */
export function committed(): void {
  if (!enabled) return;
  lastCommit = performance.now();
  // One timer for a burst: it looks again when it fires, rather than being made per commit.
  if (timer === null) wait(QUIET_MS);
}

function wait(ms: number): void {
  timer = setTimeout(atRest, ms);
  // Collecting is no reason to stay alive.
  timer.unref();
}

function atRest(): void {
  const quiet = performance.now() - lastCommit;
  if (quiet < QUIET_MS) {
    wait(QUIET_MS - quiet);
    return;
  }
  timer = null;
  // A full collection, now: `Bun.gc(false)` only asks for one, which an
  // idle process never gets to, and `Bun.gc(true)` also drops compiled code.
  const { fullGC } = require("bun:jsc") as typeof import("bun:jsc");
  fullGC();
}
