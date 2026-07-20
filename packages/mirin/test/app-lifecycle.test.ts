import { expect, test } from "bun:test";
import { openAutomaticWindows, WindowCreationTracker } from "../src/app/lib/window-lifecycle.ts";

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
