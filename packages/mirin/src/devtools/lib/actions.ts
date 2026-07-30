/**
 * Synthetic input over CDP: the "drive the app" half of the devtools
 * (docs/agent-devtools.md).
 *
 * Two design points worth knowing:
 *
 * 1. Targets can be named by text, not just CSS. The snapshot a reader works from
 *    is an accessibility tree — roles and names, no class attributes — so
 *    `text=Save` is the selector that matches what the reader actually saw.
 * 2. Input goes through `Input.dispatch*Event`, not `element.click()`. A real event
 *    sequence exercises the same path a person's click would, so a reproduction is
 *    a reproduction rather than an approximation.
 *
 * Selector strings are page-controlled input from the inspector's point of view and
 * are always embedded with `JSON.stringify`, never concatenated into the script.
 */

import { asBoolean, asNumber, asRecord, asString } from "./parse.ts";

/** Keys worth naming. Printable characters go through `type` instead. */
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { code: "Space", keyCode: 32, text: " " },
};

export const KEY_NAMES: string[] = Object.keys(KEYS);

/** Sends a CDP command for one page. Supplied by the bridge. */
export type Send = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface Located {
  x: number;
  y: number;
  tag: string;
}

/**
 * Build the page script that resolves a selector to a click point.
 *
 * `text=…` matches an element's accessible-ish label — trimmed text, `value`,
 * `aria-label`, `placeholder`, or `title` — preferring an exact match, then the
 * most deeply nested candidate so a wrapping container never wins over the button
 * inside it. Anything else is treated as CSS (`css=` may be given explicitly).
 */
export function locateScript(selector: string): string {
  const text = selector.startsWith("text=") ? selector.slice(5) : undefined;
  const css = selector.startsWith("css=") ? selector.slice(4) : selector;

  const find =
    text !== undefined
      ? `(() => {
           const want = ${JSON.stringify(text)}.trim().toLowerCase();
           const label = (el) => (
             el.getAttribute?.("aria-label") ||
             el.getAttribute?.("placeholder") ||
             el.getAttribute?.("title") ||
             (el.value != null && typeof el.value === "string" ? el.value : "") ||
             el.textContent || ""
           ).trim().toLowerCase();
           const all = Array.from(document.querySelectorAll("*"))
             .filter((el) => !["SCRIPT","STYLE","HEAD","META","LINK","TITLE"].includes(el.tagName));
           const exact = all.filter((el) => label(el) === want);
           const partial = exact.length ? [] : all.filter((el) => label(el).includes(want));
           const pool = exact.length ? exact : partial;
           // Deepest candidate: the innermost element still carrying the label.
           return pool.sort((a, b) => b.querySelectorAll("*").length - a.querySelectorAll("*").length).pop() || null;
         })()`
      : `document.querySelector(${JSON.stringify(css)})`;

  return `(() => {
    const el = ${find};
    if (!el) return { found: false };
    if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return { found: true, visible: false, tag: el.tagName.toLowerCase() };
    return {
      found: true,
      visible: true,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      tag: el.tagName.toLowerCase(),
    };
  })()`;
}

export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

/** Resolve a selector to a click point in the page's viewport. */
export async function locate(send: Send, selector: string): Promise<Located> {
  const result = await send("Runtime.evaluate", {
    expression: locateScript(selector),
    returnByValue: true,
  });
  const value = asRecord(asRecord(result.result)?.value);
  if (asBoolean(value?.found) !== true) {
    throw new ActionError(`no element matched ${selector}`);
  }
  if (asBoolean(value?.visible) !== true) {
    throw new ActionError(`element matched ${selector} but has no visible box`);
  }
  const x = asNumber(value?.x);
  const y = asNumber(value?.y);
  if (x === undefined || y === undefined) {
    throw new ActionError(`element matched ${selector} but has no position`);
  }
  return { x, y, tag: asString(value?.tag) ?? "" };
}

/** Press and release the left button at a selector's center. */
export async function click(send: Send, selector: string, clickCount = 1): Promise<Located> {
  const at = await locate(send, selector);
  const base = { x: at.x, y: at.y, button: "left", clickCount, buttons: 1 };
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  return at;
}

/**
 * Insert text as if typed, into the selector's element when one is given.
 *
 * Focus comes from a real click rather than `el.focus()`, so the field receives the
 * same event sequence a person would produce.
 */
export async function type(send: Send, text: string, selector?: string): Promise<void> {
  if (selector !== undefined) await click(send, selector);
  // insertText goes through the same IME path as real typing and handles the whole
  // string at once, which is both faster and less flaky than per-character events.
  await send("Input.insertText", { text });
}

/** Press a named key (see {@link KEY_NAMES}). */
export async function key(send: Send, name: string): Promise<void> {
  const spec = KEYS[name];
  if (spec === undefined) {
    throw new ActionError(`unknown key "${name}" — try one of: ${KEY_NAMES.join(", ")}`);
  }
  const base = {
    key: name === "Space" ? " " : name,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    ...(spec.text !== undefined ? { text: spec.text } : {}),
  };
  // Printable keys need `keyDown` to deliver their text; the rest use rawKeyDown.
  await send("Input.dispatchKeyEvent", {
    type: spec.text !== undefined ? "keyDown" : "rawKeyDown",
    ...base,
  });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** Scroll by a wheel delta, at a selector's center or the viewport's top-left. */
export async function scroll(
  send: Send,
  deltaY: number,
  deltaX = 0,
  selector?: string,
): Promise<void> {
  const at = selector !== undefined ? await locate(send, selector) : { x: 10, y: 10 };
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: at.x,
    y: at.y,
    deltaX,
    deltaY,
  });
}

/** Poll until a selector matches, or throw when the deadline passes. */
export async function waitFor(send: Send, selector: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = `no element matched ${selector}`;
  while (Date.now() < deadline) {
    try {
      await locate(send, selector);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(100);
  }
  throw new ActionError(`timed out after ${timeoutMs}ms: ${lastError}`);
}
