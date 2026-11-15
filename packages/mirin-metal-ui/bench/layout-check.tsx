/**
 * Layout equivalence between two hosts: drives the same app through the
 * same steps on each and compares every id'd node's painted bounds (the
 * simulation channel's `layout` query) after every step. For checking that
 * a renderer change (retained subtrees, a fork patch) lays out exactly what
 * the host before it did.
 *
 *   bun bench/layout-check.tsx <app> <host-a> <host-b> [--visible] [--scene]
 *     [--env-a=NAME=value] [--env-b=NAME=value]
 *
 * `app` is `browser` (the example browser, ~900 nodes), `grid` (a 40×25
 * card grid like `@mirinjs/metal`'s stress bench) or `scroll` (the grid in a
 * scroll view under a banner, scrolled, with clicks and pointer moves by
 * window coordinates: the node pressed or hovered is compared too). Exits
 * non-zero on any difference. Runs in an off-screen compositor unless
 * `--visible`.
 *
 * `across` is the cards in columns in a view that scrolls across
 * (`overflow: "scroll-x"`), under a centered and a right-aligned caption
 * each, scrolled across by whole and half pixels, with a strip before them
 * that widens, and presses and pointer moves by window coordinates. It
 * scrolls with the simulation's `dx`, which hosts before round 4 lack, so
 * it is for comparing a host with itself (`--env-b=MIRIN_METAL_RETAIN=0`)
 * or with one built with that alone.
 *
 * `scroll-fractional` is the `scroll` app scrolled by fractions of a pixel
 * (a touchpad's steps, small ones that add up, the ends). A scroll view
 * paints its content at whole device pixels (`MIRIN_METAL_SCROLL_SNAP`),
 * which a host from before that does not, so it is for comparing one host
 * with itself: `--scene --env-b=MIRIN_METAL_RETAIN=0`, and at another scale
 * factor with `--env-a=MIRIN_METAL_SCALE=1.5 --env-b=MIRIN_METAL_SCALE=1.5`.
 * A host from round 3 needs `--bounds-digits=3` there (bounds compared to
 * that many decimals): its layout map moved a copied subtree's nodes by a
 * logical distance, which at a scale factor that is not a power of two
 * differs from laying them out there in the last digits a float holds.
 * Since round 4 it moves them on the device grid, and they are the same
 * to the bit.
 *
 * `--scene` also compares what each host drew after every step: a digest of
 * the frame's primitives and hitboxes, which a host traces with
 * `MIRIN_METAL_TRACE_SCENE=1` (hosts from before that have none): of the
 * frame the step settled into (`(drew)`), and from a host that settles of
 * every frame it drew on the way there, in order (`(frames)`: the frame
 * with the step in it, the driver's answer, an animation's). With
 * `--env-b=MIRIN_METAL_RETAIN=0` and the same host twice, that checks
 * retained subtrees draw what drawing everything does; add
 * `--env-a=MIRIN_METAL_TRACE_SCENE_GLYPHS=1 --env-b=MIRIN_METAL_TRACE_SCENE_GLYPHS=1`
 * to compare which subpixel variant each glyph is drawn as too (the
 * digest then differs from a host's without it). To find what
 * differs, give each host a file with
 * `--env-a=MIRIN_METAL_TRACE_SCENE=<path>` (every frame's drawing is
 * appended to it), and `LAYOUT_CHECK_TRACE=1` echoes the hosts' trace.
 *
 * Nothing here waits a fixed time. After each step the check asks the host
 * to settle (the `settle` simulation, with `MIRIN_METAL_CHECK=1`: the host
 * hears only simulated input, runs its animations to their end and draws
 * its frames at once) and lets React finish what the host's events started,
 * again and again until a round brings nothing new; a wait that takes over
 * a minute fails the check. So a check takes seconds, gives the same answer
 * on a busy machine, and several can run at once, each in a compositor of
 * its own (`bench/gates.ts` runs the set). A host from before `settle` (its
 * `protocol` line does not say it) is driven the old way, with fixed waits
 * of 1.5 s a step (3.5 s with `--scene`): slow, and only right on a quiet
 * machine with the pointer elsewhere. `--fixed-waits` drives every host
 * that way, to compare the two ways on one host.
 */

