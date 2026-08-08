/**
 * A `mirin check` scenario for this app's user flows.
 * Run: `bunx mirin check --scenario ./check.ts`
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
  // Assert on the list, not the input: a tree-wide text match passes even if the
  // mutation never round-tripped.
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
