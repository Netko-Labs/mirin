/**
 * An extra Bun Worker, declared in mirin.config.ts as `workers: { hash: … }` and
 * resolved at runtime with `resolveWorker("hash")`. It runs OFF the app's main
 * worker — pure compute only, no window/native APIs (only the app worker owns
 * AppKit/CEF). Here it just SHA-256s whatever it's sent, to show the round-trip.
 */

import { parentPort } from "node:worker_threads";

parentPort?.on("message", (text: string) => {
  const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  parentPort?.postMessage(hash);
});
