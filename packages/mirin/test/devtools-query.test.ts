import { describe, expect, test } from "bun:test";
import { matches, parseQuery, selectEvents } from "../src/devtools/lib/query.ts";
import type { DevEvent, DevEventInput } from "../src/devtools/types.ts";

function event(seq: number, over: Partial<DevEvent> = {}): DevEvent {
  return {
    seq,
    ts: 1_000 + seq,
    src: "main",
    level: "info",
    type: "log",
    msg: `event ${seq}`,
    ...over,
  };
}

const query = (search: string) => parseQuery(new URLSearchParams(search));

describe("devtools log query parsing", () => {
  test("reads every supported filter", () => {
    expect(query("since=12&level=warn&src=rpc&window=3&type=rpc.&contains=boom&limit=5")).toEqual({
      since: 12,
      level: "warn",
      src: ["rpc"],
      window: [3],
      type: ["rpc."],
      contains: "boom",
      limit: 5,
    });
  });

  test("accepts comma-separated and repeated params alike", () => {
    expect(query("src=rpc,native&window=1&window=2").src).toEqual(["rpc", "native"]);
    expect(query("src=rpc,native&window=1&window=2").window).toEqual([1, 2]);
  });

  test("drops unknown sources and levels instead of failing the request", () => {
    // An agent guessing "verbose" or "worker" should still get logs back.
    expect(query("level=verbose").level).toBeUndefined();
    expect(query("src=worker").src).toBeUndefined();
    expect(query("since=-4").since).toBeUndefined();
    expect(query("since=abc").since).toBeUndefined();
  });

  test("always resolves a bounded limit", () => {
    expect(query("").limit).toBe(200);
    expect(query("limit=999999").limit).toBe(5000);
  });
});

describe("devtools log matching", () => {
  test("since is exclusive, so a cursor never re-reads its last event", () => {
    expect(matches(event(5), { since: 5 })).toBe(false);
    expect(matches(event(6), { since: 5 })).toBe(true);
  });

  test("level filters by severity, not equality", () => {
    expect(matches(event(1, { level: "error" }), { level: "warn" })).toBe(true);
    expect(matches(event(1, { level: "debug" }), { level: "warn" })).toBe(false);
  });

  test("type matches on prefix so a family can be selected at once", () => {
    expect(matches(event(1, { type: "rpc.response" }), { type: ["rpc."] })).toBe(true);
    expect(matches(event(1, { type: "window.created" }), { type: ["rpc."] })).toBe(false);
  });

  test("window filter excludes events that belong to no window", () => {
    expect(matches(event(1, { window: 2 }), { window: [2] })).toBe(true);
    expect(matches(event(1), { window: [2] })).toBe(false);
  });

  test("contains is case-insensitive", () => {
    expect(matches(event(1, { msg: "Boom Happened" }), { contains: "boom" })).toBe(true);
  });
});

describe("devtools log selection", () => {
  const events = Array.from({ length: 10 }, (_, i) => event(i + 1));

  test("keeps the newest matches but returns them oldest-first", () => {
    expect(selectEvents(events, { limit: 3 }).map((e) => e.seq)).toEqual([8, 9, 10]);
  });

  test("applies filters before the limit", () => {
    const mixed = [event(1, { level: "error" }), event(2), event(3, { level: "error" }), event(4)];
    expect(selectEvents(mixed, { level: "error", limit: 1 }).map((e) => e.seq)).toEqual([3]);
  });

  test("an empty buffer is not an error", () => {
    expect(selectEvents([], {})).toEqual([]);
  });
});

// Compile-time guard: the input shape must stay assignable to the stored shape
// minus the fields the sink stamps. If these drift, taps stop type-checking.
describe("devtools event envelope", () => {
  test("an input plus seq/ts is a complete event", () => {
    const input: DevEventInput = { src: "app", level: "info", type: "t", msg: "m" };
    const stamped: DevEvent = { seq: 1, ts: 2, ...input };
    expect(stamped.seq).toBe(1);
  });
});
