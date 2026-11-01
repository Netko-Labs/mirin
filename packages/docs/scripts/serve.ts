#!/usr/bin/env bun
/**
 * `bun run start`: serve the built site (`.output/public`) the way Vercel does
 * (vercel.json): files as they are, `/page` from `page.html` or
 * `page/index.html`, and every other path outside `/api/` from the SPA shell.
 * Bun's own server, in place of `serve`, whose minimatch has an advisory
 * with no fixed release on its line.
 *
 *   bun scripts/serve.ts [port]     (default: $PORT, else 3000)
 */

import { resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "../.output/public");
const shell = Bun.file(`${root}/_shell.html`);
if (!(await shell.exists())) {
  console.error(`no build at ${root}: run \`bun run build\` first`);
  process.exit(1);
}

/** The file for `pathname` inside the build, or null; never a path outside it. */
async function find(pathname: string): Promise<Bun.BunFile | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  for (const candidate of [decoded, `${decoded}.html`, `${decoded}/index.html`]) {
    const path = resolve(root, `.${candidate}`);
    if (path !== root && !path.startsWith(root + sep)) return null;
    const file = Bun.file(path);
    if ((await file.exists()) && !(await file.stat()).isDirectory()) return file;
  }
  return null;
}

const server = Bun.serve({
  port: Number(Bun.argv[2] ?? process.env.PORT ?? 3000),
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const file = await find(pathname);
    if (file) return new Response(file);
    if (pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
    return new Response(shell);
  },
});

console.log(`serving ${root} at ${server.url}`);
