/**
 * The wire record: every line the driver sends over a scripted session on
 * the example browser (each example opened, some of them pressed, the search
 * typed in, the theme toggled). Two builds of the driver that send the same
 * bytes for it are the same driver as far as a host can tell; run it before
 * and after a change and compare the files (`cmp`, or `--against=<file>`).
 *
 * Timers fire when the session advances its own clock, `Math.random` is
 * seeded (`clock.ts`), the examples' modules are loaded up front and remote
 * images resolve to nothing, so two runs of one build give the same record.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installVirtualClock } from "./clock.ts";

const clock = installVirtualClock();
// Remote images: an empty cache and no network, so every one resolves to nothing, at once.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "metal-ui-record-"));
globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
// Nothing leaves the session: a pressed link opens no browser, a copy button runs no tool.
(Bun as { spawn: unknown }).spawn = () => {
  throw new Error("the wire record spawns nothing");
};
// After the clock: React's scheduler keeps the `setTimeout` it finds when it loads.
const { openBrowser } = await import("./session.tsx");
const { listExamples } = await import("../../demo/browser.tsx");
// Every example's module is loaded before the session: the browser's own
// `import()` then resolves in microtasks, never racing a commit by the disk's time.
for (const name of listExamples()) {
  await import(join(import.meta.dir, "..", "..", "demo", "examples", `${name}.tsx`));
}

/** Let updates scheduled by a timer land (the scheduler's task is an immediate). */
async function turns(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await new Promise((done) => setImmediate(done));
}

interface WireNode {
  type: string;
  props: { id?: string; onPress?: boolean; onHover?: boolean; onChange?: boolean };
  children?: Array<WireNode | string>;
}

/** What a person could act on in the tree, in document order, leaving out `skip` (the sidebar, the toolbar). */
function targets(tree: string | null, skip: Set<string>) {
  const found = { press: [] as string[], hover: [] as string[], input: [] as string[] };
  const visit = (node: WireNode | string): void => {
    if (typeof node === "string") return;
    const id = node.props.id;
    if (id !== undefined && !skip.has(id)) {
      if (node.type === "view" && node.props.onPress) found.press.push(id);
      if (node.type === "view" && node.props.onHover) found.hover.push(id);
      if (node.type === "input" && node.props.onChange) found.input.push(id);
    }
    for (const child of node.children ?? []) visit(child);
  };
  if (tree) visit(JSON.parse(tree) as WireNode);
  return found;
}

const BOUNDS = { x: 40, y: 40, width: 120, height: 32 };

export async function record(path: string, options: { whole: boolean; against?: string }) {
  const hasher = new Bun.CryptoHasher("sha256");
  const lines: string[] = [];
  const session = await openBrowser({
    initial: "button-demo",
    patches: !options.whole,
    quietMs: 40,
    onSend(line) {
      hasher.update(line);
      hasher.update("\n");
      // A host that takes whole trees gets one per commit: keep their digests only.
      lines.push(options.whole ? `${Bun.hash(line).toString(16)} ${line.length}` : line);
    },
  });
  const { host, root } = session;
  const settle = async () => {
    await session.settle();
    await clock.advance(1200, turns);
    await session.settle();
  };
  await settle();
  // The browser's own controls: everything else that can be pressed is the example's.
  const chrome = new Set<string>();
  for (const testID of ["toggle-theme", "search", ...session.examples.map((n) => `example:${n}`)]) {
    const id = root.nodeId(testID);
    if (id) chrome.add(id);
  }
  const examples = options.whole
    ? session.examples.filter((_, i) => i % 6 === 0)
    : session.examples;
  for (const name of examples) {
    if (!session.press(`example:${name}`)) throw new Error(`no example ${name}`);
    await settle();
    // In the example: hover the first thing that answers, type in the first
    // field, press the first two things (a trigger, then what it opened).
    const before = targets(root.lastTree(), chrome);
    const hovered = before.hover[0];
    if (hovered) {
      host.emit({ type: "hover", nodeId: hovered, hovered: true, bounds: BOUNDS });
      await settle();
      host.emit({ type: "hover", nodeId: hovered, hovered: false, bounds: BOUNDS });
      await settle();
    }
    const field = before.input[0];
    if (field) {
      host.emit({ type: "change", nodeId: field, value: "metal" });
      await settle();
    }
    for (let press = 0; press < 2; press += 1) {
      const id = targets(root.lastTree(), chrome).press[press === 0 ? 0 : 1];
      // Still there: the first press may have closed or replaced it.
      if (!id) break;
      host.emit({ type: "press", nodeId: id, bounds: BOUNDS });
      await settle();
    }
  }
  for (const query of ["d", "dr", "dro", "drop", "dropdown", "", "zzz", ""]) {
    session.type("search", query);
    await settle();
  }
  for (let round = 0; round < 4; round += 1) {
    session.press("toggle-theme");
    await settle();
    session.press(`example:${round % 2 === 0 ? "card-demo" : "table-demo"}`);
    await settle();
  }
  host.emit({ type: "resync", nodeId: "root", reason: "record" });
  await settle();

  const text = `${lines.join("\n")}\n`;
  await Bun.write(path, text);
  console.log(`${lines.length} lines, ${host.bytes} bytes sent, sha256 ${hasher.digest("hex")}`);
  console.log(`written to ${path}`);
  if (!options.against) return;
  const other = (await Bun.file(options.against).text()).split("\n");
  const mine = text.split("\n");
  const at = mine.findIndex((line, index) => line !== other[index]);
  if (at < 0 && mine.length === other.length) {
    console.log(`identical to ${options.against}`);
    return;
  }
  const index = at < 0 ? Math.min(mine.length, other.length) : at;
  const [a = "", b = ""] = [mine[index], other[index]];
  let column = 0;
  while (column < a.length && a[column] === b[column]) column += 1;
  console.log(`DIFFERENT from ${options.against}: line ${index + 1}, column ${column + 1}`);
  console.log(`  this: …${a.slice(Math.max(0, column - 80), column + 120)}`);
  console.log(`  that: …${b.slice(Math.max(0, column - 80), column + 120)}`);
  process.exitCode = 1;
}
