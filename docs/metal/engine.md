# sumi: Metal's own engine

Status: **decided, under way** (2026-11-13; steps 1 to 3 done by
2026-11-15). Metal stops being "GPUI plus patches" and grows its own engine,
**sumi** (墨, the ink that goes on washi). This doc is its direction and
roadmap. `gpui-next.md` keeps the history of how Metal got onto upstream
GPUI, and `forks/sumi/README.md` says what is in the tree and how to build,
test and pick into it.

## Decisions

| Question | Decision |
| --- | --- |
| Track upstream GPUI or own the code? | **Own it.** One last sync with Zed, then a hard fork. Fixes from upstream are picked by hand, not merged. |
| Upstream PRs to Zed | **None.** Nothing in the roadmap waits on Zed. |
| Platforms | **Linux (Wayland, Dashi first), macOS, Windows.** iOS, Android and the web are out. |
| Native components | **Later, macOS only**, on NativeGPUI's model (section 5), after the core is ours. On Dashi and Windows the drawn `@mirinjs/metal-ui` components are the native ones. |
| Shape of the engine | **Minimal and retained.** It keeps only what Metal calls, and the frame is built around what changed (section 3). |

## 1. Where we are

Metal draws with sumi, `forks/sumi`: the GPUI crates of the zed repository
as they were at `703b5ac3` (2026-11-14, the last commit merged from Zed),
since moved, renamed and cut to what Metal calls (step 3, 2026-11-15). With
it go `forks/taffy-next` (taffy 0.15) and two small forks for a small app's
GPU memory (`forks/wgpu`, wgpu-hal alone, and `forks/gpu-allocator`), which
still follow their upstreams. What mirin changed against Zed up to the fork
point is `forks/sumi/MIRIN.md`, a closed record; what changed since is in
git, and what is taken from Zed from here is a row in `forks/sumi/PICKS.md`.

Until step 1 (2026-11-14) it built on forks of the crates.io release gpui
0.2.2, which Dashi 0.9 ships. That was a dead end: one crate with every
platform inside, a renderer upstream dropped, no releases since. Upstream
is split the way an engine should be: a core with no platform code, one
crate per platform, shared renderers (`gpui_wgpu` for Linux, `gpui_apple`'s
Metal renderer for macOS). sumi started from it.

mirin-metal calls the engine as it is: `src/gpui_api.rs`, the shapes its
code was written against on the 0.2.2 fork, was folded away at step 3
(section 7 says where each item went).

## 2. What sumi is

**A retained, GPU-drawn UI engine for one client: mirin Metal's host.**
Not a general GPUI. Its users are the patch protocol and `@mirinjs/metal`,
not Rust app authors, so its API can change whenever the host changes.

Principles:

1. **Retained by default.** A frame redraws and relays out only what
   changed. Today retention is patches in upstream's immediate-mode frame
   (the mask map, the device grid, element state scopes, the persistent
   layout tree, about 5,000 lines in `window.rs`, `taffy.rs`, `scene.rs`
   and `bounds_tree.rs`). In sumi it is the frame.
2. **Only what Metal calls.** Metal uses elements, styles, text, lists,
   scroll handles, focus and windows. It uses none of actions and keymaps,
   the inspector, `http_client`, hot reload, the profiler UI, screen
   capture or `gpui_tokio`. What it doesn't call goes, measured (binary
   size, RSS, first frame) before and after. Step 3 did the first round
   (section 7); the weight turned out to be in what the Linux platform
   linked for an editor (a keyring, portals, a regex engine, a second
   accessibility stack, image codecs), not in the core.
3. **Budgets, not hopes.** Every change that touches the frame runs the
   stress bench and the counter footprint against the last release host.
   The budgets in section 6 are the bar. A change that breaks one doesn't
   land.
4. **Dashi is the first platform, not the only one.** Dashi's own Wayland
   protocol (the unified title bar, `dashi-chrome-v1`) sits in one `dashi`
   module of `sumi-linux` behind a `dashi` feature, so a plain Linux, macOS
   or Windows app builds without it. Layer surfaces (wlr-layer-shell),
   session lock (ext-session-lock-v1) and file drags (wl_data_device) are
   not Dashi's: any compositor with those protocols serves them, and they
   are unconditional.
5. **Platform crates stay boring.** We barely change macOS and Windows.
   They stay close to upstream so picking its fixes stays cheap.

### Crates

As they are in `forks/sumi/crates` since step 3 (a package is named with
`-`, its library with `_`):

