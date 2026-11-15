/**
 * `@mirinjs/metal`'s scroll check, as one of the gates: `gates.ts` runs the
 * scripts of this directory by name, and the check lives beside what it
 * checks (`packages/mirin-metal/bench/scroll-check.tsx`, which says what it
 * does). It is run from its own package, whose JSX is React's, not this
 * one's.
 *
 *   bun bench/scroll-check.ts <host>
 */

import { resolve } from "node:path";

const metal = resolve(import.meta.dir, "../../mirin-metal");
const check = Bun.spawn([process.execPath, "bench/scroll-check.tsx", ...Bun.argv.slice(2)], {
  cwd: metal,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await check.exited);
