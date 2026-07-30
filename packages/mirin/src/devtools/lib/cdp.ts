/**
 * A DevTools-protocol client for the app's own webviews (docs/agent-devtools.md).
 *
 * This is what lets a tool outside the process *see* the app rather than only read
 * about it: screenshots, accessibility snapshots, page evaluation, and synthetic
 * input all ride the protocol Chromium already speaks. CEF exposes it on a
 * loopback port (`remote_debugging_port`), so the whole client lives here in
 * TypeScript and the native core needs nothing beyond that one setting.
 *
 * The bridge keeps one WebSocket per page target and maps each target to the mirin
 * window id that owns it, by asking the page for the `webviewId` the preload
 * bootstrap installed. That mapping is the only reliable one available: in dev
 * every window loads the same Vite URL, so URLs cannot distinguish them.
 */

import { asArray, asNumber, asRecord, asString, parseJson } from "./parse.ts";

/** Per-command timeout. A wedged renderer must not wedge an inspector request. */
const COMMAND_TIMEOUT_MS = 15_000;

/** How long a target listing stays fresh, so bursts of requests share one probe. */
const TARGET_CACHE_MS = 500;

/** Attach retries while CEF is still starting up, and the gap between them. */
const ATTACH_ATTEMPTS = 30;
const ATTACH_INTERVAL_MS = 500;

/** CDP domains enabled on every page, and why: see the event handler below. */
const DOMAINS = ["Runtime", "Log", "Page", "Network"] as const;

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  /** The mirin window id owning the page that emitted this, when known. */
  window?: number;
}

export type CdpEventListener = (event: CdpEvent) => void;

interface PageTarget {
  id: string;
  wsUrl: string;
  url: string;
  title: string;
}

/** Parse `/json/list`, keeping only page targets that expose a debugger socket. */
function parseTargets(value: unknown): PageTarget[] {
  return (asArray(value) ?? []).flatMap((entry) => {
    const record = asRecord(entry);
    if (record === undefined) return [];
    if (asString(record.type) !== "page") return [];
    const id = asString(record.id);
    const wsUrl = asString(record.webSocketDebuggerUrl);
    if (id === undefined || wsUrl === undefined) return [];
    return [{ id, wsUrl, url: asString(record.url) ?? "", title: asString(record.title) ?? "" }];
  });
}

export class CdpError extends Error {
  constructor(method: string, message: string) {
    super(`${method}: ${message}`);
    this.name = "CdpError";
  }
}

/** One attached page. Owns its socket and correlates replies to commands. */
export class CdpPage {
  readonly target: PageTarget;
  /** The mirin window id, once the page has told us. */
  window?: number;

  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void }
  >();
  #ready: Promise<void>;
  #closed = false;

  constructor(target: PageTarget, onEvent: CdpEventListener) {
    this.target = target;
    const socket = new WebSocket(target.wsUrl);
    this.#socket = socket;

    this.#ready = new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error(`cdp socket failed: ${target.wsUrl}`)),
        { once: true },
      );
    });

    socket.addEventListener("message", (message: MessageEvent) => {
      this.#onMessage(typeof message.data === "string" ? message.data : "", onEvent);
    });
    socket.addEventListener("close", () => {
      this.#closed = true;
      for (const { reject } of this.#pending.values()) {
        reject(new Error("cdp socket closed"));
      }
      this.#pending.clear();
    });
  }

  get closed(): boolean {
    return this.#closed || this.#socket.readyState > WebSocket.OPEN;
  }

  /** Resolve once the socket is usable. */
  ready(): Promise<void> {
    return this.#ready;
  }

  /** Issue a command and await its result. */
  async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    await this.#ready;
    if (this.closed) throw new CdpError(method, "socket closed");

    const id = this.#nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(method, `timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);
      timer.unref?.();

      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Enable the domains whose events feed the stream, and learn our window id. */
  async initialize(): Promise<void> {
    await this.#ready;
    for (const domain of DOMAINS) {
      // A domain that a given CEF build does not support must not abort the rest.
      await this.send(`${domain}.enable`).catch(() => ({}));
    }
    this.window = await this.#readWindowId();
  }

  close(): void {
    this.#closed = true;
    try {
      this.#socket.close();
    } catch {
      // Already gone.
    }
  }

  /** Ask the page for the webview id mirin's preload installed on `window.mirin`. */
  async #readWindowId(): Promise<number | undefined> {
    try {
      const result = await this.send("Runtime.evaluate", {
        expression: "window.mirin && window.mirin.webviewId",
        returnByValue: true,
      });
      return asNumber(asRecord(result.result)?.value);
    } catch {
      // A page that has not run the preload yet (or an internal page) has none.
      return undefined;
    }
  }

  #onMessage(raw: string, onEvent: CdpEventListener): void {
    const frame = asRecord(parseJson(raw));
    if (frame === undefined) return;

    const id = asNumber(frame.id);
    if (id !== undefined) {
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      const error = asRecord(frame.error);
      if (error !== undefined) {
        pending.reject(new CdpError("cdp", asString(error.message) ?? "unknown error"));
      } else {
        pending.resolve(asRecord(frame.result) ?? {});
      }
      return;
    }

    const method = asString(frame.method);
    if (method === undefined) return;
    onEvent({
      method,
      params: asRecord(frame.params) ?? {},
      ...(this.window !== undefined ? { window: this.window } : {}),
    });
  }
}

