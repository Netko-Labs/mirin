# sumi step 4 log (branch sumi-retained-frame)

## 2026-11-15 baseline (head a3778f2, ref/host-sumi3; out/sumi4/host-base-prof = same with --features profiling)

Stress, scale 1, one run each (machine a little busy):
- ref: select 2.2, type 1.5, hover 2.1, grow 2.0, grow/sc 2.4, select/sc 2.6, scroll 2.8, resize 2.4, hscroll 3.3; idle RSS 193, end 280 MB
- prof --low (p10 ms): select 1.60, type 0.85, hover 1.77, grow 1.34, scroll 2.26, grow/sc 1.82, select/sc 1.72, resize 1.81, hscroll 2.67
- instr (M, median): select 7.08, type 3.99, hover 7.17, grow 7.43, scroll 12.99, grow/sc 8.24, select/sc 8.26, resize 8.82, hscroll 9.01
- cycles (M): select 4.91, type 3.16, hover 5.78, grow 4.66, scroll 9.83, grow/sc 6.05, select/sc 5.28, resize 8.52, hscroll 10.26
Files: base-stress-1.txt, base-low-1.txt

## Profiles (base, 300 updates each, pprof 1 kHz): prof-base-{hover,select,type,grow,scroll,resize}.folded
tools/table.py prints the table that is in engine.md 3a. Trace (trace-base.log): hover/select = 3 built, 39 reused,
84 skipped; type = 1 reused; grow = 1 redrawn, 16 moved, 84 skipped. Window 1280x800 → 16 rows (400 cards) in view.

## Design (engine.md 3b): partial frames. Commit 0cf5d43 (signed) = profile + design + --hovers.

## Increment plan
- I0 host: Boundaries::sync without the pass over every boundary (apply 0.6 ms)
- I1 scene: op slots at finish; patch session; damage
- I2 frame lists write at a range (FrameVec), dispatch tree, text layouts
- I3 retained registry + context in records; strict bind; partial frame driver; host hooks (layout map, access, trace); host notifies own-dirty boundaries
- I4 wgpu: damage upload, bind groups kept
- I0 done: apply 0.7 -> 0.1 ms (select), gates 20/20 (host-i0). commit d4fd876 perf(metal): a patch's retained sync costs what the patch changed
- I1-I3 done (one commit): partial frames. host-i3f. instr (M): select 0.25, hover 0.26, select/sc 0.26 (were 7.08/7.17/8.26);
  type 4.00 (3.99), grow 7.52 (7.43), scroll 13.30 (12.99), grow/sc 8.39 (8.24), resize 9.00 (8.82), hscroll 9.31 (9.01):
  full frames +1..3% instructions -> to claw back (slots bookkeeping per primitive, registry, text key).
  low ms: select 0.25, hover 0.24, select/sc 0.36. RSS idle 194, end 281 (as before). Gates 20/20, tests 253.
  NOTE machine was swapping heavily around 10:45 (RSS numbers then were wrong: 66 MB); re-measure footprint when quiet.
- Next: I4 renderer damage (wgpu), claw back the full-frame %, engine.md 3c + README, more gates, a11y check, screenshots.
- I4 done: wgpu damage upload, commit c3339b3. shots/ pixel-identical to ref after partial frames (4 of 4, compare AE 0). host-i4a.

## Handover (2026-11-15, the parent session)

The agent was cut off by a rate limit while looking into typing. State:

- Typing is slower with partial frames. Interleaved under the bench lock,
  `stress.tsx --only=type,select,grow`, frame medians (ms), three runs:
  before step 4 (`a3778f2`) type 0.7, 1.2, 1.2; main (`5703b91`) 0.7, 1.1,
  0.7; this branch 1.2, 1.8, 1.7. Select 1.3–1.7 → 0.3. Grow 1.1–1.5 →
  1.4–1.7.
- By increment (two runs each): I0 type 1.1, 1.0; I1–I3 1.8, 1.1; I4 1.2,
  1.6; I5 1.4, 1.5. It appears with partial frames and is bimodal; the
  bench's `total` goes from 23 to 28 ms in the slow runs, as if a keystroke
  drew twice. The instruction count the agent recorded for type at I3 was
  unchanged (4.00 M against 3.99 M), so look for a second frame or time
  off the window thread, not more work in one frame.
- The commit after this log's last entry ("work in progress") holds the
  agent's unfinished edits: `Window::set_retained_version` returns whether
  the window knows the subtree and marks its view dirty, and the host
  draws from the root when it does not. It compiles and passes clippy; it
  was not tested, and a host built with it still types slowly.
- The gates pass on that build: 21 of 21 against the pre-step-4 host.
- Not done: the gates for what partial frames can newly break, the 1–3%
  more instructions on full frames, `engine.md` 3c, the footprint
  re-measured on a quiet machine, and a merge of main since `a41eac5`.
