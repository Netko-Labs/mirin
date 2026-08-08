import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createSessionDir,
  devRoot,
  newSessionId,
  parseDevEvent,
  parseInspectorEndpoint,
  parseSessionInfo,
  readCurrentSession,
  readEventsFile,
  readInspectorEndpoint,
  sessionPaths,
  writeCurrentSession,
  writeInspectorEndpoint,
} from "../src/devtools/session.ts";

const sessionInfo = {
  version: 1,
  id: "20260730-041912-8421",
  app: { name: "Anko", id: "dev.netko.anko", version: "1.2.3" },
  projectDir: "/work/anko",
  startedAt: 1_700_000_000_000,
  dev: true,
  devUrl: "http://127.0.0.1:5173",
  pid: 8422,
  phases: [{ name: "compile", status: "start", ts: 1_700_000_000_001 }],
};

describe("session ids", () => {
  test("sort lexically in start order", () => {
    const first = newSessionId(Date.parse("2026-07-30T04:19:12Z"), 10);
    const second = newSessionId(Date.parse("2026-07-30T04:19:13Z"), 10);
    expect(first < second).toBe(true);
  });

  test("are filename-safe and carry the pid to avoid collisions", () => {
    const id = newSessionId(Date.parse("2026-07-30T04:19:12Z"), 8421);
    expect(id).toBe("20260730-041912-8421");
    expect(id).toMatch(/^[0-9-]+$/);
  });
});

describe("session paths", () => {
  test("everything lives under the gitignored .mirin/dev root", () => {
    expect(devRoot("/work/anko")).toBe(join("/work/anko", ".mirin", "dev"));
    const paths = sessionPaths("/work/anko/.mirin/dev/s1");
    expect(paths.events.endsWith(join("s1", "events.jsonl"))).toBe(true);
    expect(paths.inspector.endsWith(join("s1", "inspector.json"))).toBe(true);
    expect(paths.screenshots.endsWith(join("s1", "screenshots"))).toBe(true);
  });
});

describe("session info parsing", () => {
  test("round-trips a complete record", () => {
    expect(parseSessionInfo(sessionInfo)).toEqual(sessionInfo);
  });

  test("requires the identifying fields", () => {
    for (const key of ["id", "projectDir", "startedAt"]) {
      const { [key]: _dropped, ...rest } = sessionInfo as Record<string, unknown>;
      expect(parseSessionInfo(rest)).toBeUndefined();
    }
    expect(parseSessionInfo({ ...sessionInfo, app: { name: "Anko" } })).toBeUndefined();
  });

  test("drops malformed phases without discarding the session", () => {
    const parsed = parseSessionInfo({
      ...sessionInfo,
      phases: [
        { name: "compile", status: "nope", ts: 1 },
        { name: "bundle", status: "ok", ts: 2 },
      ],
    });
    expect(parsed?.phases.map((phase) => phase.name)).toEqual(["bundle"]);
  });

  test("non-objects are rejected", () => {
    expect(parseSessionInfo("session")).toBeUndefined();
    expect(parseSessionInfo(null)).toBeUndefined();
  });
});

describe("inspector endpoint parsing", () => {
  const endpoint = { version: 1, port: 51234, token: "t", pid: 5, startedAt: 9, cdpPort: 51235 };

  test("round-trips", () => {
    expect(parseInspectorEndpoint(endpoint)).toEqual(endpoint);
  });

  test("a partial file is treated as absent, not as port 0", () => {
    expect(parseInspectorEndpoint({ version: 1, port: 51234 })).toBeUndefined();
    expect(parseInspectorEndpoint({ ...endpoint, token: 42 })).toBeUndefined();
  });
});

describe("event parsing", () => {
  const event = { seq: 1, ts: 2, src: "rpc", level: "error", type: "rpc.error", msg: "boom" };

  test("round-trips a record", () => {
    expect(parseDevEvent(event)).toEqual(event);
  });

  test("rejects unknown sources and levels", () => {
    expect(parseDevEvent({ ...event, src: "worker" })).toBeUndefined();
    expect(parseDevEvent({ ...event, level: "trace" })).toBeUndefined();
  });

  test("tolerates a missing message", () => {
    const { msg: _msg, ...rest } = event;
    expect(parseDevEvent(rest)?.msg).toBe("");
  });
});

describe("session files on disk", () => {
  test("write and read back through the real filesystem", async () => {
    const projectDir = join(import.meta.dir, "..", "..", "..", ".mirin-test", crypto.randomUUID());
    const id = newSessionId(Date.now(), process.pid);
    const paths = createSessionDir(projectDir, id);
    writeCurrentSession(projectDir, paths.dir);
    writeInspectorEndpoint(paths, {
      version: 1,
      port: 4321,
      token: "secret",
      pid: 7,
      startedAt: 8,
    });

    expect(readCurrentSession(projectDir)).toBe(paths.dir);
    expect(readInspectorEndpoint(paths)?.port).toBe(4321);
    // The screenshots dir must exist up front so a capture never has to mkdir.
    expect(await Bun.file(join(paths.screenshots, ".keep")).exists()).toBe(false);
    expect(readEventsFile(paths.events)).toEqual([]);

    await Bun.$`rm -rf ${projectDir}`.quiet();
  });

  test("a truncated trailing line is skipped, not treated as corruption", async () => {
    const dir = join(import.meta.dir, "..", "..", "..", ".mirin-test", crypto.randomUUID());
    const path = join(dir, "events.jsonl");
    const good = { seq: 1, ts: 2, src: "main", level: "info", type: "log", msg: "ok" };
    await Bun.write(path, `${JSON.stringify(good)}\n{"seq":2,"ts":3,"src":"ma`);

    expect(readEventsFile(path)).toEqual([good]);

    await Bun.$`rm -rf ${dir}`.quiet();
  });

  test("a missing file reads as empty", () => {
    expect(readEventsFile("/nonexistent/events.jsonl")).toEqual([]);
  });
});
