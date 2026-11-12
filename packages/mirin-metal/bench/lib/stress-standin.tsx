/**
 * `bench/driver.tsx --stress`: the stress bench's dashboard
 * (`lib/dashboard.tsx`) on the stand-in host, so its `driver` column is
 * timed without a host, a compositor or the trip a simulated event makes
 * through them: from the event to the patch sent, per scenario, as the app
 * is written and with its cards memoized (the floor for the same app).
 */

import { render } from "../../src/index.ts";
import { Dashboard } from "./dashboard.tsx";
import { openInstructionCounter } from "./instructions.ts";
import { attribute, attributionTable, profiled } from "./profile.ts";
import { standIn } from "./standin.ts";

interface Options {
  rows: number;
  cols: number;
  runs: number;
  profile: boolean;
  json: boolean;
}

interface Scenario {
  name: string;
  /** The event, the run'th time. */
  event: (run: number) => Parameters<ReturnType<typeof standIn>["emit"]>[0];
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const counter = openInstructionCounter();

async function variant(memo: boolean, options: Options): Promise<Record<string, unknown>> {
  const host = standIn();
  const root = render(
    <Dashboard rows={options.rows} cols={options.cols} memo={memo} />,
    host.transport,
  );
  while (host.sends === 0) await Bun.sleep(1);
  const id = (testID: string): string => {
    const found = root.nodeId(testID);
    if (!found) throw new Error(`no node ${testID}`);
    return found;
  };
  const query = id("query");
  const banner = id("banner");
  const cards = Array.from({ length: 20 }, (_, index) => id(`card:${(index * 37) % 300}`));
  let typed = "";
  const scenarios: Scenario[] = [
    {
      name: "type",
      event: (run) => {
        typed += String.fromCharCode(97 + (run % 26));
        return { type: "change", nodeId: query, value: typed };
      },
    },
    { name: "grow", event: () => ({ type: "press", nodeId: banner }) },
    {
      name: "select",
      event: (run) => ({ type: "press", nodeId: cards[run % cards.length] as string }),
    },
  ];
  // Wall time to the patch sent, the process's CPU over it, and the main
  // thread's instructions (a shared machine stretches the first two; the
  // count is what the work was, `lib/instructions.ts`).
  const timed = (
    scenario: Scenario,
    run: number,
  ): { ms: number; cpu: number; minstr: number; bytes: number } => {
    const bytes = host.bytes;
    const cpu = process.cpuUsage();
    const instructions = counter?.read() ?? 0;
    const start = Bun.nanoseconds();
    host.emit(scenario.event(run));
    const end = host.lastSendAt;
    const minstr = ((counter?.read() ?? 0) - instructions) / 1e6;
    const used = process.cpuUsage(cpu);
    return {
      ms: (end - start) / 1e6,
      cpu: (used.user + used.system) / 1000,
      minstr,
      bytes: host.bytes - bytes,
    };
  };
  const results: Record<string, { ms: number; cpu: number; minstr: number; kb: number }> = {};
  for (const scenario of scenarios) {
    // The first few are a warm-up: the code past its first tiers.
    for (let run = 0; run < 4; run += 1) timed(scenario, run);
    const samples = Array.from({ length: options.runs }, (_, run) => timed(scenario, run + 4));
    if (process.env.STRESS_SAMPLES) {
      console.error(
        scenario.name,
        samples.map((sample) => `${sample.ms.toFixed(1)}/${sample.minstr.toFixed(0)}`).join(" "),
      );
    }
    results[scenario.name] = {
      ms: median(samples.map((sample) => sample.ms)),
      cpu: median(samples.map((sample) => sample.cpu)),
      minstr: median(samples.map((sample) => sample.minstr)),
      kb: median(samples.map((sample) => sample.bytes)) / 1024,
    };
  }
  const label = memo ? "memoized cards" : "as written";
  if (!options.json) {
    console.log(
      `${label.padEnd(16)} ${scenarios
        .map((scenario) => {
          const result = results[scenario.name];
          return `${scenario.name} ${result?.ms.toFixed(2).padStart(6)} ms ${result?.minstr.toFixed(1).padStart(6)} M instr ${result?.kb.toFixed(1).padStart(5)} KB`;
        })
        .join("   ")}`,
    );
  }
  if (options.profile) {
    for (const scenario of scenarios.slice(0, 2)) {
      const { profile } = await profiled(() => {
        for (let run = 0; run < options.runs; run += 1) timed(scenario, run);
      });
      console.log(`${label}, ${scenario.name}, main thread:`);
      console.log(attributionTable(attribute(profile), options.runs, "ms per update"));
    }
  }
  root.unmount();
  return { variant: label, ...results };
}

export async function stressOnStandIn(options: Options): Promise<void> {
  if (!options.json) {
    console.log(
      `stress dashboard, ${options.rows}×${options.cols} cards on the stand-in; event → patch sent, medians of ${options.runs}`,
    );
  }
  const results = [await variant(false, options), await variant(true, options)];
  if (options.json) console.log(JSON.stringify(results));
}
