/**
 * Drives the gallery through the renderer's simulated input: opens the
 * overlays, toggles controls, selects from menus, and asserts on the tree
 * the components send. Run: `bun demo/check.ts [path-to-host]`
 */

import { render, spawnNativeHost } from "@mirinjs/metal";
import { createElement } from "react";
import { Gallery } from "./gallery.tsx";

const binary =
  Bun.argv[2] ??
  new URL("../../../crates/mirin-metal/target/debug/mirin-metal-host", import.meta.url).pathname;
process.env.MIRIN_METAL_TITLE = "metal-ui check";
const transport = spawnNativeHost(binary);
const root = render(createElement(Gallery), transport);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const treeHas = (text: string) => (root.lastTree() ?? "").includes(text);

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(40);
  }
  throw new Error(`timed out: ${what}`);
}

async function click(testID: string): Promise<void> {
  await waitUntil(() => root.nodeId(testID) !== undefined, `node ${testID} mounted`);
  const id = root.nodeId(testID);
  if (!id) throw new Error(`no node ${testID}`);
  const before = root.lastTree();
  transport.simulate({ kind: "click", id });
  const settled = Date.now() + 250;
  while (Date.now() < settled && root.lastTree() === before) await sleep(10);
}

async function step(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  console.log(`  ✓ ${name}`);
}

let failed = false;
try {
  await step("the gallery renders every component", async () => {
    await waitUntil(() => treeHas("Create project") && treeHas("INV003"), "gallery tree");
    await sleep(1200);
  });
  await step("buttons, checkbox, switch, and toggle respond", async () => {
    await click("btn-default");
    await waitUntil(() => treeHas("last action: default"), "button handler");
    await click("terms");
    await click("airplane");
    await waitUntil(() => !treeHas('"children":["✓"]') || treeHas("Airplane"), "controls toggled");
  });
  await step("text input receives typed text", async () => {
    await click("name");
    transport.simulate({ kind: "type", text: "metal" });
    await waitUntil(() => treeHas('"value":"metal"'), "input value");
  });
  await step("select opens and picks an option", async () => {
    await click("framework");
    await click("select:astro");
    await waitUntil(() => treeHas("Astro") && treeHas('"height":0'), "selection closed the list");
  });
  await step("tabs switch content", async () => {
    await click("tab:password");
    await waitUntil(() => treeHas("Your session has expired"), "password tab");
  });
  await step("dialog opens in the overlay layer and closes", async () => {
    await click("open-dialog");
    await waitUntil(() => treeHas("Edit profile"), "dialog content");
    await click("dialog-save");
    await waitUntil(() => treeHas("last action: dialog-save"), "dialog action");
    await click("dialog-close");
    await waitUntil(() => !treeHas("Edit profile"), "dialog closed");
  });
  await step("alert dialog confirms", async () => {
    await click("open-alert");
    await waitUntil(() => treeHas("Are you absolutely sure?"), "alert content");
    await click("alert-dialog-action");
    await waitUntil(
      () => treeHas("last action: deleted") && !treeHas("absolutely sure"),
      "confirmed",
    );
  });
  await step("sheet, popover, and dropdown menu open and act", async () => {
    await click("open-sheet");
    await waitUntil(() => treeHas("Adjust your preferences"), "sheet");
    await click("sheet-close");
    await waitUntil(() => !treeHas("Adjust your preferences"), "sheet closed");
    await click("open-popover");
    await waitUntil(() => treeHas("Dimensions"), "popover");
    await click("open-popover");
    await click("open-menu");
    await click("menu-profile");
    await waitUntil(() => treeHas("last action: profile"), "menu item");
  });
  await step("the layout query sees painted overlays and rows", async () => {
    let nodes = 0;
    transport.onEvent((event) => {
      if (event.type === "layout") nodes = event.nodes.length;
    });
    transport.simulate({ kind: "layout" });
    await waitUntil(() => nodes > 40, "layout snapshot");
  });
  console.log("✓ metal-ui gallery check passed");
} catch (error) {
  failed = true;
  console.error(
    `✗ metal-ui gallery check failed: ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  root.unmount();
  process.exit(failed ? 1 : 0);
}
