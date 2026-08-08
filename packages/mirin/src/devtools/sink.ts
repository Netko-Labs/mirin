/**
 * The event sink: a bounded in-memory ring buffer plus an optional append-only
 * JSONL mirror on disk. It never throws (filesystem failures degrade to
 * memory-only) and never logs (`logger` feeds it; logging here would recurse).
 * Module level, not `lib/`: sibling modules record through it, and it imports
 * nothing from the runtime, so it can never join an import cycle.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { selectEvents } from "./lib/query.ts";
import type { DevEvent, DevEventInput, DevEventQuery } from "./types.ts";

/** Ring-buffer capacity. Roughly a few MB of events at typical sizes. */
const DEFAULT_CAPACITY = 2000;

/** How often buffered lines are written through to disk. */
const FLUSH_INTERVAL_MS = 200;

/** Lines held before a flush is forced regardless of the timer. */
const MAX_PENDING_LINES = 256;

export type DevEventListener = (event: DevEvent) => void;

/** Render an event as a JSONL line, replacing `data` in place when it cannot be
 *  encoded. Mutation is deliberate: the stored record and the written line must agree. */
function encode(event: DevEvent): string {
  try {
    return `${JSON.stringify(event)}\n`;
  } catch {
    event.data = { unserializable: true };
    try {
      return `${JSON.stringify(event)}\n`;
    } catch {
      // Only reachable if a top-level field is itself hostile; keep the envelope.
      return `${JSON.stringify({ seq: event.seq, ts: event.ts, src: event.src, level: event.level, type: event.type, msg: "" })}\n`;
    }
  }
}

/** Bounded event store. Exported as a class so tests can exercise eviction
 *  without touching disk; `sink` below is the process instance. */
export class DevEventSink {
  #capacity: number;
  /** Circular buffer; `#count` entries starting at `#start`. */
  #ring: (DevEvent | undefined)[];
  #start = 0;
  #count = 0;
  #seq = 0;
  #dropped = 0;

  #listeners = new Set<DevEventListener>();

  #filePath?: string;
  #pending: string[] = [];
  #timer?: ReturnType<typeof setInterval>;
  /** Set once a write fails, so a broken file doesn't retry on every event. */
  #fileBroken = false;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.#capacity = Math.max(1, capacity);
    this.#ring = new Array<DevEvent | undefined>(this.#capacity);
  }

  /** Highest assigned sequence number; `0` before the first event. */
  get lastSeq(): number {
    return this.#seq;
  }

  /** Events evicted from the ring buffer since process start. */
  get dropped(): number {
    return this.#dropped;
  }

  get filePath(): string | undefined {
    return this.#filePath;
  }

  /** Resize the ring, preserving the newest events that still fit. */
  resize(capacity: number): void {
    const next = Math.max(1, capacity);
    if (next === this.#capacity) return;
    const kept = this.snapshot().slice(-next);
    this.#capacity = next;
    this.#ring = new Array<DevEvent | undefined>(next);
    this.#start = 0;
    this.#count = kept.length;
    for (let i = 0; i < kept.length; i++) this.#ring[i] = kept[i];
  }

  /**
   * Mirror events to `path` as JSONL and flush the current backlog. Failures
   * here (unwritable dir, read-only volume) leave the sink memory-only.
   */
  openFile(path: string): void {
    if (this.#filePath === path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      this.#fileBroken = true;
      return;
    }
    this.#filePath = path;
    this.#fileBroken = false;
    // Backfill the buffer's backlog so the file records the whole session.
    this.#pending = this.snapshot().map(encode);
    this.#startTimer();
    this.flush();
  }

  /** Publish an event. Returns the stamped record. */
  emit(input: DevEventInput): DevEvent {
    const event: DevEvent = {
      seq: ++this.#seq,
      ts: Date.now(),
      src: input.src,
      level: input.level,
      type: input.type,
      msg: input.msg,
      ...(input.window !== undefined ? { window: input.window } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    };

    // Serialize once, here, so an unencodable `data` (circular reference, BigInt)
    // is caught at the source instead of failing every later `/logs` response.
    const line = encode(event);

    this.#push(event);

    if (this.#filePath !== undefined && !this.#fileBroken) {
      this.#pending.push(line);
      if (this.#pending.length >= MAX_PENDING_LINES) this.flush();
    }

    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A failing subscriber (a closed SSE socket, say) must not stall the producer.
      }
    }

    return event;
  }

  /** Every buffered event, oldest first. */
  snapshot(): DevEvent[] {
    const out: DevEvent[] = [];
    for (let i = 0; i < this.#count; i++) {
      const event = this.#ring[(this.#start + i) % this.#capacity];
      if (event !== undefined) out.push(event);
    }
    return out;
  }

  /** Buffered events matching `query`, oldest first. */
  read(query: DevEventQuery): DevEvent[] {
    return selectEvents(this.snapshot(), query);
  }

  /** Subscribe to future events. Returns an unsubscribe function. */
  subscribe(listener: DevEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Write buffered lines through to disk. Safe to call when there is nothing to do. */
  flush(): void {
    if (this.#pending.length === 0) return;
    const path = this.#filePath;
    if (path === undefined || this.#fileBroken) {
      this.#pending = [];
      return;
    }
    const batch = this.#pending.join("");
    this.#pending = [];
    try {
      appendFileSync(path, batch);
    } catch {
      // Give up on the file for the session rather than retrying on every event.
      this.#fileBroken = true;
    }
  }

  /** Stop the flush timer after a final flush. Called on Worker shutdown. */
  close(): void {
    this.flush();
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #push(event: DevEvent): void {
    if (this.#count < this.#capacity) {
      this.#ring[(this.#start + this.#count) % this.#capacity] = event;
      this.#count++;
      return;
    }
    // Full: overwrite the oldest slot and advance the window.
    this.#ring[this.#start] = event;
    this.#start = (this.#start + 1) % this.#capacity;
    this.#dropped++;
  }

  #startTimer(): void {
    if (this.#timer !== undefined) return;
    const timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    // Never hold the Worker's event loop open just to flush diagnostics.
    timer.unref?.();
    this.#timer = timer;
  }
}

/** The process-wide sink. Taps write here; the inspector reads from it. */
export const sink = new DevEventSink();

/** Publish an event to the process sink. Total — callers never need a try/catch. */
export function record(input: DevEventInput): void {
  try {
    sink.emit(input);
  } catch {
    // A tap must never propagate a failure into the code path it observes.
  }
}
