/**
 * A scroll view's offset, read and written by the app, in a real window.
 *
 *   bun bench/scroll-check.tsx <host>
 *
 * Two listings side by side, as a file browser has them: 40 rows in a
 * scroll view, and 400 in one long enough for the host to virtualize. For
 * each it checks, against where the host says the rows are painted
 * (`layout`):
 *
 * - a scroll the app did not make (the simulated wheel) reaches `onScroll`;
 * - `scrollTo` puts the view where it says, kept in its range, and
 *   `scrollToEnd` at its end;
 * - a row's `scrollIntoView` shows it whole by the least scroll, below and
 *   above what shows, and one far down a long list in one go;
 * - the offset is where the content is: a row is painted at the view's top,
 *   less the offset, plus its place in the content. That is what an area
 *   selection anchored to the content needs (Dashi's Files);
 * - rows whose props change (a selection) between and with the scrolls move
 *   nothing: a long list that forgot a changed row's height once told 0
 *   after Select All at 1200, and landed at 722 when sent to 98;
 * - a view scrolled in an effect of the commit that mounts it opens there
 *   (a calendar's hours at the morning): in the app's first commit, in a
 *   subtree mounted later, a long list, a row asked into view, and on a
 *   host kept warm, asked before its window is opened.
 *
 * Exits non-zero on any difference. A host from before it (no
 * `"scroll":true` in its `protocol` line) fails every step.
 *
 * `bench/gates.ts` in `@mirinjs/metal-ui` runs it with the layout checks.
 * Needs a Wayland compositor that presents:
 * `dashi-comp --backend winit --no-xwayland -c "bun bench/scroll-check.tsx <host>"`
 * with a `DASHI_COMP_SOCKET` of its own.
 */

import { createRef, type RefObject, useLayoutEffect, useState } from "react";
import {
  type LayoutNode,
  type NativeEvent,
  type NativeHostTransport,
  type NativeRoot,
  render,
  type ScrollInfo,
  ScrollView,
  spawnNativeHost,
  View,
  type ViewHandle,
} from "../src/index.ts";

const [binary] = Bun.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (!binary) {
  console.error("usage: bun bench/scroll-check.tsx <host>");
  process.exit(2);
}

const ROW = 30;
const VIEW = 240;

interface Listing {
  name: string;
  rows: number;
  view: RefObject<ViewHandle | null>;
  row: RefObject<ViewHandle | null>[];
  /** What `onScroll` last said, and how often it spoke. */
  at: ScrollInfo | null;
  told: number;
  /** Select rows `from` up to `to`: their props change, as a file list's do. */
  select: (from: number, to: number) => void;
  /** What it does in an effect of the commit that mounts it. */
  atMount?: (of: Listing) => void;
}

function listing(name: string, rows: number, atMount?: (of: Listing) => void): Listing {
  const row = Array.from({ length: rows }, () => createRef<ViewHandle>());
  const view = createRef<ViewHandle>();
  return { name, rows, view, row, at: null, told: 0, select: () => {}, atMount };
}

/** Scroll to row `index` as the listing mounts. */
const toRow = (index: number) => (of: Listing) => of.view.current?.scrollTo({ y: index * ROW });

const listings = [listing("short", 40), listing("long", 400)];
/** In the app's first commit, each scrolled in an effect of it. */
const first = [listing("first", 40, toRow(5)), listing("first-long", 400, toRow(105))];
/** In a subtree mounted later, each scrolled (or a row asked into view) in an effect of that commit. */
const late = [
  listing("late", 40, toRow(7)),
  listing("late-long", 400, toRow(107)),
  listing("late-into", 400, (of) => of.row[300]?.current?.scrollIntoView()),
];
/** On a host kept warm, scrolled before its window is opened. */
const warm = [listing("warm", 40, toRow(9)), listing("warm-long", 400, toRow(109))];

function Rows({ of }: { of: Listing }) {
  const [lit, setLit] = useState<[number, number]>([0, 0]);
  of.select = (from, to) => setLit([from, to]);
  // Once, as it mounts, in the tick of the commit: the line that scrolls it
  // goes out right behind the patch that brings it, so the host has both
  // before it has drawn the view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the listing is the same object for good
  useLayoutEffect(() => of.atMount?.(of), []);
  const color = (index: number): string => {
    if (index >= lit[0] && index < lit[1]) return "#1e3a8a";
    return index % 2 ? "#3f3f46" : "#52525b";
  };
  return (
    <ScrollView
      ref={of.view}
      testID={of.name}
      onScroll={(event) => {
        of.at = event;
        of.told += 1;
      }}
      style={{ width: 200, height: VIEW, backgroundColor: "#27272a" }}
    >
      {of.row.map((ref, index) => (
        <View
          // The rows never move: their index is their key.
          key={index}
          ref={ref}
          testID={`${of.name}:${index}`}
          style={{ height: ROW, flexShrink: 0, backgroundColor: color(index) }}
        />
      ))}
    </ScrollView>
  );
}

