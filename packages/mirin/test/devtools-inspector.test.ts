import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isLoopbackHost, presentedToken, secretEquals } from "../src/devtools/lib/http.ts";
import { type InspectorHandle, startInspector } from "../src/devtools/lib/inspector.ts";
import { resolveDevtoolsOptions, setDevtoolsOptions } from "../src/devtools/options.ts";
import { record, sink } from "../src/devtools/sink.ts";

describe("inspector host guard", () => {
  test("accepts loopback names, with or without a port", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:51234")).toBe(true);
    expect(isLoopbackHost("localhost:51234")).toBe(true);
    expect(isLoopbackHost("[::1]:51234")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
  });

  // A page on evil.example whose DNS answers 127.0.0.1 still sends its own Host.
  test("rejects rebound hostnames and a missing header", () => {
    expect(isLoopbackHost("evil.example")).toBe(false);
    expect(isLoopbackHost("evil.example:51234")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });
});

describe("inspector token handling", () => {
  test("compares by value, and rejects a length mismatch", () => {
    expect(secretEquals("abc", "abc")).toBe(true);
    expect(secretEquals("abc", "abd")).toBe(false);
    expect(secretEquals("abc", "abcd")).toBe(false);
    expect(secretEquals("", "")).toBe(true);
  });

  test("reads a bearer header or the query param", () => {
    const url = new URL("http://127.0.0.1/logs?token=from-query");
    expect(presentedToken(new Request("http://127.0.0.1/logs"), url)).toBe("from-query");

    const withHeader = new Request("http://127.0.0.1/logs", {
      headers: { authorization: "Bearer from-header" },
    });
    expect(presentedToken(withHeader, url)).toBe("from-header");
  });

  test("ignores a non-bearer authorization scheme", () => {
    const url = new URL("http://127.0.0.1/logs");
    const req = new Request("http://127.0.0.1/logs", { headers: { authorization: "Basic zzz" } });
    expect(presentedToken(req, url)).toBeUndefined();
  });
});

describe("inspector server", () => {
  let inspector: InspectorHandle;
  let base: string;

  beforeAll(() => {
    setDevtoolsOptions(resolveDevtoolsOptions(undefined, true));
    const started = startInspector({ exposed: () => ({ counter: 41 + 1 }) });
    if (started === undefined) throw new Error("inspector did not start");
    inspector = started;
    base = `http://127.0.0.1:${inspector.port}`;
  });

  afterAll(async () => {
    await inspector.stop();
  });

  const get = (path: string, init?: RequestInit) =>
    fetch(`${base}${path}${path.includes("?") ? "&" : "?"}token=${inspector.token}`, init);

  test("binds a loopback port and mints a token", () => {
    expect(inspector.port).toBeGreaterThan(0);
    expect(inspector.token.length).toBeGreaterThan(10);
  });

  test("refuses a request with no token", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(401);
    // The error must say where to find the token — an agent has no other clue.
    expect((await res.json()).error).toContain("inspector.json");
  });

  test("refuses a wrong token", async () => {
    const res = await fetch(`${base}/health?token=nope`);
    expect(res.status).toBe(401);
  });

  test("accepts a bearer header as well as the query param", async () => {
    const res = await fetch(`${base}/health`, {
      headers: { authorization: `Bearer ${inspector.token}` },
    });
    expect(res.status).toBe(200);
  });

  test("the index lists the routes, so a tool can discover them", async () => {
    const body = await (await get("/")).json();
    expect(body.service).toBe("mirin-inspector");
    expect(body.routes).toContain("GET /logs");
    expect(body.routes).toContain("GET /state");
    expect(body.routes).toContain("GET /logs/stream");
  });

  test("health reports liveness and the stream cursor", async () => {
    const body = await (await get("/health")).json();
    expect(body.ok).toBe(true);
    expect(body.pid).toBe(process.pid);
    expect(typeof body.lastSeq).toBe("number");
  });

  test("state includes exposed app slices and the platform", async () => {
    const body = await (await get("/state")).json();
    expect(body.exposed).toEqual({ counter: 42 });
    expect(body.platform.os).toBe(process.platform);
    // Detached from the native core, so there are no windows — not an error.
    expect(body.windows).toEqual([]);
    expect(body.rpc.routes).toEqual([]);
  });

  test("logs return recorded events and a usable cursor", async () => {
    record({ src: "app", level: "info", type: "test.marker", msg: "hello inspector" });
    const body = await (await get("/logs?type=test.marker")).json();
    expect(body.events.at(-1).msg).toBe("hello inspector");
    expect(body.lastSeq).toBe(sink.lastSeq);
  });

  test("logs honor the since cursor", async () => {
    const cursor = sink.lastSeq;
    record({ src: "app", level: "info", type: "test.after", msg: "after cursor" });
    const body = await (await get(`/logs?since=${cursor}`)).json();
    expect(body.events.map((e: { msg: string }) => e.msg)).toEqual(["after cursor"]);
  });

  test("logs filter by level", async () => {
    record({ src: "app", level: "error", type: "test.bad", msg: "broke" });
    const body = await (await get("/logs?level=error&type=test.")).json();
    expect(body.events.every((e: { level: string }) => e.level === "error")).toBe(true);
  });

  test("an unknown route explains itself", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).routes).toContain("GET /health");
  });

  /** Accumulate stream text until `needle` shows up, then stop reading. */
  async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    needle: string,
  ): Promise<string> {
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes(needle)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text;
  }

  test("the stream replays history then pushes live events", async () => {
    record({ src: "app", level: "info", type: "test.stream", msg: "replayed" });
    const res = await get("/logs/stream?type=test.stream");
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error("no stream body");

    expect(await readUntil(reader, "replayed")).toContain("replayed");

    record({ src: "app", level: "info", type: "test.stream", msg: "live" });
    expect(await readUntil(reader, "live")).toContain("live");

    // Cancelling the reader closes the stream through its `cancel` hook, which is
    // how a client is expected to disconnect.
    await reader.cancel();
  });

  test("the stream applies filters to live events too", async () => {
    const res = await get("/logs/stream?type=test.only&replay=0");
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error("no stream body");

    record({ src: "app", level: "info", type: "test.other", msg: "excluded" });
    record({ src: "app", level: "info", type: "test.only", msg: "included" });

    const text = await readUntil(reader, "included");
    expect(text).toContain("included");
    expect(text).not.toContain("excluded");

    await reader.cancel();
  });
});

describe("inspector when disabled", () => {
  test("does not bind in a packaged build", () => {
    setDevtoolsOptions(resolveDevtoolsOptions(undefined, false));
    expect(startInspector({ exposed: () => ({}) })).toBeUndefined();
    setDevtoolsOptions(resolveDevtoolsOptions(undefined, true));
  });
});
