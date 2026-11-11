/**
 * What the patch protocol costs the driver: a keyed list of rows on a
 * stand-in host (`lib/standin.ts`: no process, no compositor), changed the
 * ways an app changes one, each timed from the event to the patch sent.
 * The rows are memoized, so React re-renders only what an operation touched
 * and the rest is the host config's mutations, the commit log, the tree
 * sync and serialization.
 *
 *   bun bench/driver.tsx [--rows=2500] [--runs=5] [--scale] [--profile] [--json]
 *   bun bench/driver.tsx --record=<file> [--rows=300]
 *
 * `--scale` repeats every operation at a quarter, a half, the whole and
 * twice the rows and prints how each grows: an operation on k rows should
 * cost about k times one, however long the list is.
 * `--record` writes every line sent while each operation runs once: two
 * builds of the driver that write the same file send a host the same bytes.
 * `packages/mirin-metal-ui/bench/driver.tsx` times a whole app's driver.
 */

import { memo, useState } from "react";
import { render, Text, View } from "../src/index.ts";
import { attribute, attributionTable, profiled } from "./lib/profile.ts";
import { type StandIn, standIn } from "./lib/standin.ts";

const args = Bun.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const ROWS = Number(flag("rows") ?? 2500);
const RUNS = Number(flag("runs") ?? 5);

interface Item {
  id: number;
  label: string;
}

const ROW_STYLE = { flexDirection: "row", padding: 6, gap: 8 } as const;
const LABEL_STYLE = { fontSize: 13, color: "#e4e4e7" } as const;

const Row = memo(function Row({ item }: { item: Item }) {
  return (
    <View style={ROW_STYLE}>
      <Text style={LABEL_STYLE}>{item.label}</Text>
    </View>
  );
});

type Change = (items: Item[]) => Item[];
/** The next press applies this change (a press renders before it returns). */
let pending: Change | null = null;

