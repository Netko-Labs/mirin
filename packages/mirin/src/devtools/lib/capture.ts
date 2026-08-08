/**
 * Screenshot capture. A transparent (OSR) window has no page background, so
 * `Page.captureScreenshot` returns alpha 0 and viewers composite it onto white —
 * a blank page. An opaque backdrop is painted under the page for the capture,
 * and `composited` tells the caller the image is no longer pixel-truth.
 */

import type { CdpPage } from "./cdp.ts";
import { asBoolean, asRecord, asString } from "./parse.ts";

/** The slice of a CDP page this module needs. */
export type CapturablePage = Pick<CdpPage, "send">;

/** Backdrops for a transparent page, chosen to match the page's own scheme. */
const DARK_BACKDROP = "#1c1c1e";
const LIGHT_BACKDROP = "#ffffff";

/** `#rgb` or `#rrggbb`. */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Transparent only when *both* the root element and the body are clear. The
 *  backdrop must contrast with the body's text colour; the OS scheme is only a
 *  fallback — a glass window renders light text whatever the system is set to. */
const APPEARANCE_EXPRESSION = [
  "(() => {",
  '  const clear = (c) => c === "transparent" || c.split(" ").join("") === "rgba(0,0,0,0)";',
  "  const html = getComputedStyle(document.documentElement).backgroundColor;",
  "  const body = document.body ? getComputedStyle(document.body) : null;",
  '  const background = body ? body.backgroundColor : "transparent";',
  "  return {",
  "    transparent: clear(html) && clear(background),",
  '    color: body ? body.color : "",',
  '    dark: matchMedia("(prefers-color-scheme: dark)").matches,',
  "  };",
  "})()",
].join("\n");

/** Perceived brightness (Rec. 601 luma) of an `rgb(…)`/`rgba(…)` string on 0–1,
 *  or undefined when it cannot be read. */
