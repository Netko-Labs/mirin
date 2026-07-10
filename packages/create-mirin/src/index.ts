#!/usr/bin/env bun
/**
 * `bun create mirinjs [dir]` — scaffold a new mirin app.
 */

import { resolve } from "node:path";
import { scaffold } from "./scaffold.ts";

const target = Bun.argv[2] ?? "my-mirin-app";
const targetDir = resolve(process.cwd(), target);

try {
  const name = scaffold(targetDir);
  console.log(`\n✓ Created ${name} in ${target}\n`);
  console.log("Next steps:");
  console.log(`  cd ${target}`);
  console.log("  bun install");
  console.log("  bun run dev     # launches a native window with HMR + typed RPC");
  console.log("  bun run build   # packages a standalone app\n");
  console.log("Requires Bun on macOS arm64, Windows x64, or Linux x64.");
} catch (err) {
  console.error(`create-mirinjs: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
