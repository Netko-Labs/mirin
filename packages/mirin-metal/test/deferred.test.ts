import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseNativeEvent, type SurfaceOptions, spawnNativeHost } from "../src/host.ts";

// A stand-in host that keeps what it is told: its environment and first line.
test("a deferred host is started without a window and opened on demand", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mirin-deferred-"));
  const standIn = join(dir, "host");
  writeFileSync(
    standIn,
    `#!/bin/sh\nprintf '%s' "$MIRIN_METAL_DEFERRED" > "${dir}/env"\nhead -n 1 > "${dir}/line"\n`,
  );
  chmodSync(standIn, 0o755);
  const host = spawnNativeHost(standIn, { deferred: true, title: "ignored until open" });
  host.open({ title: "Launcher", width: 640, height: 120, surface: { layer: "overlay" } });
  await new Promise<void>((resolve) => host.onClose(resolve));
  expect(await Bun.file(join(dir, "env")).text()).toBe("1");
  expect(JSON.parse(await Bun.file(join(dir, "line")).text())).toEqual({
    open: { title: "Launcher", width: 640, height: 120, surface: { layer: "overlay" } },
  });
});

// A resident host is hidden and opened again: the lines say so, in order.
test("a resident host hides its window and opens it again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mirin-resident-"));
  const standIn = join(dir, "host");
  writeFileSync(standIn, `#!/bin/sh\nhead -n 3 > "${dir}/lines"\n`);
  chmodSync(standIn, 0o755);
  const host = spawnNativeHost(standIn, { deferred: true });
  host.open({ title: "Launcher" });
  host.hide();
  host.open({ title: "Launcher" });
  await new Promise<void>((resolve) => host.onClose(resolve));
  const lines = (await Bun.file(join(dir, "lines")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lines).toEqual([
    { open: { title: "Launcher" } },
    { hide: true },
    { open: { title: "Launcher" } },
  ]);
});

// An opaque surface is said as the app says it, at spawn and at open.
test("a surface says it is opaque in the host's environment and in an open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mirin-opaque-"));
  const standIn = join(dir, "host");
  writeFileSync(
    standIn,
    `#!/bin/sh\nprintf '%s' "$MIRIN_METAL_SURFACE" > "${dir}/env"\nhead -n 1 > "${dir}/line"\n`,
  );
  chmodSync(standIn, 0o755);
  const bar: SurfaceOptions = { anchor: ["top", "left", "right"], exclusiveZone: 28, opaque: true };
  const host = spawnNativeHost(standIn, { deferred: true, surface: bar });
  host.open({ title: "Lock", surface: { role: "lock", opaque: true } });
  await new Promise<void>((resolve) => host.onClose(resolve));
  expect(JSON.parse(await Bun.file(join(dir, "env")).text())).toEqual(bar);
  expect(JSON.parse(await Bun.file(join(dir, "line")).text())).toEqual({
    open: { title: "Lock", surface: { role: "lock", opaque: true } },
  });
});

test("a host that opens a surface opaque says so", () => {
  expect(
    parseNativeEvent('{"type":"protocol","nodeId":"root","patches":1,"opaqueSurface":true}'),
  ).toEqual({ type: "protocol", nodeId: "root", patches: 1, opaqueSurface: true });
  expect(
    parseNativeEvent(
      '{"type":"protocol","nodeId":"root","patches":1,"runFont":true,"shiftTabKey":true}',
    ),
  ).toEqual({ type: "protocol", nodeId: "root", patches: 1, runFont: true, shiftTabKey: true });
});

test("a host whose fields publish their text says so", () => {
  expect(
    parseNativeEvent('{"type":"protocol","nodeId":"root","patches":1,"fieldText":true}'),
  ).toEqual({ type: "protocol", nodeId: "root", patches: 1, fieldText: true });
  expect(
    parseNativeEvent('{"type":"protocol","nodeId":"root","patches":1,"fieldText":"yes"}'),
  ).toEqual({ type: "protocol", nodeId: "root", patches: 1 });
});
