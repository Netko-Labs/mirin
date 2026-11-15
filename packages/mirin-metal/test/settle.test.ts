import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseNativeEvent, spawnNativeHost } from "../src/host.ts";
import type { NativeEvent } from "../src/types.ts";

/** A stand-in host: says `word`, keeps the first line it is sent, answers `answer`. */
async function exchange(
  word: string,
  answer: string,
): Promise<{ line: unknown; events: NativeEvent[] }> {
  const dir = mkdtempSync(join(tmpdir(), "mirin-settle-"));
  try {
    const standIn = join(dir, "host");
    writeFileSync(
      standIn,
      `#!/bin/sh\nprintf '%s\\n' '${word}'\nhead -n 1 > "${dir}/line"\nprintf '%s\\n' '${answer}'\n`,
    );
    chmodSync(standIn, 0o755);
    const host = spawnNativeHost(standIn);
    const events: NativeEvent[] = [];
    host.onEvent((event) => events.push(event));
    host.simulate({ kind: "settle" });
    await new Promise<void>((resolve) => host.onClose(resolve));
    return { line: JSON.parse(await Bun.file(join(dir, "line")).text()), events };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a host that settles says so, and its answer says what it drew", async () => {
  const { line, events } = await exchange(
    '{"type":"protocol","nodeId":"root","patches":1,"settle":true}',
    '{"type":"settled","nodeId":"root","quiet":true,"scene":"00000000000000ff","frames":"1f"}',
  );
  expect(line).toEqual({ sim: { kind: "settle" } });
  expect(events).toEqual([
    { type: "protocol", nodeId: "root", patches: 1, settle: true },
    { type: "settled", nodeId: "root", quiet: true, scene: "00000000000000ff", frames: "1f" },
  ]);
});

test("a host from before settle does not say it, and an answer without quiet is dropped", async () => {
  const { events } = await exchange(
    '{"type":"protocol","nodeId":"root","patches":1}',
    '{"type":"settled","nodeId":"root"}',
  );
  expect(events).toEqual([{ type: "protocol", nodeId: "root", patches: 1 }]);
});

test("a host that takes a simulated activation says so", () => {
  expect(
    parseNativeEvent(
      '{"type":"protocol","nodeId":"root","patches":1,"settle":true,"activation":true}',
    ),
  ).toEqual({ type: "protocol", nodeId: "root", patches: 1, settle: true, activation: true });
  // One from before says nothing of it, and anything but `true` is not a yes.
  expect(
    parseNativeEvent('{"type":"protocol","nodeId":"root","patches":1,"activation":"yes"}'),
  ).toEqual({ type: "protocol", nodeId: "root", patches: 1 });
});
