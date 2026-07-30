/**
 * Inspector routes backed by the DevTools protocol (docs/agent-devtools.md).
 *
 *   GET  /screenshot   PNG of a window, written into the session dir
 *   GET  /snapshot     accessibility tree (default) or DOM HTML
 *   POST /eval         evaluate an expression in a window
 *   POST /act          click / type / key / scroll / wait
 *
 * Screenshots are returned as a *path* rather than a base64 blob by default: the
 * readers these serve work with files, and a path costs a few dozen bytes where an
 * inlined PNG costs megabytes. `?inline=1` returns the bytes for anything that
 * would rather stream them.
 */

import { join } from "node:path";
import {
  ActionError,
  click,
  KEY_NAMES,
  key as pressKey,
  scroll,
  type as typeText,
  waitFor,
} from "./actions.ts";
import { formatAxTree } from "./ax.ts";
import type { CdpBridge } from "./cdp.ts";
import { json, jsonError } from "./http.ts";
import type { InspectorRoutes } from "./inspector.ts";
import { asNumber, asRecord, asString, parseJson } from "./parse.ts";

/** Default deadline for `wait`, and the ceiling any caller can ask for. */
const DEFAULT_WAIT_MS = 5_000;
const MAX_WAIT_MS = 30_000;

export interface CdpRouteDeps {
  bridge: CdpBridge;
  /** Where captured screenshots are written. Undefined when there is no session. */
  screenshotDir?: string;
}

/** `?window=3`, or undefined to let the bridge pick the only attached page. */
function windowParam(url: URL): number | undefined {
  const raw = url.searchParams.get("window");
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  return asRecord(parseJson(await req.text())) ?? {};
}