let gone = false;
/** The check is closing its host itself. */
let closing = false;
let scrolls = false;
const settles: Array<() => void> = [];
const layouts: Array<(nodes: LayoutNode[]) => void> = [];
const WINDOW = { title: "scroll check", width: 1580, height: 300 };

/** A host under a check, its answers to `settle` and `layout` heard. */
function host(deferred: boolean): NativeHostTransport {
  const spawned = spawnNativeHost(binary as string, {
    ...WINDOW,
    deferred,
    env: { MIRIN_METAL_CHECK: "1" },
  });
  spawned.onClose(() => {
    // Its own doing when the check closes it; anything else is the host leaving.
    if (!closing) gone = true;
  });
  spawned.onEvent((event: NativeEvent) => {
    if (event.type === "protocol") scrolls = event.scroll === true;
    if (event.type === "settled") settles.shift()?.();
    if (event.type === "layout") layouts.shift()?.(event.nodes);
  });
  return spawned;
}

/** Mounts the `late` listings when asked. */
let showLate = (): void => {};

function App({ of }: { of: Listing[] }) {
  const [shown, setShown] = useState(false);
  showLate = () => setShown(true);
  return (
    <View
      style={{ flex: 1, flexDirection: "row", padding: 20, gap: 20, backgroundColor: "#18181b" }}
    >
      {of.map((each) => (
        <Rows key={each.name} of={each} />
      ))}
      {shown ? (
        <View style={{ flexDirection: "row", gap: 20 }}>
          {late.map((each) => (
            <Rows key={each.name} of={each} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

let transport = host(false);
let root: NativeRoot = render(<App of={[...listings, ...first]} />, transport);

async function settled(): Promise<void> {
  for (let round = 0; round < 3 && !gone; round += 1) {
    const answer = new Promise<void>((resolve) => settles.push(resolve));
    transport.simulate({ kind: "settle" });
    await Promise.race([answer, Bun.sleep(30_000)]);
    await Bun.sleep(0);
  }
}

/** Where the host painted the nodes with these `testID`s (null: not painted). */
async function painted(testIDs: string[]): Promise<(LayoutNode | null)[]> {
  const answer = new Promise<LayoutNode[]>((resolve) => layouts.push(resolve));
  transport.simulate({ kind: "layout" });
  const nodes = await Promise.race([answer, Bun.sleep(30_000).then(() => [] as LayoutNode[])]);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return testIDs.map((testID) => byId.get(root.nodeId(testID) ?? "") ?? null);
}

const failures: string[] = [];
function expect(what: string, got: unknown, wanted: unknown): void {
  if (JSON.stringify(got) !== JSON.stringify(wanted)) {
    failures.push(`${what}: ${JSON.stringify(got)}, wanted ${JSON.stringify(wanted)}`);
  }
}

/** The offset `onScroll` last said, and where row `index` is painted from the view's top. */
async function standing(
  of: Listing,
  index: number,
): Promise<{ y: number | null; row: number | null }> {
  await settled();
  const [view, row] = await painted([of.name, `${of.name}:${index}`]);
  return { y: of.at?.contentOffset.y ?? null, row: view && row ? row.y - view.y : null };
}

async function check(of: Listing): Promise<void> {
  const end = of.rows * ROW - VIEW;
  const name = of.name;
  // The wheel: the app hears of a scroll it did not make.
  transport.simulate({ kind: "scroll", id: root.nodeId(name) ?? "", dy: 45 });
  expect(`${name}: wheel`, await standing(of, 2), { y: 45, row: 2 * ROW - 45 });
  // To an offset, and the content is there: row 10 at the view's top.
  of.view.current?.scrollTo({ y: 10 * ROW });
  expect(`${name}: scrollTo`, await standing(of, 10), { y: 10 * ROW, row: 0 });
  expect(`${name}: content size`, of.at?.contentSize.height, of.rows * ROW);
  expect(`${name}: view size`, of.at?.layoutMeasurement.height, VIEW);
  // A row below what shows comes to the bottom edge; one that shows moves nothing.
  of.row[25]?.current?.scrollIntoView();
  expect(`${name}: into view, below`, await standing(of, 25), {
    y: 26 * ROW - VIEW,
    row: VIEW - ROW,
  });
  const before = of.told;
  of.row[22]?.current?.scrollIntoView();
  await settled();
  expect(`${name}: into view, shown`, of.told, before);
  // One above comes to the top edge.
  of.row[3]?.current?.scrollIntoView();
  expect(`${name}: into view, above`, await standing(of, 3), { y: 3 * ROW, row: 0 });
  // The last row, far down a long list: in one go, and the view is at its end.
  const last = of.rows - 1;
  of.row[last]?.current?.scrollIntoView();
  expect(`${name}: into view, last`, await standing(of, last), { y: end, row: VIEW - ROW });
  // Past the end and before the start: kept in range.
  of.view.current?.scrollTo({ y: 0 });
  expect(`${name}: scrollTo start`, await standing(of, 0), { y: 0, row: 0 });
  of.view.current?.scrollToEnd();
  expect(`${name}: scrollToEnd`, await standing(of, last), { y: end, row: VIEW - ROW });
  // An area selection's anchor: a row in the middle is where the offset says.
  of.view.current?.scrollTo({ y: 500.5 });
  const middle = await standing(of, 20);
  expect(`${name}: offset between pixels`, middle.y, 500.5);
  // Painted on whole device pixels, so within one of where the offset says.
  const off = Math.abs((middle.row ?? Number.NaN) - (20 * ROW - 500.5));
  expect(`${name}: content at the offset`, off <= 1, true);
  // A selection changes rows' props, as a file list's does on every click.
  // Every row at once (Select All): the view stays where it is and says nothing.
  of.view.current?.scrollTo({ y: 20 * ROW });
  expect(`${name}: before a selection`, await standing(of, 20), { y: 20 * ROW, row: 0 });
  const quiet = of.told;
  of.select(0, of.rows);
  expect(`${name}: every row changed`, await standing(of, 20), { y: 20 * ROW, row: 0 });
  expect(`${name}: every row changed, nothing told`, of.told, quiet);
  // Rows above and in the view change in the turn of a scroll (a marquee's step at the edge).
  of.select(3, 27);
  of.view.current?.scrollTo({ y: 20 * ROW + 7 });
  expect(`${name}: rows changed with a scrollTo`, await standing(of, 21), {
    y: 20 * ROW + 7,
    row: ROW - 7,
  });
  // And before a scroll the app did not make.
  of.select(10, 35);
  await settled();
  transport.simulate({ kind: "scroll", id: root.nodeId(name) ?? "", dy: 53 });
  expect(`${name}: rows changed before a wheel`, await standing(of, 22), {
    y: 22 * ROW,
    row: 0,
  });
  expect(`${name}: content size after`, of.at?.contentSize.height, of.rows * ROW);
}

/** The listing stands at row `index`, scrolled there as it mounted. */
async function opened(of: Listing, index: number, row = 0): Promise<void> {
  expect(`${of.name}: scrolled as it mounted`, await standing(of, index), { y: index * ROW, row });
}

await settled();
// Scrolled in an effect of the app's first commit: the window opens there.
await opened(first[0] as Listing, 5);
await opened(first[1] as Listing, 105);
for (const each of listings) if (!gone) await check(each);
// A subtree mounted later, its views scrolled in an effect of that commit.
showLate();
// The commit and its effects go before the check asks the host anything
// (a `settle` between them would draw the views first).
await Bun.sleep(100);
await opened(late[0] as Listing, 7);
await opened(late[1] as Listing, 107);
// Row 300 came from below: it is at the view's bottom edge.
const into = late[2] as Listing;
expect(`${into.name}: a row asked into view as it mounted`, await standing(into, 300), {
  y: 301 * ROW - VIEW,
  row: VIEW - ROW,
});
closing = true;
root.unmount();

// A host kept warm: the views are scrolled as they mount, and the window
// is opened after. It opens scrolled.
if (!gone) {
  // The first host's end is heard before the next one is listened to.
  await Bun.sleep(200);
  closing = false;
  transport = host(true);
  root = render(<App of={warm} />, transport);
  // The first commit goes once the host has said its word, and its effects with it.
  await Bun.sleep(400);
  transport.open(WINDOW);
  await opened(warm[0] as Listing, 9);
  await opened(warm[1] as Listing, 109);
  closing = true;
  root.unmount();
}

for (const failure of failures) console.log(failure);
console.log(
  `scroll-check: ${failures.length} wrong${scrolls ? "" : "; the host says no scroll"}${gone ? "; the host went away" : ""}`,
);
process.exit(failures.length === 0 && !gone ? 0 : 1);
