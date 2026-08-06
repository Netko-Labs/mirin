#!/usr/bin/env bun
/**
 * mirin CLI — `dev`, `check`, `doctor`, `build`, `release`, `init`, `skill`.
 */

import { resolve } from "node:path";
import { scaffold } from "create-mirinjs";
import { build } from "./build.ts";
import { check } from "./check.ts";
import { dev } from "./dev.ts";
import { doctor } from "./doctor.ts";
import { parseLinuxFormats } from "./package/linux/index.ts";
import { release } from "./release.ts";
import { skill } from "./skill.ts";

/** Minimal flag parser: `--k=v`, `--k v`, and boolean `--k`; the rest are positionals. */
function parseArgs(argv: string[]): {
  positionals: string[];
  opts: Record<string, string | boolean>;
} {
  const opts: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          opts[key] = next;
          i++;
        } else {
          opts[key] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, opts };
}

const [command, ...rest] = Bun.argv.slice(2);
const { positionals, opts } = parseArgs(rest);
const arg = positionals[0];

const USAGE = `mirin — build desktop apps with Bun + Chromium

Usage:
  mirin dev          run the app against the Vite dev server (HMR + typed RPC)
  mirin check        boot once, capture a screenshot + UI snapshot, report, exit
  mirin doctor       check the project and environment without building
  mirin build        package a standalone app (output: ./build)
  mirin release      build + emit update artifacts (output: ./build/release)
  mirin init [dir]   scaffold a new app
  mirin skill        install the agent skill into this project (.claude/skills/mirin)

Options (build):
  --version <v>              override the app version (else package.json)
  --linux                    also emit Linux packages (AppImage + .deb + .rpm)
  --linux-target <a,b,…>     restrict Linux packaging to these formats
                             (appimage,deb,rpm) — implies --linux

Options (check):
  --timeout <ms>             how long to wait for a window (default 45000)
  --settle <ms>              quiet time before capturing (default 1000)
  --scenario <file>          drive the app with a scenario before capturing;
                             the file default-exports defineCheck(async app => …)

Options (check, doctor, dev, build):
  --json                     machine-readable output on stdout
`;

/** `--flag <n>` as a positive integer, or undefined when absent/unusable. */
function intOpt(key: string): number | undefined {
  const raw = opts[key];
  if (typeof raw !== "string") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

const asJson = opts.json === true;

switch (command) {
  case "dev": {
    process.exit(await dev(process.cwd(), asJson ? { json: true } : undefined));
    break;
  }
  case "check": {
    process.exit(
      await check(process.cwd(), {
        json: asJson,
        ...(intOpt("timeout") !== undefined ? { timeoutMs: intOpt("timeout") } : {}),
        ...(intOpt("settle") !== undefined ? { settleMs: intOpt("settle") } : {}),
        ...(typeof opts.scenario === "string" ? { scenario: opts.scenario } : {}),
      }),
    );
    break;
  }
  case "doctor": {
    process.exit(await doctor(process.cwd(), { json: asJson }));
    break;
  }
  case "skill": {
    process.exit(await skill(process.cwd(), { json: asJson }));
    break;
  }
  case "build": {
    const version = typeof opts.version === "string" ? opts.version : undefined;
    const target = typeof opts["linux-target"] === "string" ? opts["linux-target"] : undefined;
    const linuxFormats = target ? parseLinuxFormats(target) : undefined;
    const packageLinux = opts.linux === true || linuxFormats != null;
    const result = await build(process.cwd(), { version, packageLinux, linuxFormats });
    if (asJson) {
      // The paths a caller actually needs; the rest of BuildResult is internal
      // plumbing for `mirin release`.
      console.log(
        JSON.stringify({
          phase: "result",
          app: result.app,
          appName: result.appName,
          bundleId: result.bundleId,
          version: result.version,
          channel: result.channel,
        }),
      );
    }
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
      console.log("  .claude/skills/mirin/ — agent skill for verifying changes");
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