| Crate | From | What changes |
| --- | --- | --- |
| `sumi` | `gpui` | Retention becomes the frame (step 4). The persistent layout tree is the only layout tree. The inspector, hot reload, screen capture and `http_client` are gone; actions and keymaps stay until step 4 (section 7). |
| `sumi-macros` | `gpui_macros` | The derive and attribute macros, without the bench and inspector ones. |
| `sumi-util`, `sumi-shared-string` | `gpui_util`, `gpui_shared_string` | Unchanged. |
| `sumi-wgpu` | `gpui_wgpu` | Vulkan on Linux. Our memory and startup work (2 MiB blocks, pipelines on first use, no indirect validation) is in it. No web arm. |
| `sumi-apple` | `gpui_apple` | The Metal renderer and CoreText, for macOS. |
| `sumi-linux` | `gpui_linux` | Wayland first, X11 behind its feature. `dashi` module and feature. No keyring, notifications, file-chooser or OpenURI portal, and no accessibility adapter of its own (Metal publishes its tree). |
| `sumi-macos`, `sumi-windows` | `gpui_macos`, `gpui_windows` | Close to upstream. |
| `sumi-platform` | `gpui_platform` | Picks one of the three. |
| `collections`, `refineable` (with `derive_refineable`), `sum_tree`, `scheduler` | the same | Keep their names and stay crates of their own. This table once had them fold into `sumi`; they are small and general, and folding or renaming them would be churn without a gain. |

Out, and removed at step 3: `gpui_ios`, `gpui_web`, `http_client`,
`bench_metrics`, `ztracing` and `ztracing_macro` (the `mirin::startup` log
and `log` serve instead). `gpui_tokio` was never imported.

`forks/taffy-next` and the three AccessKit forks stay forks of their
libraries: they are small and have releases.

Every sumi crate keeps Zed's Apache-2.0 license and notice; our code in
them is under the same terms.

### Taking from upstream after the fork

About monthly, someone reads Zed's log for the crates sumi came from and
picks what fixes a bug we can hit or a platform change (a new macOS, a
Windows API, a Wayland protocol). Most of the value is in the platform
crates, which is why they stay close. Each pick is a row in
`forks/sumi/PICKS.md`: upstream commit, what it fixes, where it landed.

## 3. Restructuring the frame

What sumi's frame does, in order:

1. **Apply patches** from the protocol to the element tree. Each touched
   node marks itself and its ancestors dirty, with what kind of change
   (paint, layout, children).
2. **Lay out** dirty subtrees on the persistent taffy tree. Clean
   subtrees keep their nodes and answers; a moved subtree moves.
3. **Paint** dirty subtrees into their own scene ranges. Clean subtrees
   keep their primitives; a moved subtree's are offset, a hidden one's
   parked.
4. **Hit-test and access** from the same retained tree: the bounds tree,
   the mask map and the `access/` tree update for dirty subtrees only.
5. **Submit** the scene. The renderer uploads only changed ranges.

Upstream's element `request_layout` / `prepaint` / `paint` stays as the
way a node draws itself; what changes is that the window owns a retained
tree and calls it for dirty nodes, instead of rebuilding the tree each
frame and asking caches whether to skip.

What it should fix: select in a scroll view (the one bench still behind),
the last tenths of a millisecond on a keystroke, and the two trees
accessibility keeps today.

## 4. Order of work

| Step | What | Effort |
| --- | --- | --- |
| 1 | **Switch to upstream.** Done 2026-11-14: select in a scroll view, the footprint at 1.5 and layouts at other scales closed; `forks/gpui`, `forks/taffy`, `forks/blade-graphics` and the second build deleted. | done |
| 2 | **Last sync** to Zed `main`. Done 2026-11-14, at `703b5ac3`: upstream's reworked renderer (a depth buffer and an opaque pass, batching by kind, paths as tiles, Levien's shadows) with every mirin row on it; section 6 has what it cost and what it didn't. | done |
| 3 | **Become sumi.** Done 2026-11-15: the crates moved to `forks/sumi/` and renamed, the out-of-scope crates dropped, what Metal never reaches removed and measured (the release host is 32.9 MB where it was 46.1), Dashi's protocol behind `dashi`, `src/gpui_api.rs` folded away. Section 7 has the table and what was left in. | done |
| 4 | **The retained frame** (section 3). | 1–2 weeks |
| 5 | **Native slots** (section 5): the engine's `NativeSlot`, the protocol's `native` node, drawn fallbacks everywhere. | about a week |
| 6 | **AppKit host.** | 1–2 weeks, needs a Mac |

Steps 1 to 4 are verifiable here on Linux. Dashi 0.9 ships the 0.2.2
build; the switch reaches Dashi in the release after it.

## 5. Native components (macOS, later)