import { join } from "node:path";
import {
  type NativeEvent,
  render,
  ScrollView,
  type SimCommand,
  spawnNativeHost,
  startHeadlessDisplay,
  Text,
  TextInput,
  View,
} from "@mirinjs/metal";
import { type ReactNode, startTransition, useEffect, useState } from "react";
import { Browser } from "../demo/browser.tsx";
import { ThemeProvider } from "../src/provider.tsx";

const args = Bun.argv.slice(2);
const [app, hostA, hostB] = args.filter((arg) => !arg.startsWith("--"));
const apps = ["browser", "grid", "scroll", "scroll-fractional", "across"];
if (!app || !hostA || !hostB || !apps.includes(app)) {
  console.error(
    "usage: bun bench/layout-check.tsx <browser|grid|scroll|scroll-fractional|across> <host-a> <host-b> [--visible] [--scene]",
  );
  process.exit(2);
}
const scene = args.includes("--scene");
/** `--fixed-waits`: no host is asked to settle (see above). */
const fixedWaits = args.includes("--fixed-waits");
/** `--bounds-digits=N`: compare bounds to N decimals (see above); exact without. */
const boundsDigits = args.find((arg) => arg.startsWith("--bounds-digits="))?.split("=")[1];
const bound = (value: number): string => {
  if (boundsDigits === undefined) return String(value);
  const unit = 10 ** Number(boundsDigits);
  // `+ 0`: a rounded -0 is 0.
  return String(Math.round(value * unit) / unit + 0);
};
/** `--env-a=NAME=value` (or `-b`): the environment of that host alone. */
const hostEnv = (host: "a" | "b"): Record<string, string> =>
  Object.fromEntries(
    args
      .filter((arg) => arg.startsWith(`--env-${host}=`))
      .map((arg) => {
        const [name = "", ...value] = arg.slice(`--env-${host}=`.length).split("=");
        return [name, value.join("=")];
      }),
  );
const display = args.includes("--visible") ? null : await startHeadlessDisplay();
if (!display && !args.includes("--visible")) {
  console.error("no headless compositor; pass --visible to use the current display");
  process.exit(1);
}

function Card({ index, hovers = false }: { index: number; hovers?: boolean }) {
  const [selected, setSelected] = useState(false);
  return (
    <View
      testID={`card:${index}`}
      onPress={() => setSelected((value) => !value)}
      onHoverChange={hovers ? () => {} : undefined}
      style={{
        width: 44,
        padding: 4,
        gap: 2,
        borderRadius: 6,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? "#3b82f6" : "#27272a",
        backgroundColor: selected ? "#1e3a8a" : "#18181b",
        hoverBackgroundColor: "#27272a",
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 9, color: "#a1a1aa" }}>#{index}</Text>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#22c55e" }} />
      </View>
      <Text style={{ fontSize: 11, color: "#f4f4f5" }}>
        {selected ? `${(index * 7919) % 1000} picked` : (index * 7919) % 1000}
      </Text>
    </View>
  );
}

