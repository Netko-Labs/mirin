/**
 * What the driver holds: the heap after the example browser has started,
 * and after rounds of interactions (switching between examples, typing,
 * toggling the theme). A heap that keeps growing round after round is a
 * leak; the object types that grew are listed.
 */

import { heapStats } from "bun:jsc";
import { openBrowser, type Session } from "./session.tsx";

interface Snapshot {
  heapMb: number;
  objects: number;
  rssMb: number;
  types: Record<string, number>;
}

function snapshot(): Snapshot {
  Bun.gc(true);
  Bun.gc(true);
  const stats = heapStats();
  return {
    heapMb: stats.heapSize / 1e6,
    objects: stats.objectCount,
    rssMb: process.memoryUsage().rss / 1e6,
    types: stats.objectTypeCounts,
  };
}

const EXAMPLES = ["badge-demo", "button-demo", "card-demo", "table-demo", "tabs-demo"];
const QUERY = ["d", "dr", "dro", "drop", "dro", "dr", "d", ""];

async function interactions(session: Session, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const kind = index % 5;
    if (kind < 3) session.press(`example:${EXAMPLES[index % EXAMPLES.length]}`);
    else if (kind === 3) session.type("search", QUERY[index % QUERY.length] ?? "");
    else session.press("toggle-theme");
    await session.settle();
  }
}

function grown(before: Snapshot, after: Snapshot): string {
  return Object.entries(after.types)
    .map(([type, count]): [string, number] => [type, count - (before.types[type] ?? 0)])
    .filter(([, delta]) => delta > 20)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([type, delta]) => `${type} +${delta}`)
    .join(", ");
}

export async function memory(rounds: number, json: boolean): Promise<void> {
  const session = await openBrowser({ quietMs: 12 });
  await session.settle();
  const snapshots = [snapshot()];
  // Every example the rounds touch is loaded once first, so a round adds no modules.
  await interactions(session, 50);
  snapshots.push(snapshot());
  for (let round = 0; round < rounds; round += 1) {
    await interactions(session, 50);
    snapshots.push(snapshot());
  }
  // Left alone, the allocator gives freed pages back: what an app at rest holds.
  await Bun.sleep(6000);
  const restingRssMb = process.memoryUsage().rss / 1e6;
  if (json) {
    console.log(
      JSON.stringify({
        restingRssMb,
        snapshots: snapshots.map(({ types: _types, ...rest }) => rest),
      }),
    );
    return;
  }
  snapshots.forEach((shot, index) => {
    const label =
      index === 0
        ? "after start"
        : index === 1
          ? "50 interactions (examples loaded)"
          : `+${(index - 1) * 50}`;
    const previous = snapshots[index - 1];
    console.log(
      `${label.padEnd(34)} heap ${shot.heapMb.toFixed(2)} MB, ${shot.objects} objects, RSS ${shot.rssMb.toFixed(1)} MB${
        previous && index > 1
          ? `  (heap ${((shot.heapMb - previous.heapMb) * 1000).toFixed(0)} KB, objects ${shot.objects - previous.objects}${grown(previous, shot) ? `: ${grown(previous, shot)}` : ""})`
          : ""
      }`,
    );
  });
  console.log(`after 6 s at rest: RSS ${restingRssMb.toFixed(1)} MB`);
}
