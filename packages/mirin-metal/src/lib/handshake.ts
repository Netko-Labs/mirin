/**
 * Whether a transport's host says which patch protocol it takes before
 * anything else (`{"type":"protocol",…}`, the first line a host from
 * `MIRIN_METAL_PATCHES` on writes). For such a transport the driver holds
 * its first tree until the host has said so, or `HOST_WORD_MS` has passed
 * with nothing from it (a host from before patches, which never says), and
 * sends it once, with ids when the host takes patches (`lib/tree-sync.ts`).
 * Without the word, a tree goes out without ids and again with them.
 *
 * Internal: `spawnNativeHost` marks its transports; no public type says it.
 */

import type { NativeTransport } from "../types.ts";

const ANNOUNCES = Symbol("mirin-metal.announces-protocol");

/**
 * How long the first tree waits for the host's word. A host says it as its
 * process starts (a few ms after the spawn); one that hasn't by then is
 * taken for one that never will, and gets the tree as before.
 */
export const HOST_WORD_MS = 250;

/** Mark `transport` as one whose host announces its protocol first. */
export function markAnnounces<T extends object>(transport: T): T {
  Object.defineProperty(transport, ANNOUNCES, { value: true });
  return transport;
}

/** Whether `transport` was marked by `markAnnounces`. */
export function announces(transport: NativeTransport): boolean {
  return (transport as { [ANNOUNCES]?: boolean })[ANNOUNCES] === true;
}
