import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { Text, View } from "../src/components.ts";
import { spawnNativeHost } from "../src/host.ts";
import { render } from "../src/render.ts";
import type { NativeEvent } from "../src/types.ts";

/** A stand-in host: it says it takes patches as it starts, then keeps every line it is sent. */
function standIn(): { binary: string; lines: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "mirin-warm-"));
  const binary = join(dir, "host");
  const kept = join(dir, "lines");
  writeFileSync(kept, "");
  writeFileSync(
    binary,
    `#!/bin/sh\nprintf '%s\\n' '{"type":"protocol","nodeId":"root","patches":1}'\nexec cat >> "${kept}"\n`,
  );
  chmodSync(binary, 0o755);
  return { binary, lines: () => readFileSync(kept, "utf8").split("\n").filter(Boolean) };
}

async function until(holds: () => boolean): Promise<void> {
  while (!holds()) await Bun.sleep(2);
}

// A host kept warm said its protocol long before anything rendered into it.
test("a listener added after the host's word still hears it", async () => {
  const { binary } = standIn();
  const host = spawnNativeHost(binary, { deferred: true });
  const early: NativeEvent[] = [];
  host.onEvent((event) => early.push(event));
  await until(() => early.length > 0);
  const late: NativeEvent[] = [];
  host.onEvent((event) => late.push(event));
  expect(late).toEqual([{ type: "protocol", nodeId: "root", patches: 1 }]);
  // Said once to each: the early listener is not told again.
  expect(early).toHaveLength(1);
  host.close();
});

test("a tree rendered into a warm host goes at once, with ids", async () => {
  const { binary, lines } = standIn();
  const host = spawnNativeHost(binary, { deferred: true });
  let said = false;
  host.onEvent(() => {
    said = true;
  });
  await until(() => said);
  const started = performance.now();
  const root = render(createElement(View, null, createElement(Text, null, "warm")), host);
  await until(() => lines().length > 0);
  // Well inside the wait a silent host gets (`HOST_WORD_MS`).
  expect(performance.now() - started).toBeLessThan(200);
  const tree = JSON.parse(lines()[0] ?? "") as {
    children: Array<{ type: string; props: { id?: string } }>;
  };
  expect(tree.children[0]?.type).toBe("text");
  expect(tree.children[0]?.props.id).toBeString();
  root.unmount();
});
