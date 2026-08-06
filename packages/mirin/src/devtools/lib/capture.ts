/**
 * Screenshot capture, including the case that makes a naive capture useless: a
 * transparent window.
 *
 * mirin's transparent/OSR windows have no page background — the native material
 * behind the webview is what a person sees. CDP knows nothing about that material,
 * so `Page.captureScreenshot` returns an image whose background is alpha 0. The
 * bytes are faithful, but every viewer composites them onto white, so a light-on-
 * dark app reads as a blank page. That is precisely the artifact `mirin check`
 * exists to produce, so it cannot be left blank.
 *
 * The fix is to paint an opaque backdrop under the page for the duration of the
 * capture and say so in the response. The image is then readable but no longer
 * pixel-truth, and `composited` is how a caller tells the difference.
 */

import type { CdpPage } from "./cdp.ts";
import { asBoolean, asRecord, asString } from "./parse.ts";

/** The slice of a CDP page this module needs — everything here is one command. */
export type CapturablePage = Pick<CdpPage, "send">;

/** Backdrops for a transparent page, chosen to match the page's own scheme. */
const DARK_BACKDROP = "#1c1c1e";
const LIGHT_BACKDROP = "#ffffff";

/** `#rgb` or `#rrggbb`. */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * What the page paints where it has no background of its own. A page is treated as
 * transparent only when *both* the root element and the body are clear — a body
 * with a real background already covers the window.
 *
 * `color` is the body's text colour, which is what decides the backdrop: the goal
 * is a legible image, so the backdrop has to contrast with the text. The OS colour
 * scheme is only a fallback — a glass window renders light text whatever the system
 * is set to, and picking white there reproduces the blank page this module exists
 * to prevent.
 */
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

/**
 * Perceived brightness of an `rgb(…)`/`rgba(…)` string on 0–1, or undefined when it
 * cannot be read. Rec. 601 luma is more than enough to answer "is this text light".
 */
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

/**
 * Read a caller-supplied `backdrop` parameter.
 *
 * An unparseable value falls back to automatic rather than failing the request:
 * a near-miss should still return a usable screenshot.
 */
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

  // Automatic: only worth doing for a page that is actually transparent, and the
  // page is the only thing that knows. A probe failure is not a capture failure.
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

/**
 * One capture at a time per page.
 *
 * `setBackdrop` stashes the page's own background before overwriting it. Two
 * captures of the same page interleaving would make the second stash the *first
 * one's backdrop* as the original, and the page would be left permanently
 * composited after both restores ran — a diagnostic silently changing how the app
 * renders for the rest of the session. The inspector serves requests concurrently,
 * so nothing else prevents that.
 */
const captures = new WeakMap<CapturablePage, Promise<unknown>>();

function serialize<T>(page: CapturablePage, run: () => Promise<T>): Promise<T> {
  const previous = captures.get(page) ?? Promise.resolve();
  // Run whether the previous capture resolved or threw: one failure must not
  // wedge every later capture of that page.
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
    // Always restore, including when the capture threw: the override is page
    // state, and leaving it set would silently change how the app renders.
    if (applied) await clearBackdrop(page);
  }
}

/**
 * Paint the backdrop, then wait for it to actually render.
 *
 * This sets a style on the page rather than using
 * `Emulation.setDefaultBackgroundColorOverride`, which CEF accepts and then
 * ignores on the windowless (OSR) path — measured: captures with the override set
 * to `none`, red, and black come back byte-identical. Styling the document is the
 * only lever that reaches the compositor, so the page is briefly modified and then
 * put back.
 *
 * Returns whether the backdrop actually went on.
 */
async function setBackdrop(page: CapturablePage, color: string): Promise<boolean> {
  // `color` is already constrained to a hex literal by `parseBackdrop`, and is
  // embedded with JSON.stringify regardless — a value from a request never
  // becomes script.
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
