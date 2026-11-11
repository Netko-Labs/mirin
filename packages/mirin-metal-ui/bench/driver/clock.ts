/**
 * A clock the wire record owns: `setTimeout` and `setInterval` fire when the
 * session advances it, in order, never by the machine's time, and
 * `Math.random` is seeded. A recorded session then sends the same lines on
 * every run, whatever else the machine is doing. Install it before React
 * loads (the scheduler keeps the `setTimeout` it finds).
 */

interface Timer {
  at: number;
  order: number;
  run: () => void;
  every?: number;
}

export interface VirtualClock {
  /** Fire the timers due in the next `ms`, in order; `afterEach` lets their updates land. */
  advance(ms: number, afterEach: () => Promise<void>): Promise<void>;
}

export function installVirtualClock(): VirtualClock {
  let now = 0;
  let order = 0;
  const timers = new Map<number, Timer>();
  const add = (run: () => void, delay: unknown, every: boolean): number => {
    order += 1;
    const ms = Math.max(0, Number(delay) || 0);
    timers.set(order, { at: now + ms, order, run, ...(every ? { every: Math.max(1, ms) } : {}) });
    return order;
  };
  const clear = (id: unknown): void => {
    timers.delete(Number(id));
  };
  // Type-only casts: the stand-ins return a number where Bun returns a Timer object.
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    add(() => fn(...args), delay, false)) as unknown as typeof setTimeout;
  globalThis.setInterval = ((
    fn: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => add(() => fn(...args), delay, true)) as unknown as typeof setInterval;
  globalThis.clearTimeout = clear as typeof clearTimeout;
  globalThis.clearInterval = clear as typeof clearInterval;

  // mulberry32: small, seeded, good enough for a skeleton's width.
  let seed = 0x9e3779b9;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    async advance(ms, afterEach) {
      const end = now + ms;
      for (;;) {
        let next: Timer | undefined;
        for (const timer of timers.values()) {
          if (timer.at > end) continue;
          if (!next || timer.at < next.at || (timer.at === next.at && timer.order < next.order)) {
            next = timer;
          }
        }
        if (!next) break;
        now = Math.max(now, next.at);
        if (next.every !== undefined) next.at += next.every;
        else timers.delete(next.order);
        next.run();
        await afterEach();
      }
      now = end;
    },
  };
}
