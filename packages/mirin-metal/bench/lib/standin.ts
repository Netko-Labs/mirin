/**
 * A stand-in host for driver benchmarks: a transport with no process behind
 * it. It announces the patch protocol as the real host does, so the driver
 * sends one whole tree and patches after, and it counts (or keeps) every
 * line, so what the driver costs is timed without a compositor in the way.
 */

import type { NativeEvent, NativeTransport, SimCommand } from "../../src/index.ts";
import { markAnnounces } from "../../src/lib/handshake.ts";

export interface StandIn {
  transport: NativeTransport;
  /** Deliver an event as the host would. */
  emit(event: NativeEvent): void;
  /** Lines sent so far. */
  sends: number;
  /** Their length in UTF-16 units (ASCII trees: bytes). */
  bytes: number;
  /** `Bun.nanoseconds()` of the newest send. */
  lastSendAt: number;
  /** Every line, when asked to keep them. */
  lines: string[];
}

export interface StandInOptions {
  /** Keep every line in `lines` (a wire record). */
  keep?: boolean;
  /** Announce the patch protocol; false stands in for a host that takes whole trees only. */
  patches?: boolean;
  /** Called with each line (after it is counted). */
  onSend?: (line: string) => void;
  /**
   * Say, as `spawnNativeHost` does, that the host announces its protocol
   * first: the driver holds its first tree for the word (`emit` it).
   */
  announces?: boolean;
}

export function standIn(options: StandInOptions = {}): StandIn {
  const listeners: Array<(event: NativeEvent) => void> = [];
  const host: StandIn = {
    sends: 0,
    bytes: 0,
    lastSendAt: 0,
    lines: [],
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    transport: (options.announces ? markAnnounces : <T>(transport: T) => transport)({
      send(line) {
        host.sends += 1;
        host.bytes += line.length;
        host.lastSendAt = Bun.nanoseconds();
        if (options.keep) host.lines.push(line);
        options.onSend?.(line);
      },
      onEvent(listener) {
        listeners.push(listener);
        if (options.patches !== false) listener({ type: "protocol", nodeId: "root", patches: 1 });
      },
      onClose() {},
      simulate(_command: SimCommand) {},
      close() {},
    }),
  };
  return host;
}

/** Wait until the driver has sent nothing for `quietMs` (its effects and imports have landed). */
export async function quiet(host: StandIn, quietMs = 30, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = -1;
  while (Date.now() < deadline) {
    if (host.sends === seen) return;
    seen = host.sends;
    await Bun.sleep(quietMs);
  }
}