function brightness(color: string): number | undefined {
  const parts = color.match(/[\d.]+/g);
  if (parts === null || parts.length < 3) return undefined;
  const [red, green, blue] = parts.slice(0, 3).map(Number);
  if (red === undefined || green === undefined || blue === undefined) return undefined;
  if ([red, green, blue].some((channel) => !Number.isFinite(channel))) return undefined;
  return (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
}

export interface CaptureOptions {
  format: "png" | "jpeg";
  quality?: number;
  /** Capture the scrolled-out remainder of the page too. */
  full?: boolean;
  /**
   * `#rrggbb` to force a backdrop, `null` to capture exactly what the page renders
   * (alpha and all), or undefined to decide from the page itself.
   */
  backdrop?: string | null;
}

export interface CaptureResult {
  /** Pinned to a concrete `ArrayBuffer` so the bytes can be used as a response body. */
  bytes: Uint8Array<ArrayBuffer>;
  /** True when an opaque backdrop was painted under the page for this capture. */
  composited: boolean;
  /** The backdrop that was used, when one was. */
  backdrop?: string;
}

/** Read a caller-supplied `backdrop` parameter. An unparseable value falls back to
 *  automatic rather than failing the request. */
export function parseBackdrop(raw: string | null): string | null | undefined {
  if (raw === null) return undefined;
  if (raw === "none") return null;
  return HEX_COLOR.test(raw) ? raw.toLowerCase() : undefined;
}

/** Which backdrop this capture should use, or undefined for none. */
async function resolveBackdrop(
  page: CapturablePage,
  requested: string | null | undefined,
): Promise<string | undefined> {
  if (requested === null) return undefined;
  if (requested !== undefined) return requested;

  // Automatic: only a transparent page needs one, and only the page knows.
  // A probe failure is not a capture failure.
  try {
    const result = await page.send("Runtime.evaluate", {
      expression: APPEARANCE_EXPRESSION,
      returnByValue: true,
    });
    const value = asRecord(asRecord(result.result)?.value);
    if (asBoolean(value?.transparent) !== true) return undefined;

    // Light text needs a dark backdrop, and vice versa.
    const textBrightness = brightness(asString(value?.color) ?? "");
    const wantsDark =
      textBrightness !== undefined ? textBrightness > 0.5 : asBoolean(value?.dark) === true;
    return wantsDark ? DARK_BACKDROP : LIGHT_BACKDROP;
  } catch {
    return undefined;
  }
}

// One capture at a time per page: interleaved captures would stash the first one's
// backdrop as "the original", leaving the page permanently composited.
const captures = new WeakMap<CapturablePage, Promise<unknown>>();

function serialize<T>(page: CapturablePage, run: () => Promise<T>): Promise<T> {
  const previous = captures.get(page) ?? Promise.resolve();
  // Run whether the previous capture resolved or threw: one failure must not
  // wedge later captures.
  const next = previous.then(run, run);
  captures.set(
    page,
    next.catch(() => undefined),
  );
  return next;
}

/** Capture `page`, compositing a backdrop under it when it would otherwise be clear. */
export function capturePage(page: CapturablePage, options: CaptureOptions): Promise<CaptureResult> {
  return serialize(page, () => captureOnce(page, options));
}

async function captureOnce(page: CapturablePage, options: CaptureOptions): Promise<CaptureResult> {
  const backdrop = await resolveBackdrop(page, options.backdrop);
  const applied = backdrop !== undefined && (await setBackdrop(page, backdrop));

  try {
    const result = await page.send("Page.captureScreenshot", {
      format: options.format,
      ...(options.format === "jpeg" && options.quality !== undefined
        ? { quality: options.quality }
        : {}),
      ...(options.full === true ? { captureBeyondViewport: true } : {}),
    });
    const base64 = asString(result.data);
    if (base64 === undefined) return { bytes: new Uint8Array(0), composited: false };
    return {
      bytes: Buffer.from(base64, "base64"),
      composited: applied,
      ...(applied && backdrop !== undefined ? { backdrop } : {}),
    };
  } finally {
    // Always restore, even on a throw: the override is page state.
    if (applied) await clearBackdrop(page);
  }
}

/** Paint the backdrop and wait for it to render, by styling the document: CEF
 *  accepts `Emulation.setDefaultBackgroundColorOverride` and then ignores it on
 *  the windowless (OSR) path. Returns whether the backdrop actually went on. */
async function setBackdrop(page: CapturablePage, color: string): Promise<boolean> {
  // `color` is a validated hex literal, embedded with JSON.stringify — a value
  // from a request never becomes script.
  const expression = [
    "(async () => {",
    "  const root = document.documentElement;",
    "  root.dataset.mirinBackdrop = JSON.stringify([",
    '    root.style.getPropertyValue("background-color"),',
    '    root.style.getPropertyPriority("background-color"),',
    "  ]);",
    `  root.style.setProperty("background-color", ${JSON.stringify(color)}, "important");`,
    // Two frames: one to apply the style, one for the compositor to paint it.
    "  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));",
    "  return true;",
    "})()",
  ].join("\n");

  try {
    const result = await page.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return asRecord(result.result)?.value === true;
  } catch {
    return false;
  }
}

/** Put the page's own background back exactly as it was. */
async function clearBackdrop(page: CapturablePage): Promise<void> {
  const expression = [
    "(() => {",
    "  const root = document.documentElement;",
    "  const saved = root.dataset.mirinBackdrop;",
    "  delete root.dataset.mirinBackdrop;",
    '  const [value, priority] = saved ? JSON.parse(saved) : ["", ""];',
    '  if (value) root.style.setProperty("background-color", value, priority);',
    '  else root.style.removeProperty("background-color");',
    "  return true;",
    "})()",
  ].join("\n");

  try {
    await page.send("Runtime.evaluate", { expression, returnByValue: true });
  } catch {
    // Nothing useful to do; the page is closing or the socket is gone.
  }
}
