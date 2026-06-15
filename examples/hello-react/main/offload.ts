/**
 * Main-process helper showing the "extra worker" pattern: lazily spawn the
 * bundled `hash` worker (via `resolveWorker`) and round-trip a message. Lives in
 * its own module so the UI never pulls `node:worker_threads` into its bundle
 * (rpc.ts is imported type-only by the UI).
 */

import { Worker } from "node:worker_threads";
import { resolveWorker } from "mirinjs";

let worker: Worker | undefined;

function hashWorker(): Worker {
  // resolveWorker → .mirin/workers/hash.js (dev) or Resources/workers/hash.js (prod).
  if (!worker) worker = new Worker(resolveWorker("hash"));
  return worker;
}

/** Offload a SHA-256 to the bundled `hash` worker. */
export function hashInWorker(text: string): Promise<string> {
  const w = hashWorker();
  return new Promise((resolve) => {
    const onMessage = (hash: string) => {
      w.off("message", onMessage);
      resolve(hash);
    };
    w.on("message", onMessage);
    w.postMessage(text);
  });
}
