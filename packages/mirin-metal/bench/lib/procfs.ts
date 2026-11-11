/**
 * What a Linux process costs, read from `/proc`: memory by mapping
 * (`smaps`, `smaps_rollup`), threads, CPU time, wakeups, and the GPU memory
 * its DRM clients hold (`fdinfo`). Used by `bench/footprint.tsx`.
 */

import { readdirSync, readFileSync, readlinkSync } from "node:fs";

/** Sizes in kB, as `smaps` reports them. */
export interface MemoryKb {
  rss: number;
  pss: number;
  privateDirty: number;
  privateClean: number;
  sharedClean: number;
  anonymous: number;
  swap: number;
}

const EMPTY: MemoryKb = {
  rss: 0,
  pss: 0,
  privateDirty: 0,
  privateClean: 0,
  sharedClean: 0,
  anonymous: 0,
  swap: 0,
};

const FIELDS = new Map<string, keyof MemoryKb>([
  ["Rss", "rss"],
  ["Pss", "pss"],
  ["Private_Dirty", "privateDirty"],
  ["Private_Clean", "privateClean"],
  ["Shared_Clean", "sharedClean"],
  ["Anonymous", "anonymous"],
  ["Swap", "swap"],
]);

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function add(into: MemoryKb, from: MemoryKb): void {
  for (const key of Object.keys(EMPTY) as Array<keyof MemoryKb>) into[key] += from[key];
}

/** The process's totals (`smaps_rollup`), or null once it has gone. */
export function memoryRollup(pid: number): MemoryKb | null {
  const text = read(`/proc/${pid}/smaps_rollup`);
  if (text === null) return null;
  const total = { ...EMPTY };
  for (const line of text.split("\n")) {
    const match = line.match(/^(\w+):\s+(\d+) kB/);
    const field = FIELDS.get(match?.[1] ?? "");
    if (match && field) total[field] = Number(match[2]);
  }
  return total;
}

export interface Mapping extends MemoryKb {
  name: string;
  category: string;
  sizeKb: number;
}

const GPU_LIBRARY =
  /vulkan|radeon|nvidia|libnv|intel|libLLVM|libdrm|mesa|gallium|libgbm|libEGL|libGL|spirv|libxcb-dri|libglapi|libelf|libz3|libclang/i;

/** The kind of memory a mapping is, from its name and what came before it. */
function categorize(name: string, afterGuard: boolean, binary: string): string {
  if (name === "[heap]") return "heap";
  if (name === "[stack]") return "stacks";
  if (name === "") return afterGuard ? "stacks" : "anon";
  if (name.startsWith("[")) return "kernel";
  if (name === binary) return "binary";
  if (name.startsWith("/dev/dri/") || name.includes("dmabuf")) return "gpu mappings";
  if (/\.(ttf|otf|ttc|pfb|pcf(\.gz)?)$/i.test(name) || name.includes("/fontconfig/")) {
    return "fonts";
  }
  if (name.includes("mesa_shader_cache") || name.includes("/nvidia/GLCache")) return "gpu driver";
  if (/\.so(\.[\w.]+)?$/.test(name)) return GPU_LIBRARY.test(name) ? "gpu driver" : "libraries";
  if (name.startsWith("/memfd:") || name.startsWith("/dev/shm/") || name.startsWith("/SYSV")) {
    return "shared memory";
  }
  return "other files";
}

/**
 * Every mapping of the process with what it holds resident. An unnamed
 * read-write mapping right after a small inaccessible one (a guard page) is
 * counted as a thread stack: that is how pthreads lays them out. The rest of
 * the unnamed ones are malloc's arenas and other private memory (`anon`).
 */
export function mappings(pid: number): Mapping[] {
  const text = read(`/proc/${pid}/smaps`);
  if (text === null) return [];
  let binary = "";
  try {
    binary = readlinkSync(`/proc/${pid}/exe`);
  } catch {}
  const found: Mapping[] = [];
  let current: Mapping | null = null;
  let previousEnd = "";
  let previousPerms = "";
  let previousSizeKb = 0;
  for (const line of text.split("\n")) {
    const header = line.match(/^([0-9a-f]+)-([0-9a-f]+) (\S{4}) \S+ \S+ \S+\s*(.*)$/);
    if (header) {
      const [, start = "", end = "", perms = "", name = ""] = header;
      // A stack's guard is a page or a few; a malloc arena's unused reserve is
      // inaccessible too, and tens of megabytes.
      const afterGuard =
        previousEnd === start && previousPerms.startsWith("---") && previousSizeKb <= 64;
      current = {
        ...EMPTY,
        name,
        category: categorize(name, afterGuard && perms.startsWith("rw"), binary),
        sizeKb: 0,
      };
      found.push(current);
      previousEnd = end;
      previousPerms = perms;
      previousSizeKb = (Number.parseInt(end, 16) - Number.parseInt(start, 16)) / 1024;
      continue;
    }
    const match = line.match(/^(\w+):\s+(\d+) kB/);
    if (!match || !current) continue;
    if (match[1] === "Size") current.sizeKb = Number(match[2]);
    const field = FIELDS.get(match[1] ?? "");
    if (field) current[field] = Number(match[2]);
  }
  return found;
}

