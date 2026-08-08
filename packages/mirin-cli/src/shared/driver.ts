/**
 * The `CheckDriver` a scenario is handed, implemented over a running app's
 * inspector (docs/agent-devtools.md). Failures throw; `runScenario` turns the
 * throw into a failed check.
 */

import type { CheckDriver, CheckWindow, WindowTarget } from "mirinjs/check";
import type { DevEvent, DevEventQuery } from "mirinjs/devtools/session";
import type { InspectorClient } from "./inspector.ts";

/** How long `expectText` waits for the UI to catch up with an RPC round trip. */
const EXPECT_TIMEOUT_MS = 2_000;
const EXPECT_POLL_MS = 100;

/** Thrown by `assert` / `expectText`, and by a step that fails. */
export class CheckAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckAssertionError";
  }
}

export interface ScenarioStep {
  name: string;
  ok: boolean;
  ms: number;
}

export interface ScenarioOutcome {
  steps: ScenarioStep[];
  screenshots: string[];
  /** Set when the scenario threw; the step it was in is in `steps`. */
  failure?: { step: string; message: string };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function windowQuery(options: WindowTarget | undefined): string {
  return options?.window !== undefined ? `?window=${options.window}` : "";
}

function windowsOf(state: unknown): CheckWindow[] {
  const list = record(state).windows;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const win = record(entry);
    const id = win.id;
    const name = win.name;
    if (typeof id !== "number") return [];
    return [
      {
        id,
        name: typeof name === "string" ? name : `window-${id}`,
        ...(typeof win.url === "string" ? { url: win.url } : {}),
        ...(typeof win.title === "string" ? { title: win.title } : {}),
      },
    ];
  });
}

/** `onStep` mirrors steps into the event stream, so the app's log and the
 *  scenario's progress interleave in one timeline. */
export function createDriver(
  client: InspectorClient,
  onStep?: (name: string) => void,
): { driver: CheckDriver; outcome: ScenarioOutcome; finishStep(ok: boolean): void } {
  const steps: ScenarioStep[] = [];
  const screenshots: string[] = [];
  const outcome: ScenarioOutcome = { steps, screenshots };
  let startedAt = Date.now();

  const finishStep = (ok: boolean): void => {
    const current = steps.at(-1);
    if (current !== undefined && current.ms === -1) {
      current.ok = ok;
      current.ms = Date.now() - startedAt;
    }
  };

  const act = async (body: Record<string, unknown>, options?: WindowTarget): Promise<void> => {
    await client.post(`/act${windowQuery(options)}`, body);
  };

  const driver: CheckDriver = {
    step(name) {
      finishStep(true);
      steps.push({ name, ok: false, ms: -1 });
      startedAt = Date.now();
      onStep?.(name);
    },

    async click(selector, options) {
      await act(
        {
          action: "click",
          selector,
          ...(options?.clickCount !== undefined ? { clickCount: options.clickCount } : {}),
        },
        options,
      );
    },

    async type(text, options) {
      await act(
        {
          action: "type",
          text,
          ...(options?.selector !== undefined ? { selector: options.selector } : {}),
        },
        options,
      );
    },

    async key(name, options) {
      await act({ action: "key", key: name }, options);
    },

    async scroll(options) {
      await act(
        { action: "scroll", deltaY: options.deltaY ?? 0, deltaX: options.deltaX ?? 0 },
        options,
      );
    },

    async waitFor(selector, options) {
      await act(
        {
          action: "wait",
          selector,
          ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        },
        options,
      );
    },

    async sleep(ms) {
      await Bun.sleep(ms);
    },

    async snapshot(options) {
      const query = new URLSearchParams();
      if (options?.window !== undefined) query.set("window", String(options.window));
      if (options?.format !== undefined) query.set("format", options.format);
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      const result = record(await client.get(`/snapshot${suffix}`));
      const snapshot = result.snapshot;
      if (typeof snapshot !== "string") throw new Error("the app returned no snapshot");
      return snapshot;
    },

    async evaluate(expression, options) {
      const result = record(await client.post(`/eval${windowQuery(options)}`, { expression }));
      // The route reports a page-side throw as ok:false rather than as HTTP 500.
      if (result.ok === false) {
        throw new Error(`eval failed: ${String(result.error ?? "unknown error")}`);
      }
      return result.value as never;
    },

    async screenshot(label, options) {
      const query = new URLSearchParams();
      if (options?.window !== undefined) query.set("window", String(options.window));
      // Default the label to the current step, so screenshots stay identifiable.
      query.set("label", label ?? steps.at(-1)?.name ?? `shot-${screenshots.length + 1}`);
      const result = record(await client.get(`/screenshot?${query.toString()}`));
      const path = result.path;
      if (typeof path !== "string") throw new Error("the app returned no screenshot path");
      screenshots.push(path);
      return path;
    },

    async windows() {
      return windowsOf(await client.get("/state"));
    },

    async exposed() {
      return record(record(await client.get("/state")).exposed);
    },

    async logs(query: DevEventQuery = {}) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        for (const entry of Array.isArray(value) ? value : [value]) {
          params.append(key, String(entry));
        }
      }
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const events = record(await client.get(`/logs${suffix}`)).events;
      return Array.isArray(events) ? (events as DevEvent[]) : [];
    },

    async cdp(method, params, options) {
      const result = record(
        await client.post(`/cdp${windowQuery(options)}`, { method, params: params ?? {} }),
      );
      if (result.ok === false) {
        throw new Error(`${method} failed: ${String(result.error ?? "unknown error")}`);
      }
      return result.result as never;
    },

    assert(condition, message) {
      if (!condition) throw new CheckAssertionError(message);
    },

    async waitUntil(condition, message, options) {
      const timeoutMs = options?.timeoutMs ?? EXPECT_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        // A condition that throws counts as "not yet"; the timeout makes it a failure.
        let held: unknown = false;
        try {
          held = await condition();
        } catch {
          held = false;
        }
        if (held) return;
        if (Date.now() >= deadline) {
          throw new CheckAssertionError(`${message} (waited ${timeoutMs}ms)`);
        }
        await Bun.sleep(EXPECT_POLL_MS);
      }
    },

    async expectText(text, options) {
      await driver.waitUntil(
        async () => (await driver.snapshot(options)).includes(text),
        `expected the UI to contain ${JSON.stringify(text)}`,
        ...(options?.timeoutMs !== undefined ? [{ timeoutMs: options.timeoutMs }] : []),
      );
    },
  };

  return { driver, outcome, finishStep };
}
