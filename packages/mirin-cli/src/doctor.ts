/**
 * `mirin doctor` — check the project and environment before anything is built
 * (docs/agent-devtools.md).
 *
 * Startup failures in a desktop framework are mostly environmental: a missing
 * entry file, a port already taken, an unsupported platform, a config that does not
 * parse. Those all look identical from outside — a window that never appears — and
 * a caller with no terminal cannot tell them apart. `doctor` names them, and
 * `--json` makes the answer parseable.
 *
 * It also reports the previous session's outcome, which turns "the app didn't
 * start" into "the app exited with 1 and 3 errors, here they are".
 */

import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readCurrentSession,
  readEventsFile,
  readSessionInfo,
  sessionPaths,
} from "mirinjs/devtools/session";
import { isInRepo, vendoredCef } from "./artifacts.ts";
import { createReporter } from "./shared/report.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it, when there is something to do. */
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  projectDir: string;
  platform: string;
  checks: DoctorCheck[];
}

const SUPPORTED = new Set(["darwin-arm64", "win32-x64", "win32-arm64", "linux-x64", "linux-arm64"]);

function ok(name: string, detail: string): DoctorCheck {
  return { name, status: "ok", detail };
}
function warn(name: string, detail: string, fix?: string): DoctorCheck {
  return { name, status: "warn", detail, ...(fix !== undefined ? { fix } : {}) };
}
function fail(name: string, detail: string, fix?: string): DoctorCheck {
  return { name, status: "fail", detail, ...(fix !== undefined ? { fix } : {}) };
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

function checkPlatform(): DoctorCheck {
  const target = `${process.platform}-${process.arch}`;
  return SUPPORTED.has(target)
    ? ok("platform", `${target}, bun ${Bun.version}`)
    : fail(
        "platform",
        `${target} is not a supported target`,
        `supported: ${[...SUPPORTED].join(", ")}`,
      );
}

/** Load `mirin.config.ts` and check the fields the CLI and host both require. */
async function checkConfig(projectDir: string): Promise<DoctorCheck[]> {
  const path = join(projectDir, "mirin.config.ts");
  if (!existsSync(path)) {
    return [fail("config", "mirin.config.ts not found", "run `mirin init` or check the directory")];
  }

  let config: Record<string, unknown>;
  try {
    const loaded: unknown = (await import(path)).default;
    if (typeof loaded !== "object" || loaded === null) {
      return [fail("config", "mirin.config.ts has no default export object")];
    }
    config = loaded as Record<string, unknown>;
  } catch (err) {
    return [
      fail("config", `mirin.config.ts failed to load: ${err instanceof Error ? err.message : err}`),
    ];
  }

  const checks: DoctorCheck[] = [];
  const missing = ["id", "name", "main", "windows"].filter((key) => config[key] == null);
  checks.push(
    missing.length === 0
      ? ok("config", `${String(config.name)} (${String(config.id)})`)
      : fail("config", `missing required field(s): ${missing.join(", ")}`),
  );

  const main = typeof config.main === "string" ? config.main : "main/main.ts";
  checks.push(
    existsSync(join(projectDir, main))
      ? ok("main entry", main)
      : fail("main entry", `${main} does not exist`, "point `main` at your main-process entry"),
  );

  const windows =
    typeof config.windows === "object" && config.windows !== null ? config.windows : {};
  const names = Object.keys(windows);
  checks.push(
    names.length > 0
      ? ok("windows", names.join(", "))
      : warn("windows", "no windows declared", "the app will start with nothing visible"),
  );

  const devtools = config.devtools;
  if (typeof devtools === "object" && devtools !== null && "production" in devtools) {
    const enabled = (devtools as { production?: unknown }).production === true;
    checks.push(
      enabled
        ? warn(
            "devtools",
            "devtools.production is true — packaged builds will expose the inspector",
            "remove it before shipping: the inspector can evaluate code in your app",
          )
        : ok("devtools", "production access disabled"),
    );
  }
  return checks;
}

function checkUi(projectDir: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  checks.push(
    existsSync(join(projectDir, "index.html"))
      ? ok("ui entry", "index.html")
      : warn("ui entry", "no index.html at the project root", "Vite needs an HTML entry"),
  );
  const viteConfig = ["vite.config.ts", "vite.config.js", "vite.config.mts"].find((name) =>
    existsSync(join(projectDir, name)),
  );
  checks.push(
    viteConfig !== undefined
      ? ok("vite config", viteConfig)
      : warn("vite config", "none found", "Vite will run with defaults"),
  );
  return checks;
}

function checkCef(): DoctorCheck {
  if (isInRepo()) {
    // Resolved from the CLI, not the cwd: `doctor` is normally run from an example
    // app, where `<example>/vendor/cef` never exists and the repo's does.
    const vendored = vendoredCef();
    return vendored.present
      ? ok("cef", "vendor/cef is present")
      : warn("cef", `${vendored.path} is missing or incomplete`, "run `bun scripts/fetch-cef.ts`");
  }
  const cache = join(homedir(), ".mirinjs", "cef");
  return existsSync(cache)
    ? ok("cef", `cached at ${cache}`)
    : warn("cef", "no cached CEF runtime", "the first `mirin dev` downloads it (a few hundred MB)");
}

async function checkPorts(): Promise<DoctorCheck[]> {
  const [vite, cdp] = await Promise.all([portFree(5173), portFree(9222)]);
  return [
    vite
      ? ok("vite port", "5173 is free")
      : warn("vite port", "5173 is in use", "mirin dev probes upward, so this is not fatal"),
    cdp
      ? ok("devtools port", "9222 is free")
      : warn("devtools port", "9222 is in use", "mirin dev probes upward, so this is not fatal"),
  ];
}

/** Report how the previous run ended — usually the fastest route to the cause. */
function checkLastSession(projectDir: string): DoctorCheck {
  const dir = readCurrentSession(projectDir);
  if (dir === undefined) return ok("last session", "none recorded yet");

  const paths = sessionPaths(dir);
  const info = readSessionInfo(paths);
  const errors = readEventsFile(paths.events).filter((event) => event.level === "error");
  const lastPhase = info?.phases.at(-1);
  const phase =
    lastPhase !== undefined ? `${lastPhase.name}=${lastPhase.status}` : "no phases recorded";

  if (errors.length === 0) return ok("last session", `${phase}, no errors — ${dir}`);
  const first = errors[0];
  return warn(
    "last session",
    `${phase}, ${errors.length} error(s) — first: ${first?.msg ?? ""}`,
    `full stream: ${paths.events}`,
  );
}

function renderReport(report: DoctorReport): void {
  const glyph: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };
  console.log(`\nmirin doctor — ${report.projectDir}\n`);
  for (const check of report.checks) {
    console.log(`  ${glyph[check.status]} ${check.name.padEnd(14)} ${check.detail}`);
    if (check.fix !== undefined) console.log(`${" ".repeat(19)}→ ${check.fix}`);
  }
  const failures = report.checks.filter((check) => check.status === "fail").length;
  const warnings = report.checks.filter((check) => check.status === "warn").length;
  console.log(
    `\n${report.ok ? "✓ ready" : `✗ ${failures} blocking problem(s)`}${warnings > 0 ? `, ${warnings} warning(s)` : ""}\n`,
  );
}

/** Run the preflight. Exit code 0 unless a check failed outright. */
export async function doctor(
  projectDir = process.cwd(),
  options: { json?: boolean } = {},
): Promise<number> {
  const reporter = createReporter(options.json === true);
  const checks: DoctorCheck[] = [
    checkPlatform(),
    ...(await checkConfig(projectDir)),
    ...checkUi(projectDir),
    checkCef(),
    ...(await checkPorts()),
    checkLastSession(projectDir),
  ];
  const report: DoctorReport = {
    ok: !checks.some((check) => check.status === "fail"),
    projectDir,
    platform: `${process.platform}-${process.arch}`,
    checks,
  };
  reporter.finish({ ...report }, () => renderReport(report));
  return report.ok ? 0 : 1;
}
