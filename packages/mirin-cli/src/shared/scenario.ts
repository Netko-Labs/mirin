/**
 * Loading and running a `mirin check` scenario — an ordinary module that
 * default-exports an async function (docs/agent-devtools.md).
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { CheckScenario } from "mirinjs/check";
import { createDriver, type ScenarioOutcome } from "./driver.ts";
import type { InspectorClient } from "./inspector.ts";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve and import a scenario file. Throws with an actionable message. */
export async function loadScenario(projectDir: string, file: string): Promise<CheckScenario> {
  const path = isAbsolute(file) ? file : resolve(projectDir, file);
  if (!existsSync(path)) {
    throw new Error(`scenario file not found: ${path}`);
  }

  let loaded: unknown;
  try {
    loaded = (await import(path)) as unknown;
  } catch (err) {
    throw new Error(`scenario ${file} failed to load: ${message(err)}`);
  }

  const scenario = (loaded as { default?: unknown }).default;
  if (typeof scenario !== "function") {
    throw new Error(
      `scenario ${file} must default-export a function — see \`defineCheck\` from "mirinjs/check"`,
    );
  }
  return scenario as CheckScenario;
}

/** Run `scenario` against the app. Never throws: a failure is a result, so the
 *  caller still captures artifacts and writes a report. */
export async function runScenario(
  client: InspectorClient,
  scenario: CheckScenario,
  onStep?: (name: string) => void,
): Promise<ScenarioOutcome> {
  const { driver, outcome, finishStep } = createDriver(client, onStep);
  try {
    await scenario(driver);
    finishStep(true);
  } catch (err) {
    finishStep(false);
    outcome.failure = {
      step: outcome.steps.at(-1)?.name ?? "scenario",
      message: message(err),
    };
  }
  return outcome;
}
