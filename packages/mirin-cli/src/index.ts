#!/usr/bin/env bun
/**
 * mirin CLI — `dev`, `build`, `init`.
 */

import { resolve } from "node:path";
import { dev } from "./dev.ts";
import { build } from "./build.ts";
import { release } from "./release.ts";
import { scaffold } from "create-mirinjs";

const [command, arg] = Bun.argv.slice(2);

const USAGE = `mirin — build desktop apps with Bun + Chromium

Usage:
  mirin dev          run the app against the Vite dev server (HMR + typed RPC)
  mirin build        package a standalone, signed .app (output: ./build)
  mirin release      build + emit update artifacts (output: ./build/release)
  mirin init [dir]   scaffold a new app
`;

switch (command) {
  case "dev": {
    process.exit(await dev());
    break;
  }
  case "build": {
    await build();
    process.exit(0);
    break;
  }
  case "release": {
    process.exit(await release());
    break;
  }
  case "init": {
    const targetDir = resolve(process.cwd(), arg ?? "my-mirin-app");
    try {
      const name = scaffold(targetDir);
      console.log(`\n✓ Created ${name} in ${arg ?? "my-mirin-app"}`);
      console.log("  bun install && bun run dev");
      process.exit(0);
    } catch (err) {
      console.error(`mirin init: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    break;
  }
  default:
    console.log(USAGE);
    process.exit(command ? 1 : 0);
}
