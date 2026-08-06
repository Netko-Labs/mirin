/**
 * A `mirin check` scenario: the user flows this app exists to demonstrate, driven
 * end to end and asserted.
 *
 *   bunx mirin check --scenario ./check.ts
 *
 * Startup alone proves the window opened. This proves the app *works* — that a
 * typed query round-trips to the Bun process and back, that a mutation updates the
 * UI, and that push events arrive.
 */

import { defineCheck } from "mirinjs/check";

export default defineCheck(async (app) => {
  app.step("typed query round-trips to the main process");
  // Triple-click selects the field's contents, so typing replaces them.
  await app.click("text=your name", { clickCount: 3 });
  await app.type("code agent");
  await app.expectText("Hello, code agent!");

  app.step("typed mutation updates the list");
  await app.click("text=add a todo");
  await app.type("ship the devtools");
  await app.click("text=Add");
  // Deliberately *not* `expectText`: the text is still sitting in the input, so a
  // tree-wide match would pass even when the mutation never round-tripped. Assert
  // on the list itself — and wait, because the list only fills in once the main
  // process has answered.
  const listItems = (): Promise<string[]> =>
    app.evaluate<string[]>('[...document.querySelectorAll("li")].map((item) => item.textContent)');
  await app.waitUntil(
    async () => (await listItems()).includes("ship the devtools"),
    "the todo never reached the list",
  );
  await app.screenshot("todo-added");

  app.step("the main process pushes events");
  const ticks = await app.evaluate<number>(
    "Number((document.body.innerText.match(/tick #(\\d+)/) ?? [])[1] ?? 0)",
  );
  app.assert(ticks > 0, `expected a tick pushed from the Bun process, saw ${ticks}`);

  app.step("no RPC call failed along the way");
  const failed = await app.logs({ type: "rpc.error" });
  app.assert(
    failed.length === 0,
    `${failed.length} RPC call(s) failed: ${failed.map((event) => event.msg).join("; ")}`,
  );
});
