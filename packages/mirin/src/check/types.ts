/**
 * The contract a `mirin check` scenario is written against.
 *
 * The types live in the runtime package so an app can import them without
 * depending on the CLI's internals; the implementation lives in the CLI, which is
 * the process that actually holds the inspector connection. The same split as
 * `devtools/session`.
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
 * The app under check, as a scenario drives it.
 *
 * Every method talks to the running app's inspector, so a failure is a real
 * failure of the app rather than of a simulation. Anything that cannot be done —
 * a selector that matches nothing, an expression that throws — rejects, and an
 * unhandled rejection fails the check.
 */
export interface CheckDriver {
  // --- drive ---

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

  // --- observe ---

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
   * Send a raw DevTools-protocol command, for anything the methods above do not
   * cover. The usual pairing is with `logs`: a `network.request` event carries a
   * `requestId`, and `Network.getResponseBody` turns it into the body.
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

  // --- verify ---

  /**
   * Fail the check unless `condition` is truthy, right now.
   *
   * For anything that follows an interaction, prefer `waitUntil` — an RPC round
   * trip has not landed by the time the action that triggered it returns.
   */
  assert(condition: unknown, message: string): asserts condition;
  /**
   * Poll `condition` until it holds, failing the check with `message` if it never
   * does. The general form of `expectText`, for state that is not text in the
   * tree.
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
  /**
   * Fail the check unless the window's accessibility tree contains `text`.
   *
   * Polls until it does or the timeout expires (2s by default). Nearly every
   * assertion in a desktop app follows an RPC round trip, so an assertion that
   * read the tree once would be flaky by construction.
   */
  expectText(text: string, options?: WindowTarget & { timeoutMs?: number }): Promise<void>;

  /**
   * Name the phase the scenario is in. Steps appear in the report and in the
   * event stream, so a failure says which step it happened in.
   */
  step(name: string): void;
}

/** A scenario: drive the app, throw to fail. */
export type CheckScenario = (app: CheckDriver) => Promise<void> | void;
