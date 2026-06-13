/**
 * Minimal self-host for update artifacts. Serves ./build/release on :4000 so a
 * built app whose `release.baseUrl` is `http://localhost:4000` can update from
 * it. Any static host (S3, R2, nginx, GitHub Releases) works the same way — the
 * artifact names are flat, so just drop the contents of build/release/ there.
 *
 *   bun serve.ts
 */

import { basename, join } from "node:path";

const dir = join(import.meta.dir, "build", "release");
const port = 4000;

Bun.serve({
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname.replace(/^\/+/, "");
    if (!path) return new Response("mirin updater self-host\n");
    const file = Bun.file(join(dir, basename(path))); // basename: no path traversal
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});

console.log(`[serve] ${dir}\n[serve] http://localhost:${port}`);
