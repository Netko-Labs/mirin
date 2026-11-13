/**
 * The fewest moves that put a list in a new order: the items on a longest
 * increasing run of their old positions stay where they are, and each of
 * the others moves once. A swap of two rows far apart is two moves, where
 * React's commit places every row between them (`lib/tree-sync.ts`).
 */

/**
 * The values on one longest strictly increasing subsequence of `values`
 * (distinct numbers below `size`), marked 1 in an array of `size`, in
 * O(n log n). Of the longest, one that ends earliest in `values`: what
 * follows its end can go to the end of the list in order, a move with no
 * sibling to find (a reversed list is all such moves, as React sends it).
 */
export function longestIncreasing(values: ArrayLike<number>, size: number): Uint8Array {
  // tails[k]: the index in `values` of the smallest last value of a run of length k + 1.
  const tails: number[] = [];
  const previous = new Int32Array(values.length);
  // The length of the longest run ending at each index.
  const lengths = new Int32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as number;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((values[tails[middle] as number] as number) < value) low = middle + 1;
      else high = middle;
    }
    previous[index] = low > 0 ? (tails[low - 1] as number) : -1;
    lengths[index] = low + 1;
    tails[low] = index;
  }
  const kept = new Uint8Array(size);
  let at = lengths.indexOf(tails.length);
  while (at >= 0) {
    kept[values[at] as number] = 1;
    at = previous[at] as number;
  }
  return kept;
}
