# sumi: Metal's own engine

Status: **decided, under way** (2026-11-13). Metal stops being "GPUI plus
patches" and grows its own engine, **sumi** (墨, the ink that goes on
washi). This doc is its direction and roadmap. `gpui-next.md` keeps the
history of how Metal got onto upstream GPUI.

## Decisions

| Question | Decision |
| --- | --- |
| Track upstream GPUI or own the code? | **Own it.** One last sync with Zed, then a hard fork. Fixes from upstream are picked by hand, not merged. |
| Upstream PRs to Zed | **None.** Nothing in the roadmap waits on Zed. |
| Platforms | **Linux (Wayland, Dashi first), macOS, Windows.** iOS, Android and the web are out. |
| Native components | **Later, macOS only**, on NativeGPUI's model (section 5), after the core is ours. On Dashi and Windows the drawn `@mirinjs/metal-ui` components are the native ones. |
| Shape of the engine | **Minimal and retained.** It keeps only what Metal calls, and the frame is built around what changed (section 3). |

## 1. Where we are

Metal draws with two builds of the same `crates/mirin-metal/src`:

| Build | Base | Our changes | State |
| --- | --- | --- | --- |
| default | `forks/gpui` (gpui 0.2.2, one crate, blade renderer), `forks/taffy` 0.9, `forks/blade-graphics` | 8,500 lines in 49 files | ships in Dashi 0.9 |
| upstream | `forks/zed` (Zed's GPUI at `f8cfc7ed`, 2026-11-10), `forks/taffy-next` 0.15 | 7,700 lines in 41 files | at parity or faster on the stress bench, but select in a scroll view |

`src/gpui_api/{fork,upstream}.rs` (360 lines) hides the differences.

gpui 0.2.2 is a dead end: one crate with every platform inside, a renderer
upstream dropped, no releases since. Upstream is split the way an engine
should be: a core with no platform code, one crate per platform, shared
renderers (`gpui_wgpu` for Linux, `gpui_apple`'s Metal renderer for macOS).
sumi starts from upstream.

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
   size, RSS, first frame) before and after.
3. **Budgets, not hopes.** Every change that touches the frame runs the
   stress bench and the counter footprint against the last release host.
   The budgets in section 6 are the bar. A change that breaks one doesn't
   land.
4. **Dashi is the first platform, not the only one.** Dashi's Wayland
   protocols (the unified title bar, layer surfaces, session lock, file
   drag) sit in one `dashi` module behind a `dashi` feature, so a plain
   Linux, macOS or Windows app builds without them.
5. **Platform crates stay boring.** We barely change macOS and Windows.
   They stay close to upstream so picking its fixes stays cheap.

### Crates

| Crate | From | What changes |
| --- | --- | --- |
| `sumi` | `gpui`, `gpui_macros`, `gpui_util`, `gpui_shared_string`, `refineable`, `sum_tree`, `collections`, `scheduler` | Retention becomes the frame. The persistent layout tree is the only layout tree. Actions, keymaps, the inspector and `http_client` go. |
| `sumi-wgpu` | `gpui_wgpu` | Vulkan on Linux. Our memory and startup work (4 MiB blocks, path textures only while on screen, pipelines on first use, no indirect validation) is already in it. |
| `sumi-apple` | `gpui_apple` | The Metal renderer and CoreText, for macOS. |
| `sumi-linux` | `gpui_linux` | Wayland first, X11 behind its feature. `dashi` module and feature. |
| `sumi-macos`, `sumi-windows` | `gpui_macos`, `gpui_windows` | Close to upstream. |
| `sumi-platform` | `gpui_platform` | Picks one of the three. |

Out: `gpui_ios`, `gpui_web`, `gpui_tokio`, `http_client`, `bench_metrics`,
`ztracing` (replaced by the `mirin::startup` log and `log`).

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
| 1 | **Switch the default to upstream.** Close select in a scroll view, the footprint at 1.5, layouts at other scales. Then switch, and delete `forks/gpui`, `forks/taffy`, `forks/blade-graphics` and `src/gpui_api/`. | 4–7 days |
| 2 | **Last sync** to Zed `main`. | 1–2 days |
| 3 | **Become sumi.** Move the crates to `forks/sumi/`, rename, drop the crates and modules listed above, put Dashi's protocols behind `dashi`. Measure size, RSS and first frame before and after. | 2–3 days |
| 4 | **The retained frame** (section 3). | 1–2 weeks |
| 5 | **Native slots** (section 5): the engine's `NativeSlot`, the protocol's `native` node, drawn fallbacks everywhere. | about a week |
| 6 | **AppKit host.** | 1–2 weeks, needs a Mac |

Steps 1 to 4 are verifiable here on Linux. Dashi 0.9 ships the default
build as it is today; the switch reaches Dashi in the release after it.

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
