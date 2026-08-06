import type { CheckScenario } from "./types.ts";

/**
 * Declare a `mirin check` scenario. Default-export the result from the file you
 * pass to `mirin check --scenario`.
 *
 * ```ts
 * import { defineCheck } from "mirinjs/check";
 *
 * export default defineCheck(async (app) => {
 *   app.step("add a todo");
 *   await app.click("text=add a todo");
 *   await app.type("ship it");
 *   await app.click("text=Add");
 *   await app.expectText("ship it");
 * });
 * ```
 *
 * Identity at runtime — its whole job is to type the callback, so `app` is
 * inferred without the file having to annotate it.
 */
export function defineCheck(scenario: CheckScenario): CheckScenario {
  return scenario;
}
