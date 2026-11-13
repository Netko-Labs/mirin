/**
 * What one interaction on the example browser costs the driver: the time
 * from the event to the last line sent, the CPU of the whole process (the
 * JIT's and the collector's threads too), the lines and bytes sent, and,
 * from a second profiled pass, where the main thread's time went.
 */

import type { NativeEvent } from "@mirinjs/metal";
import { openInstructionCounter } from "../../../mirin-metal/bench/lib/instructions.ts";
import { attribute, attributionTable, profiled } from "../../../mirin-metal/bench/lib/profile.ts";
import { openBrowser, type Session } from "./session.tsx";

interface Sample {
  /** Event in → the handler's own commit sent (discrete events render before they return). */
  syncMs: number;
  /** Event in → the driver's next free turn (a render the event only scheduled has run by then). */
  turnMs: number;
  /** Event in → last line sent (effects, the example's import, later commits). */
  lastMs: number;
  cpuMs: number;
  /** Millions of main-thread instructions, event in → next free turn (steady where times are not). */
  minstr: number;
  sends: number;
  bytes: number;
}

interface Interaction {
  name: string;
  /** Put back what the steps changed (the search field emptied), outside what is timed. */
  after?(session: Session): Promise<void>;
  /** The event of step `index` (its node looked up here, outside what is timed). */
  event(session: Session, index: number): NativeEvent;
}

const QUERY = ["d", "dr", "dro", "drop", "dro", "dr", "d", ""];

const INTERACTIONS: Interaction[] = [
  {
    name: "switch example (badge-demo ↔ button-demo)",
    event: (session, index) =>
      session.pressOf(`example:${index % 2 === 0 ? "badge-demo" : "button-demo"}`),
  },
  {
    name: "switch example (card-demo ↔ table-demo)",
    event: (session, index) =>
      session.pressOf(`example:${index % 2 === 0 ? "card-demo" : "table-demo"}`),
  },
  {
    name: "type in search (one character)",
    event: (session, index) => session.changeOf("search", QUERY[index % QUERY.length] ?? ""),
    async after(session) {
      session.type("search", "");
      await session.settle();
    },
  },
  {
    name: "toggle theme",
    event: (session) => session.pressOf("toggle-theme"),
  },
  {
    name: "window resized by a pixel (no breakpoint crossed)",
    event: (session, index) => session.resizeOf(1290 + (index % 9)),
  },
];

const counter = openInstructionCounter();

const cpuNow = (): number => {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000;
};

async function measure(session: Session, interaction: Interaction, index: number): Promise<Sample> {
  const { host } = session;
  const event = interaction.event(session, index);
  const sends = host.sends;
  const bytes = host.bytes;
  const cpu = cpuNow();
  const instructions = counter?.read() ?? 0;
  const from = Bun.nanoseconds();
  host.emit(event);
  const syncMs = (Bun.nanoseconds() - from) / 1e6;
  // React's own task was queued by the event, so it runs before this one.
  await new Promise((done) => setImmediate(done));
  const turnMs = (Bun.nanoseconds() - from) / 1e6;
  const minstr = ((counter?.read() ?? 0) - instructions) / 1e6;
  await session.settle();
  return {
    syncMs,
    turnMs,
    lastMs: host.sends > sends ? (host.lastSendAt - from) / 1e6 : 0,
    cpuMs: cpuNow() - cpu,
    minstr,
    sends: host.sends - sends,
    bytes: host.bytes - bytes,
  };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

export async function interact(rounds: number, withProfile: boolean, json: boolean): Promise<void> {
  const session = await openBrowser({ quietMs: 12 });
  const report: Record<string, unknown> = {};
  for (const interaction of INTERACTIONS) {
    // Warm: the examples' modules loaded, the code past its first tiers.
    for (let index = 0; index < 16; index += 1) await measure(session, interaction, index);
    const samples: Sample[] = [];
    for (let index = 0; index < rounds; index += 1) {
      samples.push(await measure(session, interaction, index));
    }
    const row = {
      syncMs: median(samples.map((sample) => sample.syncMs)),
      turnMs: median(samples.map((sample) => sample.turnMs)),
      lastMs: median(samples.map((sample) => sample.lastMs)),
      cpuMs: median(samples.map((sample) => sample.cpuMs)),
      minstr: median(samples.map((sample) => sample.minstr)),
      sends: median(samples.map((sample) => sample.sends)),
      kb: median(samples.map((sample) => sample.bytes)) / 1024,
    };
    report[interaction.name] = row;
    if (!json) {
      console.log(
        `${interaction.name}\n  event → own commit sent ${row.syncMs.toFixed(2)} ms, → next free turn ${row.turnMs.toFixed(2)} ms, → last line sent ${row.lastMs.toFixed(2)} ms, process CPU ${row.cpuMs.toFixed(2)} ms, ${row.minstr.toFixed(1)} M instructions, ${row.sends} lines, ${row.kb.toFixed(1)} KB`,
      );
    }
    await interaction.after?.(session);
    if (withProfile) {
      const { profile } = await profiled(async () => {
        for (let index = 0; index < rounds; index += 1) await measure(session, interaction, index);
      });
      await interaction.after?.(session);
      const attribution = attribute(profile);
      if (json) report[`${interaction.name}: profile`] = attribution;
      else console.log(attributionTable(attribution, rounds, "ms per interaction, main thread"));
    }
  }
  if (json) console.log(JSON.stringify(report));
}
