import { describe, expect, test } from "bun:test";
import { longestIncreasing } from "../src/lib/order.ts";

/** The values `longestIncreasing` keeps, as a set. */
function kept(values: number[]): Set<number> {
  const marks = longestIncreasing(values, values.length === 0 ? 0 : Math.max(...values) + 1);
  return new Set(values.filter((value) => marks[value] === 1));
}

/** The length of a longest increasing subsequence, by the quadratic definition. */
function longest(values: number[]): number {
  const best = values.map(() => 1);
  for (let i = 0; i < values.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if ((values[j] as number) < (values[i] as number)) {
        best[i] = Math.max(best[i] as number, (best[j] as number) + 1);
      }
    }
  }
  return Math.max(0, ...best);
}

describe("longestIncreasing", () => {
  test("keeps all of a list in order, one of a reversed one, all but two of a swap", () => {
    expect(kept([])).toEqual(new Set());
    expect(kept([0, 1, 2, 3])).toEqual(new Set([0, 1, 2, 3]));
    expect(kept([3, 2, 1, 0]).size).toBe(1);
    expect(kept([0, 1, 8, 3, 4, 5, 6, 7, 2, 9])).toEqual(new Set([0, 1, 3, 4, 5, 6, 7, 9]));
  });

  test("finds a longest run, in order, for shuffled lists and gaps", () => {
    let seed = 11;
    for (let round = 0; round < 200; round += 1) {
      // Old positions with gaps (rows this commit removed).
      const values = Array.from({ length: round % 40 }, (_, index) => index * (1 + (round % 3)));
      for (let index = values.length - 1; index > 0; index -= 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const other = seed % (index + 1);
        [values[index], values[other]] = [values[other] as number, values[index] as number];
      }
      const stays = kept(values);
      expect(stays.size).toBe(longest(values));
      const run = values.filter((value) => stays.has(value));
      expect(run).toEqual([...run].sort((a, b) => a - b));
    }
  });
});
