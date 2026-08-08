import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readEventsFile, readInspectorEndpoint, readSessionInfo } from "mirinjs/devtools/session";
import { InspectorClient, InspectorError } from "../src/shared/inspector.ts";
import { createReporter } from "../src/shared/report.ts";
import { DevSession } from "../src/shared/session.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", ".mirin-test");
const dirs: string[] = [];

function tempProject(): string {
  const dir = join(ROOT, crypto.randomUUID());
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of dirs) await Bun.$`rm -rf ${dir}`.quiet();
});

function captureLog(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines;
}

describe("cli reporter", () => {
  test("human mode prints prose and no JSON", () => {
    const reporter = createReporter(false);
    const lines = captureLog(() => {
      reporter.info("building…");
      reporter.event("compile", { ms: 12 });
      reporter.finish({ ok: true }, () => console.log("done"));
    });
    expect(lines).toEqual(["building…", "done"]);
  });

  test("json mode emits only parseable lines, ending in a result", () => {
    const reporter = createReporter(true);
    const lines = captureLog(() => {
      reporter.info("building…");
      reporter.event("compile", { ms: 12 });
      reporter.finish({ ok: true }, () => console.log("should not print"));
    });
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed[0]).toMatchObject({ phase: "compile", ms: 12 });
    expect(parsed[1]).toMatchObject({ phase: "result", ok: true });
    expect(lines.join("\n")).not.toContain("should not print");
  });

  test("points a spawned child's stdout away from the report in json mode", () => {
    expect(createReporter(false).childStdio).toEqual(["ignore", "inherit", "inherit"]);
    // fd 2: child prose would otherwise interleave with the JSON on stdout.
    expect(createReporter(true).childStdio).toEqual(["ignore", 2, "inherit"]);
  });
});

// A subprocess writes to the real fd, which patching console.log cannot intercept;
// run the reporter in a child bun so the actual fds are observed.
describe("cli reporter subprocess output", () => {
  async function runReporterScript(json: boolean): Promise<{ stdout: string; stderr: string }> {
    const source = `
      import { $ } from "bun";
      import { createReporter } from "./src/shared/report.ts";
      const reporter = createReporter(${json});
      await reporter.build($\`echo CHILD_CHATTER\`);
      reporter.finish({ ok: true }, () => console.log("human report"));
    `;
    const proc = Bun.spawn(["bun", "-e", source], {
      cwd: join(import.meta.dir, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { stdout, stderr };
  }

  test("json mode keeps build output off stdout but still shows it", async () => {
    const { stdout, stderr } = await runReporterScript(true);
    expect(stdout).not.toContain("CHILD_CHATTER");
    const lines = stdout.split("\n").filter((line) => line.length > 0);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ phase: "result", ok: true }),
    ]);
    // Captured, not discarded: a failed build must stay readable.
    expect(stderr).toContain("CHILD_CHATTER");
  });

  test("human mode streams build output as before", async () => {
    const { stdout } = await runReporterScript(false);
    expect(stdout).toContain("CHILD_CHATTER");
    expect(stdout).toContain("human report");
  });
});