async function screenshotRoute(deps: CdpRouteDeps, url: URL): Promise<Response> {
  const page = await deps.bridge.page(windowParam(url));
  const format = url.searchParams.get("format") === "jpeg" ? "jpeg" : "png";
  const quality = Number(url.searchParams.get("quality") ?? "");
  const result = await page.send("Page.captureScreenshot", {
    format,
    ...(format === "jpeg" && Number.isSafeInteger(quality) ? { quality } : {}),
    // Beyond the viewport captures the scrolled-out remainder of the page.
    ...(url.searchParams.get("full") === "1" ? { captureBeyondViewport: true } : {}),
  });

  const base64 = asString(result.data);
  if (base64 === undefined) return jsonError("capture returned no image data", 502);
  const bytes = Buffer.from(base64, "base64");

  if (url.searchParams.get("inline") === "1" || deps.screenshotDir === undefined) {
    return new Response(bytes, {
      headers: { "content-type": `image/${format}`, "cache-control": "no-store" },
    });
  }

  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-w${page.window ?? 0}.${format}`;
  const path = join(deps.screenshotDir, name);
  await Bun.write(path, bytes);
  return json({ path, bytes: bytes.byteLength, format, window: page.window ?? null });
}

async function snapshotRoute(deps: CdpRouteDeps, url: URL): Promise<Response> {
  const page = await deps.bridge.page(windowParam(url));
  const format = url.searchParams.get("format") ?? "ax";

  if (format === "dom") {
    const result = await page.send("Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true,
    });
    return json({
      format: "dom",
      window: page.window ?? null,
      url: page.target.url,
      html: asString(asRecord(result.result)?.value) ?? "",
    });
  }
  if (format !== "ax") {
    return jsonError(`unknown snapshot format "${format}" — use "ax" or "dom"`, 400);
  }

  // Accessibility must be enabled before the tree can be read; it is not one of
  // the domains the bridge turns on for every page, because only this route uses it.
  await page.send("Accessibility.enable").catch(() => ({}));
  const tree = await page.send("Accessibility.getFullAXTree");
  return json({
    format: "ax",
    window: page.window ?? null,
    url: page.target.url,
    title: page.target.title,
    snapshot: formatAxTree(tree),
  });
}

async function evalRoute(deps: CdpRouteDeps, req: Request, url: URL): Promise<Response> {
  const body = await readJsonBody(req);
  const expression = asString(body.expression);
  if (expression === undefined) {
    return jsonError('body must be JSON with an "expression" string', 400);
  }
  const page = await deps.bridge.page(windowParam(url) ?? asNumber(body.window));
  const result = await page.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: body.await !== false,
  });

  const details = asRecord(result.exceptionDetails);
  if (details !== undefined) {
    const thrown = asRecord(details.exception);
    return json(
      {
        ok: false,
        error: asString(thrown?.description) ?? asString(details.text) ?? "evaluation threw",
        window: page.window ?? null,
      },
      200,
    );
  }
  return json({
    ok: true,
    window: page.window ?? null,
    value: asRecord(result.result)?.value ?? null,
  });
}

/** Documented shape of `POST /act`, echoed back in the 400 for a bad request. */
const ACT_USAGE = {
  action: "click | type | key | scroll | wait",
  selector: 'CSS, or "text=Save" to match by label (required except for key/scroll)',
  text: "for action=type",
  key: `for action=key — one of: ${KEY_NAMES.join(", ")}`,
  deltaY: "for action=scroll (deltaX optional)",
  timeoutMs: `for action=wait (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS})`,
  window: "target window id; omitted picks the only attached webview",
};

async function actRoute(deps: CdpRouteDeps, req: Request, url: URL): Promise<Response> {
  const body = await readJsonBody(req);
  const action = asString(body.action);
  const selector = asString(body.selector);
  const page = await deps.bridge.page(windowParam(url) ?? asNumber(body.window));
  const send = page.send.bind(page);

  const needsSelector = (): string => {
    if (selector === undefined) throw new ActionError(`action "${action}" needs a selector`);
    return selector;
  };

  switch (action) {
    case "click": {
      const at = await click(send, needsSelector(), asNumber(body.clickCount) ?? 1);
      return json({ ok: true, action, selector, at, window: page.window ?? null });
    }
    case "type": {
      const text = asString(body.text);
      if (text === undefined) return jsonError('action "type" needs a "text" string', 400);
      await typeText(send, text, selector);
      return json({ ok: true, action, selector: selector ?? null, window: page.window ?? null });
    }
    case "key": {
      const name = asString(body.key);
      if (name === undefined) return jsonError('action "key" needs a "key" name', 400);
      await pressKey(send, name);
      return json({ ok: true, action, key: name, window: page.window ?? null });
    }
    case "scroll": {
      await scroll(send, asNumber(body.deltaY) ?? 0, asNumber(body.deltaX) ?? 0, selector);
      return json({ ok: true, action, window: page.window ?? null });
    }
    case "wait": {
      const timeoutMs = Math.min(asNumber(body.timeoutMs) ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
      await waitFor(send, needsSelector(), timeoutMs);
      return json({ ok: true, action, selector, window: page.window ?? null });
    }
    default:
      return jsonError(`unknown action "${action ?? ""}"`, 400, { usage: ACT_USAGE });
  }
}

/** Wrap a handler so a CDP/action failure reads as a 4xx/5xx JSON body. */
function guarded(
  handler: (req: Request, url: URL) => Promise<Response>,
): (req: Request, url: URL) => Promise<Response> {
  return async (req, url) => {
    try {
      return await handler(req, url);
    } catch (err) {
      // An unmatched selector is the caller's problem; anything else is ours.
      const status = err instanceof ActionError ? 400 : 502;
      return jsonError(err instanceof Error ? err.message : String(err), status);
    }
  };
}

/** The CDP route table, merged into the inspector when the bridge is enabled. */
export function cdpRoutes(deps: CdpRouteDeps): InspectorRoutes {
  return {
    "GET /screenshot": guarded((_req, url) => screenshotRoute(deps, url)),
    "GET /snapshot": guarded((_req, url) => snapshotRoute(deps, url)),
    "POST /eval": guarded((req, url) => evalRoute(deps, req, url)),
    "POST /act": guarded((req, url) => actRoute(deps, req, url)),
    "GET /cdp/targets": guarded(async () => {
      await deps.bridge.refresh(true);
      return json({ port: deps.bridge.port, windows: deps.bridge.attachedWindows() });
    }),
  };
}
