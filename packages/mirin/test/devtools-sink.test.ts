import { describe, expect, test } from "bun:test";
import { DevEventSink } from "../src/devtools/sink.ts";
import type { DevEventInput } from "../src/devtools/types.ts";

const line = (n: number): DevEventInput => ({
  src: "main",
  level: "info",
  type: "log",
  msg: `line ${n}`,
});

describe("devtools sink buffering", () => {
  test("stamps a monotonic sequence starting at 1", () => {
    const sink = new DevEventSink(10);
    expect(sink.emit(line(1)).seq).toBe(1);
    expect(sink.emit(line(2)).seq).toBe(2);
    expect(sink.lastSeq).toBe(2);
  });

  test("evicts oldest first once full, and counts the loss", () => {
    const sink = new DevEventSink(3);
    for (let i = 1; i <= 5; i++) sink.emit(line(i));
    expect(sink.snapshot().map((e) => e.msg)).toEqual(["line 3", "line 4", "line 5"]);
    expect(sink.dropped).toBe(2);
    // Sequence numbers keep counting past eviction, so a cursor stays valid.
    expect(sink.lastSeq).toBe(5);
  });

  test("omits optional fields rather than storing undefined", () => {
    const sink = new DevEventSink(2);
    const event = sink.emit(line(1));
    expect("window" in event).toBe(false);
    expect("data" in event).toBe(false);
  });

  test("keeps window and data when supplied", () => {
    const sink = new DevEventSink(2);
    const event = sink.emit({ ...line(1), window: 4, data: { ok: true } });
    expect(event.window).toBe(4);
    expect(event.data).toEqual({ ok: true });
  });

  test("resize keeps the newest events that still fit", () => {
    const sink = new DevEventSink(5);
    for (let i = 1; i <= 5; i++) sink.emit(line(i));
    sink.resize(2);
    expect(sink.snapshot().map((e) => e.msg)).toEqual(["line 4", "line 5"]);
  });

  test("resize upward preserves everything and keeps accepting", () => {
    const sink = new DevEventSink(2);
    sink.emit(line(1));
    sink.emit(line(2));
    sink.resize(4);
    sink.emit(line(3));
    expect(sink.snapshot().map((e) => e.msg)).toEqual(["line 1", "line 2", "line 3"]);
  });
});

describe("devtools sink subscribers", () => {
  test("delivers to subscribers and stops after unsubscribe", () => {
    const sink = new DevEventSink(4);
    const seen: number[] = [];
    const off = sink.subscribe((event) => seen.push(event.seq));
    sink.emit(line(1));
    off();
    sink.emit(line(2));
    expect(seen).toEqual([1]);
  });

  test("a throwing subscriber cannot break the producer or its peers", () => {
    const sink = new DevEventSink(4);
    const seen: number[] = [];
    sink.subscribe(() => {
      throw new Error("closed socket");
    });
    sink.subscribe((event) => seen.push(event.seq));
    expect(() => sink.emit(line(1))).not.toThrow();
    expect(seen).toEqual([1]);
  });
});

describe("devtools sink file handling", () => {
  test("an unwritable path degrades to memory-only instead of throwing", () => {
    const sink = new DevEventSink(4);
    // A path whose parent is a file, not a directory: mkdir must fail.
    sink.openFile("/dev/null/nope/events.jsonl");
    expect(() => sink.emit(line(1))).not.toThrow();
    expect(sink.snapshot()).toHaveLength(1);
    expect(sink.filePath).toBeUndefined();
  });

  test("reads back what it wrote, including events buffered before the file opened", async () => {
    const dir = `${import.meta.dir}/../../../.mirin-test/${crypto.randomUUID()}`;
    const path = `${dir}/events.jsonl`;
    const sink = new DevEventSink(8);
    sink.emit(line(1)); // before openFile — must still be persisted
    sink.openFile(path);
    sink.emit(line(2));
    sink.close();

    const text = await Bun.file(path).text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}").msg).toBe("line 1");
    expect(JSON.parse(lines[1] ?? "{}").msg).toBe("line 2");

    await Bun.$`rm -rf ${dir}`.quiet();
  });
});
