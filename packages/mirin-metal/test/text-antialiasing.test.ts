import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseNativeEvent, spawnNativeHost } from "../src/host.ts";

/**
 * A stand-in host: says `word`, then writes what it was started with
 * (`MIRIN_METAL_TEXT`) and the first line it is sent, if any comes.
 */
async function standIn(
  word: string,
  act: (host: ReturnType<typeof spawnNativeHost>) => boolean,
  options: Parameters<typeof spawnNativeHost>[1] = {},
): Promise<{ took: boolean; started: string; line: string }> {
  const dir = mkdtempSync(join(tmpdir(), "mirin-text-"));
  try {
    const script = join(dir, "host");
    writeFileSync(
      script,
      `#!/bin/sh\nprintf '%s' "$MIRIN_METAL_TEXT" > "${dir}/started"\nprintf '%s\\n' '${word}'\nhead -n 1 > "${dir}/line"\n`,
    );
    chmodSync(script, 0o755);
    const host = spawnNativeHost(script, options);
    await new Promise<void>((heard) =>
      host.onEvent((event) => {
        if (event.type === "protocol") heard();
      }),
    );
    const took = act(host);
    const closed = new Promise<void>((resolve) => host.onClose(resolve));
    // A host that was sent nothing still reads: its input ends here.
    if (!took) host.close();
    await closed;
    // Closed before it read anything, the stand-in may not have made the file.
    const line = Bun.file(join(dir, "line"));
    return {
      took,
      started: await Bun.file(join(dir, "started")).text(),
      line: (await line.exists()) ? (await line.text()).trim() : "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a host that takes it is sent the antialiasing asked for, while it runs", async () => {
  const says = '{"type":"protocol","nodeId":"root","patches":1,"textAntialiasing":true}';
  expect(parseNativeEvent(says)).toEqual({
    type: "protocol",
    nodeId: "root",
    patches: 1,
    textAntialiasing: true,
  });
  const { took, line } = await standIn(says, (host) => host.setTextAntialiasing("subpixel"));
  expect(took).toBe(true);
  expect(JSON.parse(line)).toEqual({ textAntialiasing: "subpixel" });
});

test("a host from before it is sent nothing", async () => {
  const { took, line } = await standIn('{"type":"protocol","nodeId":"root","patches":1}', (host) =>
    host.setTextAntialiasing("grayscale"),
  );
  expect(took).toBe(false);
  expect(line).toBe("");
});

test("a host starts with the antialiasing its spawn names", async () => {
  const word = '{"type":"protocol","nodeId":"root","patches":1}';
  const named = await standIn(word, () => false, { textAntialiasing: "subpixel" });
  expect(named.started).toBe("subpixel");
  // Unsaid, the driver's own environment (or nothing) decides, as before.
  const unsaid = await standIn(word, () => false, { env: { MIRIN_METAL_TEXT: "" } });
  expect(unsaid.started).toBe("");
});