function List({ initial }: { initial: Item[] }) {
  const [items, setItems] = useState(initial);
  return (
    <View style={{ flex: 1, flexDirection: "column" }}>
      <View
        testID="apply"
        onPress={() => {
          const change = pending;
          pending = null;
          if (change) setItems(change);
        }}
      />
      <View testID="list" style={{ flex: 1, flexDirection: "column", overflow: "scroll" }}>
        {items.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </View>
    </View>
  );
}

let nextId = 1;
const make = (count: number): Item[] =>
  Array.from({ length: count }, () => {
    const id = nextId++;
    return { id, label: `row ${id}` };
  });

/** A deterministic shuffle (the same order every run). */
function shuffled(items: Item[]): Item[] {
  const out = [...items];
  let seed = 12345;
  for (let index = out.length - 1; index > 0; index -= 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const other = seed % (index + 1);
    const held = out[index] as Item;
    out[index] = out[other] as Item;
    out[other] = held;
  }
  return out;
}

interface Operation {
  name: string;
  /** Rows the operation touches, for the per-row cost. */
  touched: (rows: number) => number;
  change: (rows: number) => Change;
  /** Put the list back to `rows` rows in a fresh order-independent state. */
  restore?: (rows: number) => Change;
}

const reset =
  (rows: number): Change =>
  () =>
    make(rows);

const OPERATIONS: Operation[] = [
  { name: "append one row", touched: () => 1, change: () => (items) => [...items, ...make(1)] },
  {
    name: "insert one row first",
    touched: () => 1,
    change: () => (items) => [...make(1), ...items],
  },
  {
    name: "insert one row in the middle",
    touched: () => 1,
    change: () => (items) => {
      const at = items.length >> 1;
      return [...items.slice(0, at), ...make(1), ...items.slice(at)];
    },
  },
  { name: "remove the first row", touched: () => 1, change: () => (items) => items.slice(1) },
  {
    name: "remove a middle row",
    touched: () => 1,
    change: () => (items) => items.filter((_, index) => index !== items.length >> 1),
  },
  {
    name: "change one row's text",
    touched: () => 1,
    change: () => (items) =>
      items.map((item, index) =>
        index === items.length >> 1 ? { ...item, label: `${item.label}!` } : item,
      ),
  },
  {
    name: "swap two rows",
    touched: () => 2,
    change: () => (items) => {
      const out = [...items];
      const [a, b] = [10, items.length - 10];
      [out[a], out[b]] = [out[b] as Item, out[a] as Item];
      return out;
    },
  },
  {
    name: "move the first row last",
    touched: () => 1,
    change: () => (items) => [...items.slice(1), items[0] as Item],
  },
  {
    name: "append as many rows again",
    touched: (rows) => rows,
    change: (rows) => (items) => [...items, ...make(rows)],
    restore: reset,
  },
  {
    name: "prepend as many rows again",
    touched: (rows) => rows,
    change: (rows) => (items) => [...make(rows), ...items],
    restore: reset,
  },
  {
    name: "remove every other row",
    touched: (rows) => rows >> 1,
    change: () => (items) => items.filter((_, index) => index % 2 === 0),
    restore: reset,
  },
  {
    name: "remove every row",
    touched: (rows) => rows,
    change: () => () => [],
    restore: reset,
  },
  {
    name: "replace every row",
    touched: (rows) => rows,
    change: (rows) => () => make(rows),
  },
  {
    name: "reverse the rows",
    touched: (rows) => rows,
    change: () => (items) => [...items].reverse(),
  },
  {
    name: "shuffle the rows",
    touched: (rows) => rows,
    change: () => (items) => shuffled(items),
  },
  {
    name: "change every row's text",
    touched: (rows) => rows,
    change: () => (items) => items.map((item) => ({ ...item, label: `${item.label}.` })),
    restore: reset,
  },
];

interface Mounted {
  host: StandIn;
  apply(change: Change): { ms: number; bytes: number };
  unmount(): void;
}

async function mount(
  rows: number,
  keep = false,
): Promise<Mounted & { mountMs: number; treeBytes: number }> {
  const host = standIn({ keep });
  const from = Bun.nanoseconds();
  const root = render(<List initial={make(rows)} />, host.transport);
  while (host.sends === 0) await Bun.sleep(1);
  const mountMs = (host.lastSendAt - from) / 1e6;
  const id = root.nodeId("apply");
  if (!id) throw new Error("no apply view");
  return {
    host,
    mountMs,
    treeBytes: host.bytes,
    apply(change) {
      pending = change;
      const bytes = host.bytes;
      const sends = host.sends;
      const start = Bun.nanoseconds();
      host.emit({ type: "press", nodeId: id });
      if (host.sends === sends) throw new Error("the change sent nothing");
      return { ms: (host.lastSendAt - start) / 1e6, bytes: host.bytes - bytes };
    },
    unmount: () => root.unmount(),
  };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

interface Result {
  name: string;
  ms: number;
  kb: number;
  usPerRow: number;
}

async function measure(
  rows: number,
  runs: number,
): Promise<{ mountMs: number; results: Result[] }> {
  const list = await mount(rows);
  const results: Result[] = [];
  for (const operation of OPERATIONS) {
    const samples: Array<{ ms: number; bytes: number }> = [];
    // The first is a warm-up: the code past its first tiers.
    for (let run = 0; run <= runs; run += 1) {
      const sample = list.apply(operation.change(rows));
      if (run > 0) samples.push(sample);
      if (operation.restore) list.apply(operation.restore(rows));
    }
    // Back to `rows` rows for the next operation (single-row operations drift by one a run).
    list.apply(reset(rows));
    const ms = median(samples.map((sample) => sample.ms));
    results.push({
      name: operation.name,
      ms,
      kb: median(samples.map((sample) => sample.bytes)) / 1024,
      usPerRow: (ms * 1000) / operation.touched(rows),
    });
  }
  list.unmount();
  return { mountMs: list.mountMs, results };
}

const recordPath = flag("record");
if (recordPath) {
  const rows = Number(flag("rows") ?? 300);
  const list = await mount(rows, true);
  for (const operation of OPERATIONS) {
    list.apply(operation.change(rows));
    list.apply((operation.restore ?? reset)(rows));
  }
  await Bun.write(recordPath, `${list.host.lines.join("\n")}\n`);
  const digest = new Bun.CryptoHasher("sha256").update(list.host.lines.join("\n")).digest("hex");
  console.log(`${list.host.lines.length} lines, ${list.host.bytes} bytes, sha256 ${digest}`);
  list.unmount();
} else if (args.includes("--scale")) {
  const sizes = [ROWS >> 2, ROWS >> 1, ROWS, ROWS * 2];
  const runs: Result[][] = [];
  for (const size of sizes) runs.push((await measure(size, RUNS)).results);
  console.log(`ms per operation at ${sizes.join(", ")} rows, and µs per row touched`);
  OPERATIONS.forEach((operation, index) => {
    const row = runs.map((results) => results[index] as Result);
    console.log(
      `${operation.name.padEnd(30)} ${row.map((r) => r.ms.toFixed(2).padStart(8)).join("")}   | ${row
        .map((r) => r.usPerRow.toFixed(1).padStart(8))
        .join("")}`,
    );
  });
} else {
  const { mountMs, results } = await measure(ROWS, RUNS);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ rows: ROWS, mountMs, results }));
  } else {
    console.log(
      `${ROWS} rows (three nodes each), medians of ${RUNS}; first tree sent in ${mountMs.toFixed(1)} ms`,
    );
    console.log(`${"".padEnd(30)} ${"ms".padStart(8)} ${"KB".padStart(9)} ${"µs/row".padStart(9)}`);
    for (const result of results) {
      console.log(
        `${result.name.padEnd(30)} ${result.ms.toFixed(2).padStart(8)} ${result.kb.toFixed(1).padStart(9)} ${result.usPerRow.toFixed(1).padStart(9)}`,
      );
    }
  }
  if (args.includes("--profile")) {
    const list = await mount(ROWS);
    for (const name of ["append as many rows again", "swap two rows", "reverse the rows"]) {
      const operation = OPERATIONS.find((each) => each.name === name);
      if (!operation) continue;
      const { profile } = await profiled(() => {
        for (let run = 0; run < RUNS; run += 1) {
          list.apply(operation.change(ROWS));
          list.apply(reset(ROWS));
        }
      });
      console.log(`${name} (and the list put back), main thread:`);
      console.log(attributionTable(attribute(profile), RUNS, "ms per round"));
    }
    list.unmount();
  }
}
process.exit(0);
