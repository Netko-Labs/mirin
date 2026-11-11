import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverEnv } from "../src/launch.ts";

/** JavaScriptCore's option, spelled as Bun reads it from the environment. */
const MARKERS = "BUN_JSC_numberOfGCMarkers";

test("a driver starts with React's production build, one collector thread and no collection timer", () => {
  const env = driverEnv({ HOME: "/home/u", EMPTY: undefined });
  expect(env).toEqual({
    HOME: "/home/u",
    NODE_ENV: "production",
    [MARKERS]: "1",
    BUN_GC_TIMER_DISABLE: "1",
  });
});

test("what the environment already says is kept", () => {
  const env = driverEnv({ NODE_ENV: "test", [MARKERS]: "4" });
  expect(env.NODE_ENV).toBe("test");
  expect(env[MARKERS]).toBe("4");
  expect(driverEnv({}, { development: true }).NODE_ENV).toBe("development");
  expect(driverEnv({ NODE_ENV: "production" }, { development: true }).NODE_ENV).toBe("production");
});

const cli = join(import.meta.dir, "..", "src", "cli.ts");

async function run(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code, pid: child.pid };
}

test("mirin-metal run becomes the app, with its arguments and that environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mirin-metal-run-"));
  const entry = join(dir, "app.ts");
  writeFileSync(
    entry,
    `console.log(JSON.stringify({ pid: process.pid, args: Bun.argv.slice(2), node: process.env.NODE_ENV, markers: process.env.BUN_JSC_numberOfGCMarkers }));
process.exit(7);
`,
  );
  // Its own cache: a start from the sources builds a bundle there for the next one.
  const base = { PATH: process.env.PATH ?? "", HOME: dir, XDG_CACHE_HOME: join(dir, "cache") };
  const app = await run(["run", entry, "one", "--two"], base);
  expect(app.code).toBe(7);
  const said = JSON.parse(app.out) as {
    pid: number;
    args: string[];
    node: string;
    markers: string;
  };
  expect(said.args).toEqual(["one", "--two"]);
  expect(said.node).toBe("production");
  expect(said.markers).toBe("1");
  // The launcher is gone: the app has its process.
  if (process.platform !== "win32") expect(said.pid).toBe(app.pid);

  const dev = await run(["run", "--dev", entry], base);
  expect((JSON.parse(dev.out) as { node: string }).node).toBe("development");
});

test("mirin-metal run starts an app from its bundle once one is built, from its sources after an edit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mirin-metal-run-"));
  const entry = join(dir, "app.ts");
  writeFileSync(entry, "console.log(Bun.main);\n");
  const base = { PATH: process.env.PATH ?? "", HOME: dir, XDG_CACHE_HOME: join(dir, "cache") };
  expect((await run(["run", entry], base)).out.trim()).toBe(entry);
  // The bundle is built in the background, a moment after the start.
  const deadline = Date.now() + 15_000;
  let main = entry;
  while (main === entry && Date.now() < deadline) {
    await Bun.sleep(250);
    main = (await run(["run", entry], { ...base, MIRIN_METAL_BUNDLE: "1" })).out.trim();
  }
  expect(main).toStartWith(join(dir, "cache", "mirin-metal", "bundles"));
  expect((await run(["run", "--dev", entry], base)).out.trim()).toBe(entry);
  expect((await run(["run", entry], { ...base, MIRIN_METAL_BUNDLE: "0" })).out.trim()).toBe(entry);
  writeFileSync(entry, "console.log('edited', Bun.main);\n");
  expect((await run(["run", entry], base)).out.trim()).toBe(`edited ${entry}`);
}, 20_000);

test("mirin-metal without something to run says how", async () => {
  const none = await run([], {});
  expect(none.code).toBe(2);
  expect(none.err).toContain("usage: mirin-metal run");
  expect((await run(["run"], {})).code).toBe(2);
});