export interface Group extends MemoryKb {
  name: string;
  count: number;
}

/** Sum mappings by `key`, largest resident first. */
export function groupBy(all: Mapping[], key: (mapping: Mapping) => string): Group[] {
  const groups = new Map<string, Group>();
  for (const mapping of all) {
    const name = key(mapping);
    const group = groups.get(name) ?? { ...EMPTY, name, count: 0 };
    add(group, mapping);
    group.count += 1;
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => b.pss - a.pss);
}

/** Thread count and the threads' names (`comm`), counted. */
export function threads(pid: number): { count: number; names: Record<string, number> } {
  const names: Record<string, number> = {};
  let count = 0;
  try {
    for (const task of readdirSync(`/proc/${pid}/task`)) {
      // A pool's threads differ by a number at the end; count them as one name.
      const name = (read(`/proc/${pid}/task/${task}/comm`) ?? "?").trim().replace(/[-_ ]?\d+$/, "");
      names[name] = (names[name] ?? 0) + 1;
      count += 1;
    }
  } catch {}
  return { count, names };
}

/**
 * CPU the process has used, in ms: its own (threads that ended included) and
 * with the children it waited for (`stat`'s tick counters, 10 ms steps).
 */
export function cpuMs(pid: number): { own: number; withChildren: number } | null {
  const fields = read(`/proc/${pid}/stat`)?.split(") ")[1]?.split(" ");
  if (!fields) return null;
  const tick = 10;
  const own = (Number(fields[11]) + Number(fields[12])) * tick;
  const children = (Number(fields[13]) + Number(fields[14])) * tick;
  return { own, withChildren: own + children };
}

/** Per thread: time on a CPU (ms) and voluntary context switches so far. */
export type Activity = Map<string, { runMs: number; wakeups: number }>;

/** What each live thread has done so far. */
export function activity(pid: number): Activity {
  const byThread: Activity = new Map();
  try {
    for (const task of readdirSync(`/proc/${pid}/task`)) {
      const runNs = Number(read(`/proc/${pid}/task/${task}/schedstat`)?.split(" ")[0] ?? 0);
      const status = read(`/proc/${pid}/task/${task}/status`) ?? "";
      const wakeups = Number(status.match(/voluntary_ctxt_switches:\s+(\d+)/)?.[1] ?? 0);
      byThread.set(task, { runMs: runNs / 1e6, wakeups });
    }
  } catch {}
  return byThread;
}

/**
 * CPU time and wakeups (a thread that slept and was woken) between two
 * readings, over the threads alive at both: precise enough to see an idle
 * process, and a thread that ended in between doesn't count backwards.
 */
export function activityBetween(
  before: Activity,
  after: Activity,
): { runMs: number; wakeups: number } {
  let runMs = 0;
  let wakeups = 0;
  for (const [task, now] of after) {
    const then = before.get(task);
    if (!then) continue;
    runMs += now.runMs - then.runMs;
    wakeups += now.wakeups - then.wakeups;
  }
  return { runMs, wakeups };
}

/**
 * GPU memory the process's DRM clients hold, in kB by kind (`drm-memory-*`
 * or `drm-total-*` in `fdinfo`), one count per client. It is not in the
 * process's RSS; on an integrated GPU it is system memory all the same.
 */
export function gpuMemoryKb(pid: number): Record<string, number> {
  const clients = new Map<string, Record<string, number>>();
  try {
    for (const fd of readdirSync(`/proc/${pid}/fdinfo`)) {
      const text = read(`/proc/${pid}/fdinfo/${fd}`) ?? "";
      const client = text.match(/^drm-client-id:\s+(\d+)/m)?.[1];
      const driver = text.match(/^drm-driver:\s+(\S+)/m)?.[1] ?? "drm";
      if (!client) continue;
      const kinds: Record<string, number> = {};
      for (const match of text.matchAll(/^drm-(?:memory|total)-(\w+):\s+(\d+) (KiB|MiB|B)?/gm)) {
        const scale = match[3] === "MiB" ? 1024 : match[3] === "KiB" ? 1 : 1 / 1024;
        kinds[match[1] ?? ""] = Number(match[2]) * scale;
      }
      clients.set(`${driver}:${client}`, kinds);
    }
  } catch {}
  const total: Record<string, number> = {};
  for (const kinds of clients.values()) {
    for (const [kind, kb] of Object.entries(kinds)) total[kind] = (total[kind] ?? 0) + kb;
  }
  return total;
}

/** The newest child of `parent` that runs the program at `path`. */
export function childRunning(parent: number, path: string): number | null {
  const pids = Bun.spawnSync(["pgrep", "-P", String(parent)])
    .stdout.toString()
    .split("\n");
  for (const text of pids.reverse()) {
    const pid = Number(text);
    if (pid > 0 && (read(`/proc/${pid}/cmdline`) ?? "").split("\0")[0] === path) return pid;
  }
  return null;
}
