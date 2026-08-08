/**
 * The contract a `mirin check` scenario is written against. Types live in the
 * runtime package so an app can import them without the CLI's internals; the
 * implementation lives in the CLI, which holds the inspector connection.
 */

import type { DevEvent, DevEventQuery } from "../devtools/types.ts";

/** A window as the scenario sees it. */
export interface CheckWindow {
  id: number;
  name: string;
  url?: string;
  title?: string;
}

/** Which window an action targets. Omit when the app has only one. */
export interface WindowTarget {
  window?: number;
}

/**
 * The app under check. Every method talks to the running app's inspector.
 * Anything that cannot be done rejects, and an unhandled rejection fails the check.
 */
export interface CheckDriver {
  /** Click an element. Selectors accept CSS or `text=Save`. */
  click(selector: string, options?: WindowTarget & { clickCount?: number }): Promise<void>;
  /** Type text, optionally focusing `selector` first. */
  type(text: string, options?: WindowTarget & { selector?: string }): Promise<void>;
  /** Press a named key, e.g. `Enter`, `Escape`, `Tab`. */
  key(name: string, options?: WindowTarget): Promise<void>;
  scroll(options: WindowTarget & { deltaY?: number; deltaX?: number }): Promise<void>;
  /** Wait for a selector to match, rejecting if it never does. */
  waitFor(selector: string, options?: WindowTarget & { timeoutMs?: number }): Promise<void>;
  /** Wait a fixed time. Prefer `waitFor` — a sleep is a guess. */
  sleep(ms: number): Promise<void>;

  /** The accessibility tree, or the DOM with `format: "dom"`. */
  snapshot(options?: WindowTarget & { format?: "ax" | "dom" }): Promise<string>;
  /** Evaluate an expression in the page and return its value. */
  evaluate<T = unknown>(expression: string, options?: WindowTarget): Promise<T>;
  /** Capture a screenshot into the session dir; returns its path. */
  screenshot(label?: string, options?: WindowTarget): Promise<string>;
  windows(): Promise<CheckWindow[]>;
  /** Slices the app published with `devtools.expose`. */
  exposed(): Promise<Record<string, unknown>>;
  /** The event stream so far, filtered the same way as the inspector's `/logs`. */
  logs(query?: DevEventQuery): Promise<DevEvent[]>;
  /**
   * Send a raw DevTools-protocol command, for anything the methods above do not cover.
   *
   * ```ts
   * const [call] = await app.logs({ type: "network.response", contains: "/api/todos" });
   * const body = await app.cdp<{ body: string }>("Network.getResponseBody", {
   *   requestId: call.data.requestId,
   * });
   * ```
   */
  cdp<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options?: WindowTarget,
  ): Promise<T>;

  /** Fail the check unless `condition` is truthy, right now. After an interaction,
   *  prefer `waitUntil` — the RPC round trip has not landed yet. */
  assert(condition: unknown, message: string): asserts condition;
  /**
   * Poll `condition` until it holds, failing the check with `message` if it never
   * does. The general form of `expectText`.
   *
   * ```ts
   * await app.waitUntil(
   *   async () => (await app.evaluate<number>("todos.length")) > 0,
   *   "the todo never reached the list",
   * );
   * ```
   */
  waitUntil(
    condition: () => Promise<unknown> | unknown,
    message: string,
    options?: { timeoutMs?: number },
  ): Promise<void>;
  /** Fail the check unless the window's accessibility tree contains `text`. Polls
   *  until the timeout (2s by default): a single read would be flaky by construction. */
  expectText(text: string, options?: WindowTarget & { timeoutMs?: number }): Promise<void>;

  /** Name the phase the scenario is in. Steps appear in the report and the event
   *  stream, so a failure says which step it happened in. */
  step(name: string): void;
}

/** A scenario: drive the app, throw to fail. */
export type CheckScenario = (app: CheckDriver) => Promise<void> | void;
