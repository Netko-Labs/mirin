import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle, unbundleable, withOwnMeta } from "../src/lib/bundle-build.ts";
import { cachedBundle } from "../src/lib/bundle-cache.ts";

/** An app in a directory of its own, and a cache of its own. */
function app(files: Record<string, string>): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "mirin-metal-bundle-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return { dir, env: { XDG_CACHE_HOME: join(dir, ".cache"), HOME: dir } };
}

async function output(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "inherit" });
  const text = await new Response(child.stdout).text();
  await child.exited;
  return text.trim();
}

test("a bundle keeps each module's import.meta, and is used until a file it was built from changes", async () => {
  const { dir, env } = app({
    "main.ts": `import { where } from "./lib/where.ts";\nconsole.log(JSON.stringify([where(), import.meta.dir, import.meta.main, process.env.NODE_ENV]));\n`,
    "lib/where.ts":
      "export const where = () => [import.meta.dir, import.meta.url, import.meta.main];\n",
  });
  const entry = join(dir, "main.ts");
  expect((await cachedBundle(entry, "production", env)).state).toBe("stale");
  const built = await buildBundle(entry, "production", env);
  expect(built.state).toBe("fresh");
  const cached = await cachedBundle(entry, "production", env);
  if (cached.state !== "fresh") throw new Error("no bundle");
  // The bundle prints what the sources print, with React's production build defined in.
  const fromSource = JSON.parse(await output([process.execPath, entry])) as unknown[];
  const fromBundle = JSON.parse(await output([process.execPath, cached.bundle])) as unknown[];
  expect(fromBundle.slice(0, 3)).toEqual(fromSource.slice(0, 3));
  expect(fromBundle).toEqual([
    [join(dir, "lib"), `file://${join(dir, "lib", "where.ts")}`, false],
    dir,
    true,
    "production",
  ]);
  // Another build of React, or a file changed: built again.
  expect((await cachedBundle(entry, "development", env)).state).toBe("stale");
  utimesSync(join(dir, "lib", "where.ts"), new Date(), new Date(Date.now() + 5000));
  expect((await cachedBundle(entry, "production", env)).state).toBe("stale");
});

test("an app that makes a path to import at run time, or spells import.meta in a string, runs unbundled", async () => {
  const dynamic = app({
    "main.ts": `const name = process.argv[2] ?? "a";\nawait import(\`./pages/\${name}.ts\`);\n`,
    "pages/a.ts": `console.log("a");\n`,
  });
  const entry = join(dynamic.dir, "main.ts");
  expect((await buildBundle(entry, "production", dynamic.env)).state).toBe("unbundled");
  expect(await cachedBundle(entry, "production", dynamic.env)).toMatchObject({
    state: "unbundled",
  });

  expect(unbundleable(`const a = require("./a.ts"); await import("./b.ts");`, "ts")).toBeNull();
  // Comments are not code.
  expect(unbundleable("// import(name)\nconst a = 1;", "ts")).toBeNull();
  expect(unbundleable("const a = require(name);", "ts")).not.toBeNull();
  expect(unbundleable(`const a = require.resolve("./a.ts");`, "ts")).not.toBeNull();
  expect(unbundleable("const a = import.meta.require(name);", "ts")).not.toBeNull();
  expect(unbundleable(`new Worker("./worker.ts");`, "ts")).not.toBeNull();
  expect(
    withOwnMeta("export const at = [__dirname, __filename];", "ts", "/a/b.ts", "/a/c.ts"),
  ).toBe(`export const at = ["/a", "/a/b.ts"];`);
  // A local named so is not the module's own.
  expect(
    withOwnMeta(`const __dirname = "x"; export const at = __dirname;`, "ts", "/a/b.ts", "/a/c.ts"),
  ).toBeNull();
  expect(withOwnMeta("export const at = import.meta.dir;", "ts", "/a/b.ts", "/a/c.ts")).toBe(
    `export const at = "/a";`,
  );
  expect(
    withOwnMeta(`export const at = "import.meta.dir";`, "ts", "/a/b.ts", "/a/c.ts"),
  ).toBeNull();
});