/** The pool of attached pages for one app process. */
export class CdpBridge {
  readonly port: number;
  #pages = new Map<string, CdpPage>();
  #onEvent: CdpEventListener;
  #lastRefresh = 0;
  #refreshing?: Promise<void>;

  constructor(port: number, onEvent: CdpEventListener) {
    this.port = port;
    this.#onEvent = onEvent;
  }

  /** True once at least one page is attached. */
  get attached(): boolean {
    return this.#pages.size > 0;
  }

  /**
   * Attach to any page not already attached, dropping pages whose socket died.
   * Cheap to call repeatedly: consecutive calls inside `TARGET_CACHE_MS` share one
   * probe, and `force` bypasses that when a window has just been created.
   */
  async refresh(force = false): Promise<void> {
    if (this.#refreshing !== undefined) return this.#refreshing;
    if (!force && Date.now() - this.#lastRefresh < TARGET_CACHE_MS) return;

    const run = this.#refresh().finally(() => {
      this.#lastRefresh = Date.now();
      this.#refreshing = undefined;
    });
    this.#refreshing = run;
    return run;
  }

  /**
   * Keep trying to attach while CEF finishes starting: the Worker is running well
   * before the browser process binds its debugging port.
   */
  async attachWhenReady(): Promise<boolean> {
    for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt++) {
      await this.refresh(true);
      if (this.attached) return true;
      await Bun.sleep(ATTACH_INTERVAL_MS);
    }
    return false;
  }

  /**
   * The page owning `windowId`, or the only attached page when no id is given.
   * Refreshes first, so a window opened a moment ago is found.
   */
  async page(windowId?: number): Promise<CdpPage> {
    await this.refresh();
    const pages = [...this.#pages.values()].filter((page) => !page.closed);
    if (pages.length === 0) {
      throw new CdpError("cdp", `no webview is attached on port ${this.port}`);
    }
    if (windowId === undefined) {
      const first = pages[0];
      if (first === undefined) throw new CdpError("cdp", "no webview is attached");
      return first;
    }
    const match = pages.find((page) => page.window === windowId);
    if (match !== undefined) return match;
    // The id may not have been read yet (a page that reloaded); ask again once.
    for (const page of pages) {
      if (page.window === undefined) {
        await page.initialize().catch(() => undefined);
        if (page.window === windowId) return page;
      }
    }
    throw new CdpError("cdp", `no attached webview for window ${windowId}`);
  }

  /** Window ids of every attached page, for diagnostics. */
  attachedWindows(): number[] {
    return [...this.#pages.values()]
      .filter((page) => !page.closed && page.window !== undefined)
      .map((page) => page.window as number);
  }

  close(): void {
    for (const page of this.#pages.values()) page.close();
    this.#pages.clear();
  }

  async #refresh(): Promise<void> {
    for (const [id, page] of this.#pages) {
      if (page.closed) this.#pages.delete(id);
    }

    let targets: PageTarget[];
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) return;
      targets = parseTargets(parseJson(await res.text()));
    } catch {
      // The port is not up yet, or CEF is shutting down. Nothing to attach.
      return;
    }

    for (const target of targets) {
      if (this.#pages.has(target.id)) continue;
      const page = new CdpPage(target, this.#onEvent);
      this.#pages.set(target.id, page);
      try {
        await page.initialize();
      } catch {
        page.close();
        this.#pages.delete(target.id);
      }
    }
  }
}
