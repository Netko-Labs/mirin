import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseNativeEvent, spawnNativeHost } from "../src/host.ts";

/** A stand-in host: says `word`, and writes the `MIRIN_METAL_TEXT` it was started with. */
async function standIn(
  word: string,
  options: Parameters<typeof spawnNativeHost>[1] = {},
): Promise<{ started: string }> {
  const dir = mkdtempSync(join(tmpdir(), "mirin-text-"));
  try {
    const script = join(dir, "host");
    writeFileSync(
      script,
      `#!/bin/sh\nprintf '%s' "$MIRIN_METAL_TEXT" > "${dir}/started"\nprintf '%s\\n' '${word}'\ncat > /dev/null\n`,
    );
    chmodSync(script, 0o755);
    const host = spawnNativeHost(script, options);
    await new Promise<void>((heard) =>
      host.onEvent((event) => {
        if (event.type === "protocol") heard();
      }),
    );
    const closed = new Promise<void>((resolve) => host.onClose(resolve));
    host.close();
    await closed;
    return { started: await Bun.file(join(dir, "started")).text() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a host starts with the antialiasing its spawn names", async () => {
  const word = '{"type":"protocol","nodeId":"root","patches":1}';
  const named = await standIn(word, { textAntialiasing: "subpixel" });
  expect(named.started).toBe("subpixel");
  const grays = await standIn(word, { textAntialiasing: "grayscale" });
  expect(grays.started).toBe("grayscale");
  // Unsaid, the driver's own environment (or nothing) decides, as before.
  const unsaid = await standIn(word, { env: { MIRIN_METAL_TEXT: "" } });
  expect(unsaid.started).toBe("");
});

test("a host kept warm starts with it too: its windows open in it", async () => {
  const word = '{"type":"protocol","nodeId":"root","patches":1}';
  const warm = await standIn(word, { deferred: true, textAntialiasing: "subpixel" });
  expect(warm.started).toBe("subpixel");
});

test("nothing changes it while the host runs", async () => {
  // A host from when a line did announces it: the word is not this driver's,
  // and the transport has no way to send the line.
  const says = '{"type":"protocol","nodeId":"root","patches":1,"textAntialiasing":true}';
  expect(parseNativeEvent(says)).toEqual({ type: "protocol", nodeId: "root", patches: 1 });
  const dir = mkdtempSync(join(tmpdir(), "mirin-text-"));
  try {
    const script = join(dir, "host");
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${says}'\ncat > /dev/null\n`);
    chmodSync(script, 0o755);
    const host = spawnNativeHost(script);
    await new Promise<void>((heard) => host.onEvent(() => heard()));
    expect("setTextAntialiasing" in host).toBe(false);
    host.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