function Grid() {
  const [query, setQuery] = useState("");
  return (
    <View style={{ flex: 1, backgroundColor: "#09090b", padding: 8, gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <TextInput
          testID="query"
          value={query}
          onChangeText={setQuery}
          style={{ width: 240, height: 24, color: "#f4f4f5" }}
        />
        <Text style={{ color: "#a1a1aa", fontSize: 12 }}>{query.length} chars</Text>
      </View>
      <View style={{ flex: 1, gap: 2, overflow: "hidden" }}>
        {Array.from({ length: 40 }, (_, row) => (
          <View key={row} style={{ flexDirection: "row", gap: 2, flexWrap: "wrap" }}>
            {Array.from({ length: 25 }, (_, col) => (
              <Card key={col} index={row * 25 + col} />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

/** The grid in a scroll view, under a banner that grows when pressed. */
function Scrolled() {
  const [tall, setTall] = useState(false);
  return (
    <View style={{ flex: 1, backgroundColor: "#09090b", padding: 8, gap: 8 }}>
      <Text style={{ color: "#f4f4f5", fontSize: 14 }}>scrolled</Text>
      <ScrollView testID="scroller" style={{ flex: 1, gap: 8 }}>
        <View
          testID="banner"
          onPress={() => setTall((value) => !value)}
          style={{ height: tall ? 47 : 12, backgroundColor: "#3f3f46" }}
        />
        <View style={{ gap: 2 }}>
          {Array.from({ length: 60 }, (_, row) => (
            <View key={row} style={{ flexDirection: "row", gap: 2 }}>
              {Array.from({ length: 25 }, (_, col) => (
                // Every third row hears hovers: it is never left undrawn.
                <Card key={col} index={row * 25 + col} hovers={row % 3 === 1} />
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * The cards in columns that scroll across, each under two captions (text
 * placed from where its line ends and from its middle), after a strip that
 * widens when pressed.
 */
function Across() {
  const [wide, setWide] = useState(false);
  return (
    <View style={{ flex: 1, backgroundColor: "#09090b", padding: 8, gap: 8 }}>
      <Text style={{ color: "#f4f4f5", fontSize: 14 }}>across</Text>
      <View testID="scroller" style={{ flex: 1, overflow: "scroll-x" }}>
        <View style={{ flexDirection: "row", gap: 2, alignItems: "flex-start" }}>
          <View
            testID="banner"
            onPress={() => setWide((value) => !value)}
            style={{ width: wide ? 47 : 12, height: 400, backgroundColor: "#3f3f46" }}
          />
          {Array.from({ length: 80 }, (_, column) => (
            <View key={column} style={{ gap: 2 }}>
              {Array.from({ length: 12 }, (_, row) => (
                // Every third column hears hovers: it is never left undrawn.
                <Card key={row} index={column * 12 + row} hovers={column % 3 === 1} />
              ))}
              <Text style={{ width: 44, textAlign: "center", fontSize: 10, color: "#a1a1aa" }}>
                col {column}
              </Text>
              <Text style={{ width: 44, textAlign: "right", fontSize: 10, color: "#a1a1aa" }}>
                {(column * 7919) % 1000}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

type Step = {
  name: string;
  /** `at`: a point inside the border of the node with a test id, as last laid out. */
  command?: (
    nodeId: (testId: string) => string,
    at: (testId: string) => { x: number; y: number },
  ) => SimCommand;
  /** Instead of a command: the window is resized to this width (800 tall). */
  width?: number;
};
/** The window resized: every row is laid out at another width. */
const resize = (width: number): Step => ({ name: `resize to ${width}`, width });
const scroll = (dy: number): Step => ({
  name: `scroll ${dy}`,
  command: (id) => ({ kind: "scroll", id: id("scroller"), dy }),
});
const across = (dx: number): Step => ({
  name: `across ${dx}`,
  command: (id) => ({ kind: "scroll", id: id("scroller"), dy: 0, dx }),
});
/** A press by window coordinates on a card's edge: on whichever node is drawn there. */
const press = (index: number): Step => ({
  name: `press at ${index}`,
  command: (_, at) => ({ kind: "click", ...at(`card:${index}`) }),
});
/** A pointer move by window coordinates onto a card. */
const point = (index: number): Step => ({
  name: `move to ${index}`,
  command: (_, at) => ({ kind: "move", ...at(`card:${index}`) }),
});
/**
 * `scroll-fractional`: the scroll view scrolled by fractions of a pixel.
 * Painted at whole device pixels, the rows move by whole pixels and are
 * copied; the offset itself keeps its fraction, so small steps add up.
 */
const fractionalSteps: Step[] = [
  scroll(40.5),
  scroll(40.5),
  scroll(13.3),
  scroll(13.3),
  scroll(13.3),
  press(130),
  point(160),
  // Less than a pixel at a time: every few steps the rows move by one.
  scroll(0.3),
  scroll(0.3),
  scroll(0.3),
  scroll(0.3),
  point(110),
  scroll(700.7),
  press(480),
  point(560),
  { name: "grow", command: (id) => ({ kind: "click", id: id("banner") }) },
  point(485),
  // Back: rows that left the view come into it again.
  scroll(-320.4),
  press(300),
  point(410),
  { name: "shrink", command: (id) => ({ kind: "click", id: id("banner") }) },
  scroll(-13.3),
  scroll(-13.3),
  // The end (painted where it is), a little back, and the start.
  scroll(5000),
  point(1410),
  scroll(-0.4),
  press(1420),
  scroll(-5000.5),
  point(35),
  { name: "move off", command: () => ({ kind: "move", x: 2, y: 2 }) },
];

const steps: Step[] =
  app === "scroll"
    ? [
        scroll(40),
        scroll(40),
        scroll(13),
        // Presses and pointer moves by window coordinates: on whichever
        // card is drawn there after the scroll (rows 1, 4, 7… hear hovers).
        press(130),
        point(160),
        point(110),
        scroll(700),
        press(480),
        point(560),
        // Narrower and back: the rows out of view keep their cards where
        // they were, and the ones in view are drawn at the new width.
        resize(1180),
        point(485),
        scroll(40),
        press(530),
        resize(1280),
        // What is above the rows grows: every row moves.
        { name: "grow", command: (id) => ({ kind: "click", id: id("banner") }) },
        point(485),
        press(510),
        scroll(-320),
        press(300),
        point(410),
        { name: "shrink", command: (id) => ({ kind: "click", id: id("banner") }) },
        // Half a pixel: nothing lands on whole pixels.
        scroll(60.5),
        press(330),
        scroll(19.5),
        scroll(5000),
        point(1410),
        resize(1100),
        press(1420),
        scroll(-5000),
        resize(1280),
        point(35),
        { name: "move off", command: () => ({ kind: "move", x: 2, y: 2 }) },
      ]
    : app === "grid"
      ? [
          // Selecting widens a card's border and lengthens its text: its row
          // grows and every row below moves.
          { name: "select 3", command: (id) => ({ kind: "click", id: id("card:3") }) },
          { name: "select 260", command: (id) => ({ kind: "click", id: id("card:260") }) },
          { name: "hover 30", command: (id) => ({ kind: "move", id: id("card:30") }) },
          { name: "hover off", command: () => ({ kind: "move", x: 2, y: 2 }) },
          { name: "unselect 3", command: (id) => ({ kind: "click", id: id("card:3") }) },
          { name: "focus query", command: (id) => ({ kind: "click", id: id("query") }) },
          { name: "type", command: () => ({ kind: "type", text: "abc" }) },
          // The rows below the fold are left out at any width.
          resize(1180),
          { name: "select 4", command: (id) => ({ kind: "click", id: id("card:4") }) },
          resize(1280),
        ]
      : [
          { name: "badge", command: (id) => ({ kind: "click", id: id("example:badge-demo") }) },
          { name: "card", command: (id) => ({ kind: "click", id: id("example:card-demo") }) },
          {
            name: "accordion",
            command: (id) => ({ kind: "click", id: id("example:accordion-demo") }),
          },
          // The pointer rests on an item while the list scrolls under it:
          // the item's highlight moves with the list, and another takes it.
          {
            name: "rest on item",
            command: (id) => ({ kind: "move", id: id("example:badge-demo") }),
          },
          {
            name: "scroll list",
            command: (id) => ({ kind: "scroll", id: id("example-list"), dy: 300 }),
          },
          {
            name: "hover item",
            command: (id) => ({ kind: "move", id: id("example:button-demo") }),
          },
          { name: "button", command: (id) => ({ kind: "click", id: id("example:button-demo") }) },
          { name: "theme", command: (id) => ({ kind: "click", id: id("toggle-theme") }) },
          { name: "search", command: (id) => ({ kind: "click", id: id("search") }) },
          { name: "type", command: () => ({ kind: "type", text: "but" }) },
          // Narrower (a breakpoint the example browser answers) and back.
          resize(900),
          resize(1280),
        ];

/** `across`: scrolled across, as `scroll` is down, and by fractions of a pixel. */
const acrossSteps: Step[] = [
  across(40),
  across(40),
  across(13),
  press(130),
  point(160),
  point(110),
  across(700),
  press(400),
  point(460),
  // What is before the columns widens: every column moves.
  { name: "widen", command: (id) => ({ kind: "click", id: id("banner") }) },
  point(405),
  press(430),
  across(-320),
  press(300),
  point(250),
  { name: "narrow", command: (id) => ({ kind: "click", id: id("banner") }) },
  across(60.5),
  press(330),
  across(19.5),
  across(13.3),
  across(0.3),
  across(0.3),
  across(0.3),
  point(340),
  across(5000),
  point(900),
  press(910),
  across(-0.4),
  across(-5000.5),
  point(35),
  { name: "move off", command: () => ({ kind: "move", x: 2, y: 2 }) },
];

/** The steps the app is driven through. */
const driven: Step[] =
  app === "scroll-fractional" ? fractionalSteps : app === "across" ? acrossSteps : steps;

type Snapshot = Map<string, string>;

/** How long any one wait may take before the check fails. */
const WAIT_MS = 60_000;

/** Fail the check with what went wrong (never a difference: exit code 2). */
function fail(message: string): never {
  console.error(`layout-check: ${message}`);
  process.exit(2);
}

/** `promise`, or the check fails saying what never came. */
function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no ${what} in ${WAIT_MS / 1000} s`)), WAIT_MS);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Tells when React has rendered and committed everything asked of it so
 * far: a transition (the lowest priority there is) through a state of its
 * own, whose effect runs once the commit with it, and so every update asked
 * before it, is done.
 */
class Idle {
  private asked = 0;
  private reached = 0;
  private waiting: Array<{ tick: number; done: () => void }> = [];
  private ask: ((tick: number) => void) | null = null;

  /** The wrapper mounted: it takes the ticks from now on, and the last one asked. */
  mounted(ask: (tick: number) => void): void {
    this.ask = ask;
    if (this.asked > this.reached) ask(this.asked);
  }

  /** The commit with `tick` is done. */
  committed(tick: number): void {
    this.reached = Math.max(this.reached, tick);
    const done = this.waiting.filter((wait) => wait.tick <= this.reached);
    this.waiting = this.waiting.filter((wait) => wait.tick > this.reached);
    for (const wait of done) wait.done();
  }

  /** Resolves once React has nothing left of what was asked before this. */
  idle(): Promise<void> {
    this.asked += 1;
    const tick = this.asked;
    return new Promise((done) => {
      this.waiting.push({ tick, done });
      this.ask?.(tick);
    });
  }
}

/** The app, under a state `idle` moves to tell when React is done. */
function Settles({ idle, children }: { idle: Idle; children: ReactNode }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    idle.mounted((next) => startTransition(() => setTick(next)));
  }, [idle]);
  useEffect(() => {
    idle.committed(tick);
  }, [idle, tick]);
  return children;
}

async function run(binary: string): Promise<Array<{ name: string; layout: Snapshot }>> {
  // What the last frame drew (`--scene`): from the host's `settled` event,
  // or for a host without it from its trace. And what every frame since
  // the last snapshot drew: a host that settles says for each round.
  let drew = "";
  let frames: string[] = [];
  const transport = spawnNativeHost(binary, {
    title: "layout check",
    width: 1280,
    height: 800,
    env: {
      ...display?.env,
      // Only simulated input, animations at once, frames without waiting
      // (a host from before it ignores it).
      ...(fixedWaits ? {} : { MIRIN_METAL_CHECK: "1" }),
      ...(scene ? { MIRIN_METAL_TRACE: "1", MIRIN_METAL_TRACE_SCENE: "1" } : {}),
      ...hostEnv("a"),
    },
    onStderr(line) {
      const digest = line.match(/^\[mirin-metal trace\] [\d.]+ scene ([0-9a-f]+)$/)?.[1];
      if (digest) drew = digest;
      else if (!line.startsWith("[mirin-metal trace]") || process.env.LAYOUT_CHECK_TRACE) {
        console.error(line);
      }
    },
  });
  // The nodes pressed and hovered since the last snapshot, in order.
  let heard: string[] = [];
  // What the driver sent and the host said since the check last looked:
  // a round of settling that moves neither is the last.
  let exchanged = 0;
  const send = transport.send.bind(transport);
  transport.send = (line) => {
    exchanged += 1;
    if (process.env.LAYOUT_CHECK_TRACE) console.error(`layout-check: sent ${line.length} bytes`);
    send(line);
  };
  type Answer = Extract<NativeEvent, { type: "protocol" | "settled" | "layout" }>;
  const answers = new Map<Answer["type"], (event: Answer) => void>();
  let gone: ((error: Error) => void) | null = null;
  const closed = new Promise<never>((_, reject) => {
    gone = reject;
  });
  // Unheard when the check ends by itself.
  closed.catch(() => {});
  transport.onClose(() => gone?.(new Error("the host exited")));
  /** The host's next event of a type it sends only in answer. */
  const answer = <T extends Answer["type"]>(type: T): Promise<Extract<Answer, { type: T }>> =>
    within(
      Promise.race([
        new Promise<Extract<Answer, { type: T }>>((resolve) => {
          answers.set(type, (event) => resolve(event as Extract<Answer, { type: T }>));
        }),
        closed,
      ]),
      `${type} from ${binary}`,
    );
  const word = answer("protocol");
  transport.onEvent((event: NativeEvent) => {
    if (event.type === "protocol" || event.type === "settled" || event.type === "layout") {
      const waiting = answers.get(event.type);
      answers.delete(event.type);
      waiting?.(event);
      return;
    }
    exchanged += 1;
    if (process.env.LAYOUT_CHECK_TRACE) console.error(`layout-check: heard ${event.type}`);
    if (event.type === "press") heard.push(`press ${event.nodeId}`);
    if (event.type === "hover") heard.push(`hover ${event.nodeId} ${event.hovered}`);
  });
  // The example browser imports an example when it is first shown, from
  // an effect: read from disk, that ends whenever it ends. Imported before,
  // it is there within the step that shows it.
  if (app === "browser") {
    const shown = ["button-demo", "badge-demo", "card-demo", "accordion-demo"];
    await Promise.all(
      shown.map((name) => import(join(import.meta.dir, "../demo/examples", `${name}.tsx`))),
    );
  }
  const idle = new Idle();
  const root = render(
    <Settles idle={idle}>
      {app === "scroll" || app === "scroll-fractional" ? (
        <Scrolled />
      ) : app === "across" ? (
        <Across />
      ) : app === "grid" ? (
        <Grid />
      ) : (
        <ThemeProvider>
          <Browser initial="button-demo" />
        </ThemeProvider>
      )}
    </Settles>,
    transport,
  );
  const nodeId = (testId: string): string => {
    const id = root.nodeId(testId);
    if (!id) throw new Error(`no node ${testId}`);
    return id;
  };
  const settles = (await word).settle === true && !fixedWaits;
  if (!settles) console.error(`layout-check: ${binary} is given fixed waits`);
  /**
   * The host and the app have both come to rest: the host has drawn what
   * it was sent, React has answered what the host said, and a round of
   * both exchanged nothing more. A host without `settle` is given `ms`.
   */
  const settled = async (ms: number): Promise<void> => {
    if (!settles) {
      await Bun.sleep(ms);
      return;
    }
    for (let round = 0; ; round += 1) {
      if (round === 100) throw new Error(`${binary} and the app never came to rest`);
      const before = exchanged;
      const waiting = answer("settled");
      transport.simulate({ kind: "settle" });
      const event = await waiting;
      if (!event.quiet) throw new Error(`${binary} did not settle`);
      if (event.scene !== undefined) drew = event.scene;
      if (event.frames !== undefined && event.frames !== "0") frames.push(event.frames);
      await within(idle.idle(), "idle app");
      if (exchanged === before) return;
    }
  };
  const snapshot = async (): Promise<Snapshot> => {
    const waiting = answer("layout");
    transport.simulate({ kind: "layout" });
    const { nodes } = await waiting;
    const snapshot = new Map(
      nodes.map((node) => [
        node.id,
        `${bound(node.x)},${bound(node.y)} ${bound(node.width)}x${bound(node.height)}`,
      ]),
    );
    snapshot.set("(heard)", heard.join(", "));
    heard = [];
    if (scene) {
      snapshot.set("(drew)", drew);
      snapshot.set("(frames)", frames.join(" "));
      frames = [];
    }
    return snapshot;
  };
  await settled(3000);
  // How many frames a window opens with depends on when its driver's first
  // lines reach it: only what it settles into is compared there.
  frames = [];
  const out = [{ name: "initial", layout: await snapshot() }];
  for (const step of driven) {
    const laid = out.at(-1)?.layout;
    const at = (testId: string): { x: number; y: number } => {
      const [x = 0, y = 0] = (laid?.get(nodeId(testId)) ?? "").split(/[, ]/).map(Number);
      return { x: x + 2, y: y + 2 };
    };
    if (process.env.LAYOUT_CHECK_TRACE) console.error(`layout-check: step ${step.name}`);
    if (step.width !== undefined) transport.setSize(step.width, 800);
    else if (step.command) transport.simulate(step.command(nodeId, at));
    // Without `settle`, several frames: the driver's answer, then whatever
    // it settles into (a scroll bar fades for over a second, at a nested
    // compositor's pace of a frame a second).
    await settled(scene ? 3500 : 1500);
    out.push({ name: step.name, layout: await snapshot() });
  }
  root.unmount();
  transport.close();
  return out;
}

// Each host runs in a process of its own, so node ids (a counter in the
// renderer) line up between the two. The child (`--record`) writes its
// steps to its standard output, which nothing else of it uses.
type Recorded = Array<{ name: string; layout: Array<[string, string]> }>;
if (args.includes("--record")) {
  const steps = await run(hostA).catch((error: unknown) =>
    fail(error instanceof Error ? error.message : String(error)),
  );
  display?.close();
  const record: Recorded = steps.map((step) => ({ name: step.name, layout: [...step.layout] }));
  await Bun.write(Bun.stdout, JSON.stringify(record));
  process.exit(0);
}
async function recorded(
  binary: string,
  host: "a" | "b",
): Promise<Array<{ name: string; layout: Snapshot }>> {
  const child = Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      app as string,
      binary,
      "-",
      "--record",
      ...args.filter(
        (arg) =>
          arg === "--visible" ||
          arg === "--scene" ||
          arg === "--fixed-waits" ||
          arg.startsWith("--bounds-digits="),
      ),
      // The child runs it as its first host.
      ...Object.entries(hostEnv(host)).map(([name, value]) => `--env-a=${name}=${value}`),
    ],
    { stdout: "pipe", stderr: "inherit", env: { ...process.env, ...display?.env } },
  );
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) {
    display?.close();
    fail(`${binary} was not recorded`);
  }
  const steps = JSON.parse(text) as Recorded;
  return steps.map((step) => ({ name: step.name, layout: new Map(step.layout) }));
}
const a = await recorded(hostA, "a");
const b = await recorded(hostB, "b");
display?.close();
let differences = 0;
for (const [index, stepA] of a.entries()) {
  const stepB = b[index];
  if (!stepB) continue;
  const ids = new Set([...stepA.layout.keys(), ...stepB.layout.keys()]);
  let differ = 0;
  for (const id of ids) {
    const [left, right] = [stepA.layout.get(id), stepB.layout.get(id)];
    if (left !== right) {
      if (differ < 5)
        console.log(`  ${stepA.name}: node ${id}: ${left ?? "absent"} vs ${right ?? "absent"}`);
      differ += 1;
    }
  }
  console.log(
    `${stepA.name.padEnd(14)} ${stepA.layout.size - 1 - 2 * Number(scene)} nodes, ${differ} differ`,
  );
  differences += differ;
}
console.log(differences === 0 ? "layouts identical" : `${differences} differences`);
process.exit(differences === 0 ? 0 : 1);
