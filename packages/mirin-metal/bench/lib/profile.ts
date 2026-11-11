/**
 * CPU attribution for driver benchmarks: JavaScriptCore's sampling profiler
 * through `node:inspector` (Bun ≥ 1.3), started and stopped around the work
 * being measured, and its samples summed by where the time was spent. A
 * sample belongs to the innermost frame that has a source file (a native
 * frame such as `JSON.stringify` counts for the function that called it).
 */

import inspector from "node:inspector";

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}

interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
}

export interface CpuProfile {
  nodes: ProfileNode[];
  samples: number[];
  /** Microseconds between samples. */
  timeDeltas: number[];
}

/** Name a source file's category; the first rule that matches wins. */
export type Rule = [category: string, matches: (frame: CallFrame) => boolean];

const inPath = (part: string) => (frame: CallFrame) => frame.url.includes(part);

/** The driver's parts, most specific first. */
export const DRIVER_RULES: Rule[] = [
  ["className translation (tw/)", inPath("/mirin-metal-ui/src/tw/")],
  ["cn/cva (lib/cn.ts)", inPath("/mirin-metal-ui/src/lib/cn.ts")],
  ["css vars (runtime/vars.ts)", inPath("/mirin-metal-ui/src/runtime/vars.ts")],
  ["Box (runtime/box.tsx)", inPath("/mirin-metal-ui/src/runtime/box.tsx")],
  ["metal-ui runtime, other", inPath("/mirin-metal-ui/src/runtime/")],
  ["icons", inPath("/mirin-metal-ui/src/icons/")],
  ["metal-ui components", inPath("/mirin-metal-ui/src/")],
  ["serialize.ts", inPath("/mirin-metal/src/lib/serialize.ts")],
  ["tree-sync.ts", inPath("/mirin-metal/src/lib/tree-sync.ts")],
  ["host config, commit log", inPath("/mirin-metal/src/lib/")],
  ["@mirinjs/metal, other", inPath("/mirin-metal/src/")],
  ["react-reconciler", inPath("/react-reconciler/")],
  ["scheduler", inPath("/scheduler/")],
  ["react", inPath("/react/")],
  ["app (demo/, examples)", inPath("/demo/")],
  ["bench", inPath("/bench/")],
  ["other packages", inPath("/node_modules/")],
];

/** The longest a single sample counts for (the sampler asks for 100 µs and gets about 200). */
const MAX_SAMPLE_US = 1000;

function post<T>(session: inspector.Session, method: string, params?: object): Promise<T> {
  return new Promise((resolve, reject) => {
    // Type-only cast: the inspector's typings list each method's overload; this passes any of them.
    (
      session.post as (
        m: string,
        p: object | undefined,
        cb: (e: Error | null, r: T) => void,
      ) => void
    )(method, params, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

/** Run `work` under the sampling profiler. */
export async function profiled<T>(
  work: () => Promise<T> | T,
  intervalUs = 100,
): Promise<{ result: T; profile: CpuProfile }> {
  const session = new inspector.Session();
  session.connect();
  await post(session, "Profiler.enable");
  await post(session, "Profiler.setSamplingInterval", { interval: intervalUs });
  await post(session, "Profiler.start");
  let result: T;
  let profile: CpuProfile;
  try {
    result = await work();
  } finally {
    ({ profile } = await post<{ profile: CpuProfile }>(session, "Profiler.stop"));
    session.disconnect();
  }
  return { result, profile };
}

/** Milliseconds per category, and per function within it, largest first. */
export interface Attribution {
  totalMs: number;
  categories: Array<{ name: string; ms: number; top: Array<{ name: string; ms: number }> }>;
}

export function attribute(profile: CpuProfile, rules: Rule[] = DRIVER_RULES): Attribution {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parent.set(child, node.id);
  // The innermost ancestor (or the node itself) with a source file.
  const owner = new Map<number, ProfileNode | null>();
  const ownerOf = (id: number): ProfileNode | null => {
    const known = owner.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id);
    let found: ProfileNode | null = null;
    if (node) {
      const up = parent.get(id);
      found = node.callFrame.url ? node : up === undefined ? null : ownerOf(up);
    }
    owner.set(id, found);
    return found;
  };
  const categories = new Map<string, { ms: number; functions: Map<string, number> }>();
  let totalMs = 0;
  profile.samples.forEach((id, index) => {
    // A sample after a wait (the event loop asleep, a module being read)
    // carries the whole wait: count it as one interval of work at most.
    const ms = Math.min(profile.timeDeltas[index] ?? 0, MAX_SAMPLE_US) / 1000;
    const node = ownerOf(id);
    totalMs += ms;
    const name = node
      ? (rules.find(([, matches]) => matches(node.callFrame))?.[0] ?? "other")
      : "native, no caller";
    const entry = categories.get(name) ?? { ms: 0, functions: new Map<string, number>() };
    entry.ms += ms;
    const fn = node ? `${node.callFrame.functionName || "(anonymous)"}` : "(native)";
    entry.functions.set(fn, (entry.functions.get(fn) ?? 0) + ms);
    categories.set(name, entry);
  });
  return {
    totalMs,
    categories: [...categories.entries()]
      .map(([name, { ms, functions }]) => ({
        name,
        ms,
        top: [...functions.entries()]
          .map(([fn, fnMs]) => ({ name: fn, ms: fnMs }))
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 6),
      }))
      .sort((a, b) => b.ms - a.ms),
  };
}

/** The attribution as a table, each time divided by `per` (iterations). */
export function attributionTable(attribution: Attribution, per = 1, unit = "ms"): string {
  const lines = [`  sampled ${(attribution.totalMs / per).toFixed(2)} ${unit}`];
  for (const category of attribution.categories) {
    const share = ((category.ms / attribution.totalMs) * 100).toFixed(0).padStart(3);
    const top = category.top
      .slice(0, 4)
      .map((fn) => `${fn.name} ${(fn.ms / per).toFixed(2)}`)
      .join(", ");
    lines.push(
      `  ${share}% ${(category.ms / per).toFixed(2).padStart(7)}  ${category.name.padEnd(30)} ${top}`,
    );
  }
  return lines.join("\n");
}