[NativeGPUI](https://github.com/Cafekery/NativeGPUI) (MIT, macOS 26)
shows the model: **the engine owns layout; the OS owns the pixels.**

- **Engine:** a `NativeSlot` element takes a place in layout like any
  other and reports its bounds, clip and visibility each frame.
  `PlatformWindow::native_host()` is optional; only `sumi-macos` has one.
- **macOS:** a host keeps an `NSView` per slot above or below the GPU
  view and carries values and events across. We port NativeGPUI's
  approach, not depend on it: it targets GPUI's API and macOS 26 only,
  and its seven `gpui_macos` patches are ones `sumi-macos` takes as its
  own.
- **React:** a `native` node kind in the patch protocol. Components such
  as `<NativeButton>` in `@mirinjs/metal` fall back to the drawn
  metal-ui component wherever there is no host, so the same app gets
  AppKit controls on macOS and Dashi's on Dashi. The API needs the
  owner's sign-off (`docs/api-design.md`) before step 5.
- **Limits:** a native view above the GPU view isn't clipped by drawn
  content, so scroll clipping and popovers need the host's care; a
  retained subtree that moves moves its native views; a native view
  brings its own accessibility.

## 6. Budgets

Measured with `runbench.sh` (stress bench, frame medians of two runs at
scale 1) and `footprint.tsx` (counter app). Each budget is the better of
the two hosts built for Dashi 0.9 (`host-09`, the default build, and
`host-next-09`, the upstream one), so moving to upstream may not cost what
the fork already won:

| Measure | host-09 | host-next-09 | Budget |
| --- | --- | --- | --- |
| select, type, hover (ms) | 2.05, 1.05, 2.1 | 2.05, 1.55, 2.25 | 2.05, 1.05, 2.1 |
| grow, scroll, resize (ms) | 3.2, 2.3, 2.45 | 1.75, 2.8, 2.2 | 1.75, 2.3, 2.2 |
| select in a scroll view (ms) | 2.55 (host-r5) | 3.35 | 2.55 |
| grow in a scroll view (ms) | 3.55 (`host-main`) | 2.95 (`host-next-main`) | 2.95 |
| scroll across (ms) | 2.4 (`host-main`) | 2.9 (`host-next-main`) | 2.4 |
| stress app RSS at idle | 202 MB | 195 MB | 195 MB |
| counter: RSS, GPU memory, first frame | 59 MB, 14 MB, 33 ms | 68 MB, 32 MB, 40 ms (round 5) | 59 MB, 14 MB, 33 ms |

Grow in a scroll view and scroll across were measured at the start of step
1 on the hosts built at its base (`host-main`, the default build, and
`host-next-main`, the upstream one; medians of two runs, 2026-11-14) and
joined the table then. Step 1 is done when the upstream host meets every
budget within noise (0.2 ms, 3 MB). Later steps lower them; when a step
does, the table moves with it.

**Step 1, frame time (`sumi-frame`).** The upstream host with the frame
lane's changes (`gpui-next.md`, "State, what is left, and the default"),
beside the two hosts at the base, the same day on a quiet machine, medians
of two interleaved runs:

| Frame (ms) | `sumi-frame` | `host-next-main` | `host-main` |
| --- | --- | --- | --- |
| select, type, hover | 1.6, 1.0, 1.75 | 1.9, 1.4, 2.15 | 1.85, 1.0, 1.95 |
| grow, scroll, resize | 1.45, 2.65, 1.8 | 1.95, 3.05, 2.0 | 3.3, 2.55, 2.3 |
| select in a scroll view | 1.65 | 3.1 | 2.2 |
| grow in a scroll view, scroll across | 1.7, 2.35 | 2.95, 2.9 | 3.55, 2.4 |
| stress RSS at idle, at the end | 194, 282 MB | 193, 280 MB | 203, 312 MB |

It meets every frame budget but scroll, which is at the default build's
that day (2.65 against 2.55, within noise) and 0.35 ms over the 2.3 the
table took from an earlier session.

Step 1's footprint lane (`sumi-footprint`, `gpui-next.md`, "sumi step 1: a
small app's footprint, and other scale factors") measured the footprint
rows again on the hosts at step 1's base, and the one the table lacked, the
stress app at 1.5:

| Measure | default build (`host-main`) | upstream at the base (`host-next-main`) | upstream after the lane | Budget |
| --- | --- | --- | --- | --- |
| counter RSS | 59.7 MB | 67.3 MB | 64.9 MB | 59 MB |
| counter GPU memory | 13.8 MB | 31.8 MB | 16.2 MB | 14 MB |
| counter first frame | 30–34 ms | 35–40 ms | 30–33 ms | 33 ms |
| stress app RSS at idle, at 1 | 197 MB | 188–192 MB | 185–187 MB | 195 MB |
| stress app RSS at idle, at 1.5 | 211–213 MB | 228–233 MB | 196–202 MB | 215 MB |

The counter's RSS is the one still over by more than noise: the binary's
size and 1.7 MB of heap.

**After the switch (2026-11-14).** The one host Metal now builds
(`host-sumi1`, both lanes merged) beside the 0.2.2 build at step 1's base
(`host-main`), interleaved on a quiet machine, medians of two runs:

| Measure | sumi | 0.2.2 build | Budget |
| --- | --- | --- | --- |
| select, type, hover (ms) | 1.65, 1.1, 1.85 | 1.8, 0.95, 1.9 | 2.05, 1.05, 2.1 |
| grow, scroll, resize (ms) | 1.5, 2.45, 1.8 | 3.2, 2.4, 2.3 | 1.75, 2.3, 2.2 |
| select, grow in a scroll view (ms) | 1.8, 1.65 | 2.05, 3.5 | 2.55, 2.95 |
| scroll across (ms) | 2.2 | 2.2 | 2.4 |
| stress RSS at idle, at the end | 193, 280 MB | 203, 312 MB | 195 MB |
| at 1.5: grow, scroll, RSS at idle | 1.6 ms, 2.8 ms, 204 MB | 6.6 ms, 2.7 ms, 216 MB | 215 MB |
| counter: RSS, GPU memory, first frame | 65.6 MB, 16.2 MB, 30–34 ms | 59.6 MB, 13.8 MB, 34–35 ms | 59 MB, 14 MB, 33 ms |

Every budget is met within noise (0.2 ms, 3 MB) but the counter's RSS,
6 MB over: the larger binary (24 MB of code against 18) and 2 MB of heap.
It is the first thing step 3 measures, since removing what Metal never
calls is what shrinks the binary. From here the budgets are this table's
sumi column, with the counter's RSS held at 59 MB as the target.

Layouts and drawings: identical to the upstream build before the switch
(`grid`, `browser`, `scroll`, `scroll-fractional`, with `--scene`);
retained against `MIRIN_METAL_RETAIN=0` identical at 1 and 1.5 (those and
`across`); against the 0.2.2 build, the known `browser` card and hover
lines only. `MIRIN_METAL_ACCESS_CHECK=1` over the stress bench: no
complaints. Not checked: Dashi's layer surfaces, session lock and file
drag on a real session with this engine (`gpui-next.md`, step 4's half
day by hand); Dashi takes this engine only after that.

**After the last sync (2026-11-14).** The host at Zed `703b5ac3`
(`forks/sumi/MIRIN.md` has what changed shape) beside `host-sumi1`,
interleaved, medians of two runs; the machine was shared that evening, so
the last column is the frame's instructions on the window's thread
(`--features profiling`, `stress.tsx --low`), which load does not move,
against the host before the sync:

| Measure | after the sync | `host-sumi1` | instructions, after / before (M) |
| --- | --- | --- | --- |
| select, type, hover (ms) | 1.7, 1.0, 1.95 | 1.65, 1.05, 1.9 | 7.04 / 7.16, 3.91 / 3.97, 7.10 / 7.22 |
| grow, scroll, resize (ms) | 1.6, 2.95, 2.15 | 1.5, 2.6, 1.95 | 7.36 / 7.62, 13.03 / 12.87, 8.25 / 8.89 |
| select, grow in a scroll view (ms) | 1.85, 1.65 | 1.8, 1.7 | 8.21 / 8.23, 8.21 / 8.73 |
| scroll across (ms) | 2.4 | 2.3 | 8.95 / 9.07 |
| stress RSS at idle, at the end | 194–195, 279–280 MB | 192, 279–281 MB | |
| at 1.5: grow, scroll, RSS at idle | 1.7 ms, 3.1 ms, 205 MB | 1.5 ms, 2.6 ms, 205 MB | |
| counter: RSS, GPU memory, first frame | 65.3 MB, 16.2 MB, 28–33 ms | 65.1 MB, 16.2 MB, 27–28 ms | |

Two rows were over by more than noise that evening, and were settled the
next day on a quiet machine against main with the sync's checker
(`host-main2`):

- **Scroll and scroll across.** By the clock, scroll read 0.3 ms dearer
  and scroll across 0.25 to 0.5 in some sessions and level in others (a
  48-frame median moves by 0.3 ms from one session to the next). Over
  200-frame scrolls, three interleaved runs each, they are level: scroll
  3.1 ms against 3.1, scroll across 2.4 against 2.5, with fewer
  instructions (14.06 M against 14.48, 9.04 M against 9.36) and the cycles
  within what the runs differ by (scroll across 8.25 M against 7.92).
  A profile of 600 frames of scroll across has the same samples inside the
  frame on both (3,190 against 3,207). The frame the bench times ends
  where painting does, so the renderer's new passes are not in it, and a
  host that never uses a depth buffer scrolls no faster. Nothing was found
  to fix but the bounds a primitive shows in, which the copy asked for
  through a call (inlined).
- **The counter's GPU memory** was 4 MB up (20.3 MB): upstream's depth
  buffer, 1.9 MB at 800 by 600, did not fit what was left of the first
  2 MiB block and took a 4 MiB one. A window now gets its depth buffer with
  the first frame that has 128 quads (`forks/sumi/MIRIN.md`): the counter
  is at 16.2 MB again, as before the sync, and builds one pipeline fewer
  before its first frame. The other ways were dearer or did less: an
  allocation of its own for the depth buffer still adds its 1.9 MB
  (18.1 MB); a first block it fits in is 4 MiB for every app; 16 bits of
  depth still do not fit the first block beside the atlas and are too few
  for a frame of more than 65,535 quads, each of which has a depth of its
  own.

What the sync did cost, and what was done about it, is in
`forks/sumi/MIRIN.md`: upstream's split of every rounded quad into five
primitives made every frame of the stress bench 3.5 M instructions dearer
until small quads were drawn whole again, and a copied line's glyphs took a
deferred way into their lists until only nested layers did.

Layouts: identical to `host-sumi1` (`grid`, `browser`, `scroll`,
`scroll-fractional`). Drawings differ from it by upstream's design, so the
check is the host against itself with `MIRIN_METAL_RETAIN=0` and `--scene`:
identical at 1, 1.25 and 1.5 (those four and `across`): 19 checks of 19
with `bench/gates.ts`, whose hosts are driven by `settle` and hear no real
pointer (the evening of the sync three of them could not be got clean with
the script before it, because one host of a pair heard a hover the other
did not).
`MIRIN_METAL_ACCESS_CHECK=1` over the stress bench: no complaints.
Screenshots of the example browser (a card, a scroll area, a popover, a
menu, a dialog, a hover card, typography) and of the stress app with
shadows, in the window and scrolled, differ from `host-sumi1`'s only in
what the pointer hovers; the counter and a small dashboard, drawn without
a depth buffer, are the pixels they were with one. macOS and Windows were
not built here.

**After becoming sumi (2026-11-15).** The host at the end of step 3
(`host-a11y` in section 7's table) beside the host before it (`host-sync2`),
interleaved, medians of three runs of the stress bench and of two rounds of
three counter starts. The machine was busier than on the days above, for
both hosts alike:

| Measure | sumi after step 3 | before (`host-sync2`) |
| --- | --- | --- |
| select, type, hover (ms) | 2.1, 1.4, 2.2 | 2.1, 1.5, 2.2 |
| grow, scroll, resize (ms) | 2.0, 3.1, 2.2 | 2.0, 3.1, 2.0 |
| select, grow in a scroll view (ms) | 2.5, 2.2 | 2.4, 2.3 |
| scroll across (ms) | 3.2 | 3.1 |
| stress RSS at idle, at the end | 188–192, 277–278 MB | 191–192, 279–280 MB |
| counter: RSS, GPU memory, first frame | 63.3 MB, 16.2 MB, 31–35 ms | 65.5 MB, 16.2 MB, 33–38 ms |

Nothing is slower beyond noise (0.2 ms, 3 MB); step 3 changed no code a
frame runs. The counter's RSS is 2.2 MB down and still 4 MB over the 59 MB
target, which stays. Section 7 says where the rest is.

## 7. Step 3: what was removed, and what it bought

Step 3 (2026-11-15) made the engine sumi: the crates moved to
`forks/sumi/crates` under their own names, the crates out of scope were
dropped, what Metal never reaches was removed with a measurement after each
removal that changed the binary, Dashi's protocol went behind a feature and
the shim over the engine was folded away.

**Where the weight was.** Candidates came from the release host's symbol
table (code size by crate, `nm --size-sort`) against what
`crates/mirin-metal` calls on the platform (the clipboard, focus, window
controls, displays and key dispatch; no dialog, URL, credential,
notification or appearance call). The core was never the weight: all of
`sumi` is 1.0 MB of code, and actions, keymaps and key dispatch together
24 KB. The weight was in what the Linux platform linked for an editor and
never started for a Metal app: `zvariant` and `zbus` 5.2 MB (most of it
generated for the keyring and the portals), `regex` 0.6 MB for one
character class, a second AccessKit stack, and image codecs.

Each row is a commit. Sizes are the release host's (`lto = "thin"`, not
stripped); the counter's RSS is the median of two rounds of three starts
(`footprint.tsx`), the stress app's idle RSS one run (`stress.tsx
--only=idle`). GPU memory was 16.2 MB and the first frame 29 to 38 ms on
every row, the spread of one host's own starts.

| After | File (bytes) | Code, `.text` (bytes) | Counter RSS | Stress idle RSS |
| --- | --- | --- | --- | --- |
| Before (`host-sync2`, main at step 2) | 46,074,528 | 25,475,138 | 65.5 MB | 192 MB |
| The move and rename | 46,068,984 | 25,475,298 | | |
| iOS, the web, `http_client`, `bench_metrics`, `ztracing` dropped | 45,962,912 | 25,427,650 | 65.5 MB | 192 MB |
| Image formats: PNG, JPEG, GIF, WebP, BMP, ICO (and SVG); no DDS, EXR, farbfeld, HDR, PNM, QOI, TGA, TIFF | 44,233,224 | 24,447,858 | 65.3 MB | 192 MB |
| No keyring (`oo7`) and no system notifications (`notify-rust`) on Linux | 38,213,720 | 20,631,682 | 63.9 MB | 191 MB |
| Of the portals, only settings: no file chooser, OpenURI or inhibit | 37,543,152 | 20,264,434 | 63.4 MB | 190 MB |
| The emoji-presentation check is a table, not a `regex` | 35,322,248 | 19,463,138 | 63.0 MB | 190 MB |
| The inspector, hot reload and screen capture (behind features nothing enabled; the inspector also in debug builds), then the `dashi` feature and the shim | 35,316,928 | 19,451,570 | 62.8 MB | 191 MB |
| No AccessKit adapter of the engine's own on Linux | 32,898,176 | 17,950,594 | 63.3 MB | 190 MB |
| The same without the `dashi` feature | 32,815,280 | 17,945,698 | 62.9 MB | |

The host is 13.2 MB smaller (29%) and has 7.5 MB less code. The counter's
RSS followed by 2.2 MB, not by 13: of the binary, 21.0 MB was resident
before and 18.2 to 18.7 MB is now, of a file of 33 MB. Most of that is code
no Metal app runs, mapped because the kernel maps a file in the page cache
around each fault in large pieces, so the resident share shrinks more
slowly than the file. The last three rows differ by less than one host's
runs do (0.3 MB). What is left to take, largest first: `naga` (1.3 MB, the
shader compiler, needed while shaders are compiled at start), `zbus` and
`zvariant` (1.6 MB, now for Metal's accessibility tree, the settings portal
and the sleep and power listeners), `wgpu-core` and `wgpu-hal` (1.1 MB),
SVG text (`rustybuzz`, `fontdb`, 0.5 MB) and X11 (0.3 MB). The 59 MB target
needs another way than removal: how the binary is laid out and mapped (code
that runs kept together, the rest never touched), which is a build
question, not an engine one.

**Stripped.** The sizes above are of unstripped builds, and so is "13.2 MB
smaller": both ends of that table are sumi. A package ships the host
stripped, and beside the engine before sumi (blade) the stripped host is not
smaller at all. Release builds on one machine, `strip` 2.46:

| Host | Unstripped (bytes) | Stripped (bytes) | Code, `.text` | `.rodata` |
| --- | --- | --- | --- | --- |
| Before sumi (`host-main`, the 0.2.2 build at step 1's base) | 33,556,464 | 25,511,592 | 19,069,794 | 1,715,144 |
| sumi before step 3 (`host-sync2`) | 46,074,528 | 34,990,728 | 25,475,138 | 2,721,656 |
| sumi, `main` at `a3778f2` (2026-11-15) | 33,682,480 | 25,594,248 | 18,421,010 | 2,160,288 |

So step 3 took 9.4 MB off the stripped host, and what ships is 0.08 MB
(0.3%) larger than the host before sumi: 0.65 MB less code, 0.45 MB more
read-only data, 0.26 MB more unwind tables and relocations. Dashi's
package measured 26.5 MB against 25.5 MB with its own build flags; the
order is the same. The 8 MB between unstripped and stripped is the symbol
table; there is no debug info in either.

**An idle host against the engine before sumi (2026-11-15).** Dashi saw
about 4 MB more RSS a host at rest (six shell hosts, 156.7 MB to 179.3 MB).
Measured here on radv: each host in turn in one nested compositor, a layer
surface with a line of text (a shell host) and a deferred host that never
opens (a host kept warm), `/proc/<pid>/smaps` six seconds after the start,
three rounds interleaved under the bench lock, medians, MB:

| | Before sumi | `main` | Difference |
| --- | --- | --- | --- |
| With a surface: RSS | 61.4 | 65.4 | +4.0 |
| – anonymous (heap and `mmap`) | 8.3 | 10.1 | +1.8 |
| – the host's own file, code | 14.1 | 15.5 | +1.4 |
| – the host's own file, read-only data | 3.0 | 3.9 | +0.9 |
| – every other library (LLVM 24.7, the driver, glibc, …) | 36.0 | 35.9 | −0.1 |
| Kept warm, no window: RSS | 53.7 | 58.9 | +5.3 |
| – anonymous | 7.0 | 9.3 | +2.3 |

Two things, then. **The file** is 2.3 MB of it: more of the host's own code
and read-only data is resident (naga and wgpu-core against blade's thinner
layer), though the file is the same size. Those pages are the page cache's:
every host of one binary shares them, so six hosts pay them once, and the
kernel takes them back under pressure. Their count also moves by a
megabyte from one start to the next with nothing changed. **Anonymous
memory** is the part each host really pays, 1.8 to 2.3 MB more, and it is
all in one place: a 2.7 MB malloc arena of the background thread that
prepares the GPU context (`wgpu_prepare.rs`), where the device and the
parsed shaders are allocated, against a main heap 1.1 MB smaller.

Is it the prepared GPU context? In part. With the preparation switched off
(a build with an environment switch, for this measurement only) a host with
a surface holds 1.6 MB less (65.2 to 63.7 MB; anonymous 10.1 to 8.9): the
same objects are then allocated on the main thread, in the heap everything
else reuses. A host kept warm without it is 18 MB, since it has loaded no
driver, which is the 40 MB a warm host exists to have ready. The
preparation stays: it is 20 ms of a start.

What was cheap, and is done: **the subpixel shaders are parsed ahead only
for a host that asked for subpixel text** (`MIRIN_METAL_TEXT=subpixel`).
Every host parsed both shader sets as it started and kept both modules for
as long as it lived, and a host that draws text in grays, which is the
default, never used the second. Without it a host holds 1.05 MB less
anonymous memory, with a surface (10.10 to 9.05 MB) and kept warm (9.30 to
8.25), in every one of three interleaved rounds, and spends 4 ms less of a
background thread at each start; a subpixel host parses them ahead as
before, and a subpixel pipeline in a host that did not ask parses them when
it is first made. With one binary and the switch alone, RSS went from 64.8
to 63.6 MB with a surface and from 58.8 to 57.9 kept warm.

What is left, 0.7 to 1.3 MB of anonymous memory a host over the engine
before sumi, is the device and the first shader module in that thread's
arena. `GLIBC_TUNABLES=glibc.malloc.arena_max=1` in a host's environment
puts them in the main heap and gives back another 0.5 to 0.6 MB (8.55 MB
with a surface, 7.62 kept warm, against 8.3 and 7.0 before sumi). It is
not set by the host: one arena means every thread's allocations take one
lock, and nobody has measured a frame with it. A launcher that wants the
memory can set it for its hosts, and should measure first.

**What a removal means for an app.**

- An image in a dropped format fails to decode, as an unknown file does.
- On Linux the engine's `write_credentials`, `read_credentials` and
  `delete_credentials` answer with an error, `prompt_for_paths` and
  `prompt_for_new_path` with an error, `prevent_idle_sleep` with an error,
  and a notification is the trait's no-op. A URI or a path is opened with
  the system's opener (xdg-open and its kin, upstream's first choice)
  without the OpenURI portal behind it. Metal called none of them; dialogs
  and notifications come to Metal through mirin's own feature modules
  (`docs/metal.md`, M4). The `Platform` trait keeps the methods, so macOS
  and Windows are as they were.
- An image is loaded from a path, an embedded asset or bytes, never a URL.
- The engine publishes no accessibility tree on Linux; Metal's own
  (`src/access/`) is the one a screen reader gets, as before.

**Left in, and why.**

- **Actions and keymaps.** 7 KB of code, and woven into what Metal uses:
  the dispatch tree that carries key events and focus is built from key
  contexts and action listeners, and `Window::dispatch_keystroke` goes
  through the keymap. Taking them out is rewriting dispatch, which is step
  4's.
- **The sleep and power-mode listeners.** The engine uses them: a window
  draws less often in low-power mode and refreshes after a wake.
- **The settings portal** (`ashpd`, with that feature alone): a Wayland
  window's cursor theme and size, the button layout and the appearance come
  from it.
- **The profiler** (`sumi/src/profiler*`, 8,000 lines behind the `profiler`
  feature, which nothing enables): it is in no binary, and the platform
  dispatchers of all three platforms report to its always-built part. Not
  touched without a macOS and a Windows build at hand.
- **The randomized element tree and the seed harness**: test-only, in no
  binary.
- **`InspectorElementId`**, as an empty type: `Element`'s three methods keep
  the parameter so an element picked from Zed needs no change.
- **The WebGL instance-data path of `sumi-wgpu`**: dead now that there is no
  web target (its switch is `cfg!(target_family = "wasm")`), a few KB, left
  for the renderer's next change.
- **iOS conditions in `sumi-apple`**: the crate is not built here.
- **SVG text, X11, the GL fallback**: an app can meet each.

**The `dashi` feature.** `sumi-linux`'s `dashi` module
(`src/linux/wayland/dashi.rs`, with the protocol's bindings in
`dashi/chrome.rs`) holds what is Dashi's own: the unified title bar
(`dashi-chrome-v1`), its global, its object and its events. `sumi-platform`
passes the feature on and `crates/mirin-metal` enables it by default.
Without it the module is two types that are never made, so the Wayland
client and window need no condition; nothing is bound, a window that asks
for a transparent title bar keeps the compositor's (xdg-decoration) and
`chrome_controls` answers `None`: what any compositor but Dashi gives
today. Checked in the nested Dashi compositor: the default host hears
`controls` (76 by 38), the host without the feature keeps the standard
title bar. Both builds pass clippy, the tests and the gates, and CI's
`metal` job builds and tests both on Linux.

**Where the shim went.** `src/gpui_api.rs` is gone:

| Was | Now |
| --- | --- |
| `focus`, `draw`, `update`, `keep_running_without_windows`, `on_window_closed`, `on_wheel` and `ScrollWheelEvent`, `paint_line`, `box_shadow`, `stretchable`, `prewarm_fonts`, `observe_visibility` | The engine's own calls at the call sites: `window.focus`, `window.draw(cx).clear(cx)`, `cx.update`, `cx.set_quit_mode(QuitMode::Explicit)`, `cx.on_window_closed`, `.on_scroll` and `ScrollEvent`, `ShapedLine::paint`, a `BoxShadow`, `Retained::stretchable`, `TextSystem::prewarm_fonts`, `window.observe_window_visibility` |
| `scroll_max`, `list_scroll_max` | `ScrollHandle::max_offset` and `ListState::max_offset_for_scrollbar`, points read by axis |
| `LayerShellOptions`, `LayerAnchor`, `LayerMargin`, `Layer`, `KeyboardInteractivity`, `with_surface` | `surface.rs`, which parses them: `LayerSurface`, `LayerAnchor`, `LayerMargin`, the engine's `Layer` and `KeyboardInteractivity` (stand-ins off Linux, where the engine has no layer shell), `with_role` |
| `application` | `drive.rs`, its only caller |
| `parse_keystroke` | `sim.rs`, its only caller |
| `set_scroll_snap` | Removed: sumi always paints scroll views at whole device pixels, and `MIRIN_METAL_SCROLL_SNAP` is no longer read |

**Checked.** Gates 19 of 19 against `host-sync2` after the rename alone and
after every commit that touched the engine, and for the host without
`dashi`. `crates/mirin-metal`: `cargo fmt --check`, clippy and the tests
(239 and 9) with and without `dashi`. `MIRIN_METAL_ACCESS_CHECK=1` over the
stress bench: no complaints. Timing and footprint: section 6.

**Not checked.** macOS and Windows were not built: the machine has the
distribution's toolchain with the Linux target alone (no rustup, no Apple
or Windows `std`), so `cargo check --target` cannot start. What was done
instead: the dependency graph resolves for `aarch64-apple-darwin` and
`x86_64-pc-windows-msvc` from the lockfile; every file of `sumi-macos`,
`sumi-windows` and `sumi-apple` parses (`cargo fmt --all`); no old crate
name, removed item or removed feature is left in them (searched); and their
changes are the rename, import order, the `bench-support` atom out of their
conditions, and the screen capture module and methods. CI's `metal` job
builds macOS; nothing builds Windows, so `sumi-windows` is the crate most
likely to hold a mistake. The unit tests inside sumi's crates were not run
at this step; section 8 has what it took to run them.

## 8. The checks nobody had run

Dashi moved onto sumi with four checks open. What each turned out to be:

**sumi's own unit tests.** They did not build from `forks/sumi`, for four
reasons, none of them Zed's workspace as such:

- its manifest did not patch taffy to mirin's fork, which
  `crates/mirin-metal` does for it, and the layout code calls what only the
  fork has (`contains`, `below_changed_since`, `set_layout_epoch`);
- three files the tests read were not brought over: IBM Plex Sans Regular,
  Lilex Regular and Bold (`assets/fonts/`) and a JPEG with an EXIF
  orientation (`crates/sumi/examples/image/`). They are Zed's, at the fork
  commit, with their licenses beside them;
- one of mirin's own tests had never been compiled
  (`a_glyph_of_a_line_moved_by_whole_device_pixels_keeps_its_variant`, in
  `window.rs`: it named `place_glyph_x` without importing it), and one of
  upstream's read a field mirin's text system no longer has;
- the platform crates' tests need `sumi`'s `test-support`, which only a
  build of the whole workspace turns on.

With those, all but four of the 623 passed or were upstream's to skip. The
four each said something:

| Test | What it found | What was done |
| --- | --- | --- |
| `sumi-util`: `logging_preserves_diagnostics_and_callers` | A logged error's target was `sumi-linux::…`, the directory's name, where the module is `sumi_linux`: `RUST_LOG=sumi_linux=debug` did not show it. The rename's doing. | Fixed (`log_error_with_caller`): the target is the module path. |
| `sumi`: `border_widths_to_taffy_use_stroke_snapping` | Upstream rounds a border to a device pixel before layout; sumi lays out lengths as authored, on purpose (`AbsoluteLength::to_taffy`: Dashi's apps at 1.25 and 1.5). | The test now says what sumi does (`border_widths_go_to_taffy_as_authored`). |
| `sumi`: `test_fractional_padding_does_not_make_a_fitting_container_scrollable` | The same decision, seen from outside: 4.25 px of padding around a 42 px child in a 50 px box overflows by half a pixel and scrolls by it, as in a browser. Upstream rounds the padding to 4 and it fits. | Kept and ignored, with the reason. It is a real difference from upstream: an app that pads by a fraction gets a scroll range of a fraction. |
| `sumi-wgpu`: `remove_deallocates_tile_space_for_reuse` | It put a 700 px tile beside another in the first color texture, which is 512 across here (`FIRST_COLOR_ATLAS_SIZE`, for a small app's memory). | The tile is 400 px. |

They run in CI's `metal` job on Linux: `cargo test --locked --workspace
--lib --tests` in `forks/sumi`, which has a lockfile of its own for it, and
`cargo fmt --all --check`. Not run: the 99 doc tests (five minutes; they
pass by hand), and the macOS and Windows crates' tests, which build only
there.

**Font fallback by weight, the static case.** A family in separate files, a
weight each (Thin and Regular, cut from Noto Sans's static files and named
as those are: `tests/fonts/MirinTestWeights-*.ttf`), gives the file of the
weight asked by name and as a fallback, whichever file the system read
first, and a weight between the files gets one of them as CSS picks (300 is
Thin, 700 is Regular); nothing was wrong. `tests/text_weight.rs`,
`a_family_of_static_files_gives_the_file_of_the_weight_asked` and
`a_fallback_of_static_files_is_the_file_of_the_weight_of_the_text`. One
thing the test met on the way: a family is usable by name only if its
faces have an "m" (`load_primary`), which is upstream's rule.

**Sweep gradients in Noto's emoji.** None. Of the 4,012 colour glyphs of
Fedora's `Noto-COLRv1.ttf` (google-noto-color-emoji-fonts 20260921), walked
with fontTools through every layer, transform, composite and nested glyph,
not one reaches a `PaintSweepGradient` or `PaintVarSweepGradient`: 1,735
use a linear gradient and 1,805 a radial one. The module's comment said "a
handful" and now says none. A sweep gradient in another font is drawn as
one flat colour, the mean of its stops.

**An inactive window under a check.** A window under a check counts as
active whatever the compositor says, so a check could not see how an
inactive one draws (a focus ring is not shown in one). A check can now say
so itself: the `deactivate` and `activate` window simulations
(`{"sim":{"kind":"window","action":"deactivate"}}`, `docs/metal.md` section
2), which call `Window::simulate_active_status` here: the activation
observers hear it and the window is drawn again, and under a check it
holds until the check says otherwise. A host that takes them says
`"activation":true` in its `protocol` line.
`drive::tests::a_check_makes_its_window_inactive_and_active_again`.