describe("dev session bookkeeping", () => {
  test("creates the session, records phases, and writes a post-mortem", async () => {
    const projectDir = tempProject();
    const session = DevSession.create({
      projectDir,
      appName: "Anko",
      appId: "dev.netko.anko",
      version: "1.2.3",
    });
    if (session === undefined) throw new Error("session was not created");

    const compile = session.phase("compile");
    compile.ok("built");
    session.phase("vite").fail("port taken");
    session.setDevUrl("http://127.0.0.1:5173");
    session.setPid(4242);

    const info = readSessionInfo(session.paths);
    expect(info?.app).toEqual({ name: "Anko", id: "dev.netko.anko", version: "1.2.3" });
    expect(info?.devUrl).toBe("http://127.0.0.1:5173");
    expect(info?.pid).toBe(4242);
    expect(info?.phases.map((phase) => `${phase.name}:${phase.status}`)).toEqual([
      "compile:start",
      "compile:ok",
      "vite:start",
      "vite:fail",
    ]);
    expect(info?.phases.at(-1)?.detail).toBe("port taken");

    session.finish(1, "SIGTERM");
    const exit = JSON.parse(await Bun.file(session.paths.exit).text());
    expect(exit).toMatchObject({ version: 1, code: 1, signal: "SIGTERM", errorCount: 0 });
    expect(exit.tail).toEqual([]);
    expect(typeof exit.exitedAt).toBe("number");
  });

  test("the post-mortem counts errors and carries the tail of the stream", async () => {
    const projectDir = tempProject();
    const session = DevSession.create({ projectDir, appName: "Anko", appId: "dev.netko.anko" });
    if (session === undefined) throw new Error("session was not created");

    // Stand in for the app's Worker, which owns events.jsonl.
    const event = (seq: number, level: string) =>
      JSON.stringify({ seq, ts: seq, src: "renderer", level, type: "console", msg: `m${seq}` });
    await Bun.write(
      session.paths.events,
      `${[event(1, "info"), event(2, "error"), event(3, "error")].join("\n")}\n`,
    );

    session.finish(0);
    const exit = JSON.parse(await Bun.file(session.paths.exit).text());
    expect(exit.errorCount).toBe(2);
    expect(exit.tail.map((entry: { seq: number }) => entry.seq)).toEqual([1, 2, 3]);
    expect(exit.signal).toBeUndefined();
  });

  test("points the app at the session through the environment", () => {
    const session = DevSession.create({
      projectDir: tempProject(),
      appName: "A",
      appId: "a.b",
    });
    expect(session?.env().MIRIN_DEV_SESSION).toBe(session?.paths.dir);
  });

  test("creates the screenshots dir up front", () => {
    const session = DevSession.create({ projectDir: tempProject(), appName: "A", appId: "a.b" });
    if (session === undefined) throw new Error("session was not created");
    expect(readdirSync(session.paths.screenshots)).toEqual([]);
  });

  test("an unwritable project dir yields no session rather than throwing", () => {
    // A path whose parent is a file cannot be created.
    expect(
      DevSession.create({ projectDir: "/dev/null/nope", appName: "A", appId: "a.b" }),
    ).toBeUndefined();
  });

  test("waitForInspector gives up rather than hanging when nothing publishes", async () => {
    const session = DevSession.create({ projectDir: tempProject(), appName: "A", appId: "a.b" });
    if (session === undefined) throw new Error("session was not created");
    const startedAt = Date.now();
    expect(await session.waitForInspector(300)).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test("waitForInspector returns the endpoint once it appears", async () => {
    const session = DevSession.create({ projectDir: tempProject(), appName: "A", appId: "a.b" });
    if (session === undefined) throw new Error("session was not created");
    await Bun.write(
      session.paths.inspector,
      JSON.stringify({ version: 1, port: 51234, token: "t", pid: 1, startedAt: 2 }),
    );
    expect((await session.waitForInspector(2_000))?.port).toBe(51234);
    expect(readInspectorEndpoint(session.paths)?.token).toBe("t");
    expect(readEventsFile(session.paths.events)).toEqual([]);
  });
});

describe("inspector client", () => {
  test("sends the bearer token and parses JSON replies", async () => {
    const seen: (string | null)[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push(req.headers.get("authorization"));
        return new Response(JSON.stringify({ ok: true, path: new URL(req.url).pathname }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    const client = new InspectorClient({
      version: 1,
      port: server.port ?? 0,
      token: "sekrit",
      pid: 1,
      startedAt: 2,
    });
    expect(await client.get("/state")).toEqual({ ok: true, path: "/state" });
    expect(await client.post("/eval", { expression: "1" })).toEqual({ ok: true, path: "/eval" });
    expect(seen).toEqual(["Bearer sekrit", "Bearer sekrit"]);

    await server.stop(true);
  });

  test("surfaces the inspector's error message and status", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(JSON.stringify({ error: "no such route: GET /nope" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const client = new InspectorClient({
      version: 1,
      port: server.port ?? 0,
      token: "t",
      pid: 1,
      startedAt: 2,
    });
    const attempt = client.get("/nope");
    await expect(attempt).rejects.toThrow(InspectorError);
    await expect(client.get("/nope")).rejects.toThrow(/no such route/);

    await server.stop(true);
  });

  test("a non-JSON error body still produces a useful message", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("upstream exploded", { status: 502 });
      },
    });

    const client = new InspectorClient({
      version: 1,
      port: server.port ?? 0,
      token: "t",
      pid: 1,
      startedAt: 2,
    });
    await expect(client.get("/screenshot")).rejects.toThrow(/upstream exploded/);

    await server.stop(true);
  });
});
