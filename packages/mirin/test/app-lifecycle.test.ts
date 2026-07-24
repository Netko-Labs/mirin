import { expect, test } from "bun:test";
import { DockPolicy } from "../src/app/lib/dock-policy.ts";
import {
  openAutomaticWindows,
  runAutomaticWindowStartup,
  unregisterWindow,
  WindowCreationTracker,
} from "../src/app/lib/window-lifecycle.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("window creation events resolve only the matching open call", async () => {
  const tracker = new WindowCreationTracker();
  let firstResolved = false;
  let secondResolved = false;
  const first = tracker.waitFor(1).then(() => {
    firstResolved = true;
  });
  const second = tracker.waitFor(2).then(() => {
    secondResolved = true;
  });

  tracker.markCreated(2);
  await second;
  expect(secondResolved).toBe(true);
  expect(firstResolved).toBe(false);

  tracker.markCreated(1);
  await first;
  expect(firstResolved).toBe(true);
});

test("a creation event observed before the waiter is retained", async () => {
  const tracker = new WindowCreationTracker();
  tracker.markCreated(9);
  expect(await tracker.waitFor(9)).toBeUndefined();
});

test("creation failures reject only the matching waiter", async () => {
  const tracker = new WindowCreationTracker();
  let firstResolved = false;
  const first = tracker.waitFor(1).then(() => {
    firstResolved = true;
  });
  const failure = new Error("native creation failed");
  const second = tracker.waitFor(2).then(
    () => null,
    (error: unknown) => error,
  );

  tracker.reject(2, failure);
  expect(await second).toBe(failure);
  expect(firstResolved).toBe(false);

  tracker.markCreated(1);
  await first;
  expect(firstResolved).toBe(true);
});

test("a creation failure observed before the waiter is retained", async () => {
  const tracker = new WindowCreationTracker();
  const failure = new Error("early failure");
  tracker.reject(12, failure);
  const result = await tracker.waitFor(12).then(
    () => null,
    (error: unknown) => error,
  );
  expect(result).toBe(failure);
});

test("closing a successfully created window does not retain a creation failure", async () => {
  const tracker = new WindowCreationTracker();
  const created = tracker.waitFor(4);
  tracker.markCreated(4);
  await created;
  tracker.reject(4, new Error("closed"));

  let settled = false;
  const reused = tracker.waitFor(4).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  tracker.markCreated(4);
  await reused;
});

test("failed handles unregister only their exact id and name mappings", () => {
  const first = { id: 1, name: "main" as string | undefined };
  const replacement = { id: 2, name: "main" as string | undefined };
  const byId = new Map([[first.id, first]]);
  const byName = new Map([["main", replacement]]);

  unregisterWindow(byId, byName, first);
  expect(byId.has(first.id)).toBe(false);
  expect(byName.get("main")).toBe(replacement);

  byId.set(replacement.id, replacement);
  unregisterWindow(byId, byName, replacement);
  expect(byId.has(replacement.id)).toBe(false);
  expect(byName.has("main")).toBe(false);
});

test("app readiness waits for every automatic window creation", async () => {
  const first = deferred();
  const second = deferred();
  const opened: string[] = [];
  let ready = false;

  const readiness = openAutomaticWindows(
    [
      { name: "first" },
      { name: "manual", open: "manual" as const },
      { name: "second", open: "auto" as const },
    ],
    (window) => {
      opened.push(window.name);
      return window.name === "first" ? first.promise : second.promise;
    },
  ).then(() => {
    ready = true;
  });

  expect(opened).toEqual(["first", "second"]);
  second.resolve();
  await second.promise;
  await Promise.resolve();
  expect(ready).toBe(false);

  first.resolve();
  await readiness;
  expect(ready).toBe(true);
});

test("automatic window failure quits without reporting ready", async () => {
  const failure = new Error("automatic window failed");
  let readyCount = 0;
  const quitErrors: unknown[] = [];

  runAutomaticWindowStartup(
    [{ name: "main" }, { name: "manual", open: "manual" as const }],
    () => Promise.reject(failure),
    () => {
      readyCount += 1;
    },
    (error) => {
      quitErrors.push(error);
    },
  );

  while (quitErrors.length === 0) await Promise.resolve();
  expect(readyCount).toBe(0);
  expect(quitErrors).toEqual([failure]);
});

test("pre-ready Dock policy flushes the latest request before public ready", () => {
  const policy = new DockPolicy();
  const applied: boolean[] = [];

  policy.set(false, false, (visible) => applied.push(visible));
  policy.set(true, false, (visible) => applied.push(visible));
  expect(applied).toEqual([]);

  policy.flush((visible) => applied.push(visible));
  expect(applied).toEqual([true]);

  policy.set(false, true, (visible) => applied.push(visible));
  expect(applied).toEqual([true, false]);
});
