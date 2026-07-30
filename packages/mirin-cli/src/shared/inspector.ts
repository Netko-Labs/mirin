/**
 * A small client for a running app's inspector (docs/agent-devtools.md).
 *
 * Used by `mirin check`; also the reference for anything else that wants to drive
 * the inspector, since it shows the two things a caller has to get right — the
 * bearer token and the loopback base URL.
 *
 * Responses come back as `unknown`; callers narrow what they actually need rather
 * than trusting a shape across a process boundary.
 */

import type { InspectorEndpoint } from "mirinjs/devtools/session";

/** Per-request deadline. Screenshots of a big window are the slow case. */
const REQUEST_TIMEOUT_MS = 20_000;

export class InspectorError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "InspectorError";
    this.status = status;
  }
}

export class InspectorClient {
  readonly base: string;
  #token: string;

  constructor(endpoint: InspectorEndpoint) {
    this.base = `http://127.0.0.1:${endpoint.port}`;
    this.#token = endpoint.token;
  }

  /** GET a JSON route. `path` starts with `/` and may carry a query string. */
  async get(path: string): Promise<unknown> {
    return this.#request(path, { method: "GET" });
  }

  /** POST a JSON body to a route. */
  async post(path: string, body: unknown): Promise<unknown> {
    return this.#request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async #request(path: string, init: RequestInit): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${this.#token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const message =
        typeof parsed === "object" && parsed !== null && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : text.slice(0, 200);
      throw new InspectorError(res.status, `${path}: ${message}`);
    }
    return parsed;
  }
}
