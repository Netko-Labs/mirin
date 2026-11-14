# Metal on current upstream GPUI: spike findings

**Done (2026-11-14).** Metal builds on upstream GPUI alone: `forks/zed` and
`forks/taffy-next` are what `crates/mirin-metal` depends on, and the gpui
0.2.2 forks (`forks/gpui`, `forks/taffy`, `forks/blade-graphics`), the
second manifest (`crates/mirin-metal/next`), the two halves of
`src/gpui_api/` and the spike (`spikes/gpui-next/`) are gone from the tree.
This document is the record of the move; where it says "the default build"
or "the fork" it means the 0.2.2 one, and "the upstream build" is now the
only build. What comes next is in [`engine.md`](engine.md).

Date: 2026-11-10. Branch `perf-gpui-next`. Spike code: `spikes/gpui-next/`
(its README says how to build it and repeat the numbers).

Round 4 (2026-11-11, branch `gpui-next-port`) made the migration real:
upstream GPUI is in the tree as forks (`forks/zed`, `forks/taffy-next`),
mirin-metal builds on it beside the fork (`crates/mirin-metal/next`), and
retained subtrees run on it in place. Section 6 has where that stands.
Round 5 (branch `next-retain`) ported the rest of retention that moving
needs: drawings copied moved, subtrees left out while unseen with their
drawings parked, and clean subtrees built again onto their kept layout
nodes. On the stress app grow, scroll and resize went from 143, 134 and
160 ms to 4.4, 5.4 and 14.4 ms (host-r4: 3.5, 2.4 and 8.5); section 6,
"Round 5", has the design and the numbers.

Metal's GPUI fork (`forks/gpui`) is the crates.io release gpui 0.2.2 plus 29
mirin changes (about 3,070 added lines over 23 files, `forks/gpui/MIRIN.md`),
on a taffy 0.9.0 fork with 9 more (480 lines, `forks/taffy/MIRIN.md`). gpui
0.2.2 was published on 2025-10-22 and is still the newest release on
crates.io; Zed's own tree (commit `f8cfc7ed`, 2026-11-10) is a year further
on: GPUI is split into platform crates, the blade renderer is replaced by
wgpu, layout is on taffy 0.15, and it has gained accessibility, native popups
and layer shell.
This spike built `crates/mirin-metal` against that tree to answer whether and
how to move.

## Recommendation

**Migrate, as the next piece of work after round 2 lands. Not in the middle
of round 2, and not never.**

- It works today with a small port: 291 lines added and 122 removed in
  `crates/mirin-metal/src` (of 15,870), tests included. The host runs the
  counter demo, the example browser and the 15k-node stress bench on
  upstream, and 164 of mirin-metal's 169 tests pass.
- Upstream already has 11 of the fork's 29 GPUI changes, among them the
  three largest platform ones (layer shell with a screen per surface, idle
  windows that stop committing, text input gating). 15 more port
  mechanically (about 900 lines). 3 need redesign, and they are round 1's
  performance work: retained subtrees and the layout tree kept across frames.
- By itself upstream is not slower per frame: a whole-tree frame of the
  15k-node stress app took 96–126 ms on upstream and 113–145 ms on round 1's
  host with retention off, at comparable load. It uses less memory on a large
  tree (230 MB against 293 MB). A small app costs more as upstream comes:
  the counter's host is 101 MB RSS against 77–80 MB (PSS 58 against 44–47)
  and paints its first content frame ~95 ms after it starts against 55–72
  ms. Nearly all of that is wgpu loading the GL driver beside Vulkan; built
  to ask for Vulkan only (one line) it is 83 MB, PSS 51, and 65 ms.
- What blocks switching now: without retained subtrees a 15k-node frame is
  ~100 ms, where round 1's host draws it in ~4.5 ms. The switch can only
  happen once retention is ported, and that port is a redesign (section 4).
- Layout is not pixel-identical: upstream snaps text line heights and box
  edges to device pixels, so on the stress grid 2,990 of 3,044 checked nodes
  sit 1 px taller or a few px lower than on the fork. Every Dashi app needs a
  look after the switch.
- What argues against waiting long: every week on 0.2.2 adds fork changes in
  code upstream has since replaced. Round 2's footprint lane is changing the
  blade renderer (`forks/gpui/src/platform/blade/*`, a blade-graphics fork);
  upstream has no blade any more, so that work does not carry over. Fork work
  on the Wayland frame loop, the text-input path or the window options meets
  code upstream rewrote.

The order and effort are in section 5: 23 to 34 working days of one
engineer (five to seven weeks), less with parallel lanes since three of the
steps are independent. The retained port and checking Dashi's apps for layout
changes are the large and uncertain parts.

## 1. Does mirin-metal build and run on upstream GPUI?

Yes. `spikes/gpui-next/` is a standalone package that compiles a copy of
`crates/mirin-metal/src` (as of `5fbcfb7`) with `port.patch` applied (291
lines added, 122 removed, in 21 files; `cargo fmt` and `cargo clippy
--all-targets -- -D warnings` clean), against
`zed/crates/gpui` by path (a sparse checkout made by `fetch-zed.sh`; upstream's
sources are not in the repo). `cargo build --release --bin mirin-metal-host`
takes about 1 min 45 s here. The resulting host speaks the same protocol, so
the demos and benches run on it unchanged.

What ran: `demo/counter.tsx` (first content frame, clicks), `bench/stress.tsx`
(select, type and hover, all three), `bench/native.tsx` (clicks, list scroll,
maximize), `bench/layout-check.tsx`. No bench scenario was missing a sim
command or failed to run.

mirin-metal's own tests, on upstream (`cargo test --lib` in the spike): 164
pass, 5 fail, 1 is ignored as before, and 4 that test fork-private helpers
(`ink_end_x`, `reuses_layout`, `cut_line`) are left out. The five failures
are each a fork change upstream lacks, which checks the reading in section 3
from the other side:

| Failing test | Fork change it needs |
| --- | --- |
| `one_line_tests::a_box_narrower_than_the_ellipsis_shows_nothing` | a line narrower than its ellipsis draws nothing |
| `scroll_tests::its_last_rows_margin_and_its_border_count`, `its_padding_counts_once` | scroll by taffy's content size |
| `scroll_tests::the_wheel_scrolls_the_innermost_view_then_the_one_around_it` | the wheel scrolls the innermost view that can move |
| `retain::tests::only_subtrees_that_render_from_their_content_alone_are_kept` | retained subtrees (off in the spike) |

The truncation tests (`a_one_line_text_its_box_cuts_ends_in_an_ellipsis` and
three more of `one_line_tests`) and the other 10 scroll tests pass without the
fork.

Layout against round 1's host (`bench/layout-check.tsx`, retention off,
every id'd node's bounds after each step):

| App | Result | What differs |
| --- | --- | --- |
| Card grid (40×25) | 2,990 of 3,044 nodes differ at every step | a text line is 15 px tall where the fork gives 14 (upstream snaps line height to device pixels, `elements/text.rs:611`), so each card is 1 px taller and the rows under it sit lower (4–5 px midway down the grid) |
| Example browser, most steps | 1 of 52–60 nodes | 1 px |
| Example browser, accordion and list steps | 13 of 63–67 | 1 px |
| Example browser, card example | 20 of 69 | real: its `grid-cols-[1fr_auto]` is the track-list stub (equal columns) |
| Example browser, typing in search | 38 of 59 | up to 3 px (accumulated 1 px line heights) |

So the spike host is usable for measuring, and it is not a drop-in: layouts
move by a pixel wherever text sets a height.

Not done: macOS was not built, and nothing was checked by eye.

### API differences mirin-metal had to adapt to

| Area | gpui 0.2.2 (fork) | Upstream | Size in mirin-metal |
| --- | --- | --- | --- |
| Crates | one `gpui` crate with its platforms | `gpui` (core) + `gpui_platform` (picks `gpui_linux` / `gpui_macos` / `gpui_windows` / `gpui_web`) + `gpui_wgpu` (renderer and Linux text system) | manifest: one more dependency |
| Starting the app | `Application::new()` | `gpui_platform::application()` | 2 lines |
| Async app | `AsyncApp::update` returns `Result<R>` | returns `R` | 2 call sites that used the `Result` |
| Quit on last window | fork's `set_quit_when_last_window_closes(false)` | `cx.set_quit_mode(QuitMode::Explicit)` | 1 line |
| Window closed | `on_window_closed(\|cx\| …)` | `on_window_closed(\|cx, window_id\| …)` | 1 line |
| Focus | `window.focus(&handle)` | `window.focus(&handle, cx)` | 9 call sites, and `cx` passed down through 7 functions (about 40 lines) |
| Drawing in tests | `window.draw(cx).clear()` | `.clear(cx)` | 2 lines |
| Layer shell | fork's `WindowOptions::layer_shell` | `WindowOptions::kind = WindowKind::LayerShell(..)`; anchor is bitflags, zone and margins are `Pixels`, no `output` | a 60-line adapter (`src/upstream.rs`) |
| Suspended | fork's `observe_window_suspended` / `is_window_suspended` | `observe_window_visibility(\|visibility, …\|)` | 3 lines |
| Scroll | `ScrollHandle::max_offset()` is a `Size`; `ScrollWheelEvent`, `on_scroll_wheel` | a `Point`; `ScrollEvent`, `on_scroll` (old names deprecated) | 6 lines |
| Text painting | `ShapedLine::paint(origin, line_height, window, cx)` | two more arguments (`align`, `align_width`) | 1 call |
| Box shadow | 4 fields | `inset: bool` added | 1 line |
| Keystrokes | `Keystroke::parse(&str)` | `parse` takes `&'static str`; `parse_with_os(&str, os)` for dynamic input | 1 call |
| Layout engine | taffy 0.9.0 (fork) | taffy 0.15.0, rounding done by GPUI in device pixels | none in mirin-metal (it never names taffy) |
| Text stack | cosmic-text 0.14 in `gpui` | cosmic-text 0.19 in `gpui_wgpu` | none |
| Accessibility crates | none in GPUI; mirin-metal has accesskit 0.25 + accesskit_unix 0.24 (fork) | GPUI brings accesskit 0.24 + accesskit_unix 0.22 | two copies in the build until mirin-metal's `access/` moves onto GPUI's |
| Toolchain | Rust 2021 | edition 2024, Rust 1.98.1 pinned | none |

The `Element`, `Render`, `InputHandler`, `div`/`canvas`/`list`/`img`/`svg`
and `Styled` surface mirin-metal uses compiled unchanged.

### Stubbed or off in the spike (fork-only API)

| Fork API mirin-metal uses | In the spike | To make real |
| --- | --- | --- |
| `gpui::retained`, `Retained::on_prepaint` | off: `retain::enabled()` is false, every frame is drawn whole | section 4 |
| `grid_template_columns/rows`, `GridTrack`, `TrackBreadth` | stub: N tracks become `repeat(N, minmax(0, 1fr))` | port the fork change (~95 lines) |
| `justify_items`, `justify_self` | ignored | ~8 lines |
| `WindowOptions::session_lock`, `Window::unlock_session` | a lock surface opens as a plain window | port (~150 lines in `gpui_linux`) |
| `LayerShellOptions::output` (screen by name) | ignored: the compositor picks | map the name to a `DisplayId` (upstream picks the output from `WindowOptions::display_id`) |
| `observe_window_chrome`, `chrome_controls` (Dashi's unified title bar) | never granted; standard title bar reported | port (~165 lines + the protocol XML, `gpui_linux`) |
| `Window::set_window_min_size` | ignored after open | port (~30 lines) |
| `Window::start_file_drag` (drag files out, with an icon) | off | upstream has drag-out with another shape (`external_drag_payload`), no icon surface |
| `StyledText::with_paragraph_sizes`, `TextLayout::line_height_for_index` | one size per text | port (~110 lines, re-applied on changed internals) |

One thing runs twice rather than not at all: accessibility. Upstream GPUI
publishes its own AccessKit tree over AT-SPI when a screen reader listens
("Accessibility activated" in its log), and mirin-metal's `access/` publishes
its tree as before, so the spike host shows up twice on the accessibility
bus. GPUI's tree is nearly empty here (it lists elements that have a `role`,
and mirin-metal sets none). Step 6 in section 5 decides which one stays.

## 2. Is upstream faster or slower, lighter or heavier?

Compared like with like: round 1's host (`/tmp/claude-1000/host-r1`) with
`MIRIN_METAL_RETAIN=0` against the spike host, both taking patches, release
builds with the same profile, back to back in a nested dashi-comp
(`runbench.sh`). Three other agents were compiling on the machine, so a run's
load varies up to 2x; `render` (mirin-metal building its elements, the same
code on both hosts) is shown as the yardstick for that, and `frame / render`
is the figure to compare.

**Stress bench** (`packages/mirin-metal/bench/stress.tsx`, ~15k nodes, one
card or one text changed per update; four runs per host, alternating). Each
cell is a run's median over its ~50 frames (`frame-ratio.sh` on the traces):

| Run | round 1, retention off: render / frame / ratio | upstream: render / frame / ratio |
| --- | --- | --- |
| 1 | 21.2 ms / 173.0 ms / 9.1 | 11.5 ms / 95.5 ms / 8.4 |
| 2 | 13.5 ms / 118.1 ms / 8.8 | 24.6 ms / 219.5 ms / 8.7 |
| 3 | 15.5 ms / 144.8 ms / 9.0 | 12.1 ms / 97.9 ms / 8.9 |
| 4 | 14.2 ms / 112.9 ms / 8.1 | 12.2 ms / 126.2 ms / 10.1 |
| median ratio | 8.9 | 8.8 |
| frame in the three runs at similar load | 113–145 ms | 96–126 ms |

| | round 1, retention off | upstream | round 1 as shipped (retention on) |
| --- | --- | --- | --- |
| select: frame, per-run medians | 111–261 ms | 96–204 ms | 12.4 ms in this session (4.5–5.8 ms on a quiet machine, `docs/metal.md` 5b) |
| type: frame | 119–170 ms | 98–246 ms | 9.3 ms |
| hover: frame | 113–139 ms | 96–239 ms | 11.7 ms |
| patch parse + apply | 0.1 ms | 0.1 ms | 1.1 ms (with the retained sync) |
| sent per update | 0.2–0.3 KB | 0.2–0.3 KB | 0.2–0.3 KB |
| RSS | 289–298 MB | 229–233 MB | 267 MB |
| idle, 3 s | 0 frames, 0 ms CPU | 0 frames, 0 ms CPU | 0 frames, 0 ms CPU |

Read: per whole-tree frame upstream is between equal and about 15% faster,
not slower (the ratios overlap; `render` itself ran a little faster on
upstream in the quieter runs, so the ratio may understate it). It holds 60 MB
less for the same tree. Neither is near what retention gives.

**Example browser** (`packages/mirin-metal-ui/bench/native.tsx`, ~900
nodes; four runs per host, alternating; per-run medians):

| | round 1, retention off | upstream |
| --- | --- | --- |
| full frame (all frames) | 1.7, 3.5, 2.2, 1.9 ms | 2.9, 1.7, 1.7, 1.5 ms |
| scroll frame | 3.7, 4.0, 2.3, 3.4 ms | 2.5, 2.7, 2.6, 2.5 ms |
| tree → elements | 0.1 ms | 0.1 ms |
| patch apply | 0.5–1.1 ms | 0.5–1.1 ms |

The scroll figure rests on two or three frames a run (the nested compositor
sends a frame callback once a second, so 120 simulated wheel steps draw two
frames); it says "not slower", no more.

**Counter demo** (`packages/mirin-metal/demo/counter.tsx`, 800×600;
`bench/footprint.tsx`, three runs of three starts per host, hosts
alternating, every binary run from disk; the last column is the spike host built with
`Backends::VULKAN` alone in `gpui_wgpu/src/wgpu_context.rs`):

| | round 1 | upstream | upstream, Vulkan only |
| --- | --- | --- | --- |
| host start → first content frame, per-run medians | 55, 72, 61 ms | 96, 94, 108 ms | 65, 64, 70 ms |
| host CPU by then | 40–60 ms | 80–100 ms | 60–70 ms |
| window opened at | ~30 ms | ~12 ms | ~10 ms |
| host RSS | 76.8–79.8 MB | 100.8–101.5 MB | 83.1–83.5 MB |
| host PSS | 44.4–47.3 MB | 58.1–58.9 MB | 50.6–51.0 MB |
| host anonymous memory | 12.0 MB | 17.4 MB | 12.8 MB |
| of RSS: the binary / GPU driver mappings | 16–19 / 30.7 MB | 22.1 / 45.6 MB | 22.3 / 30.6 MB |
| GPU memory (`gtt`, not in RSS) | 68 MB | 52 MB | 47–48 MB |
| threads | 35 | 45 | 38 |
| idle wakeups per 5 s | 10 | 0 | 0 |
| host binary (stripped) | 33.1 MB (25.1) | 44.2 MB (33.5) | same |

Read: a small app is heavier on upstream as it comes: +22 MB RSS, +12 MB
PSS, about +30 ms to the first frame. Upstream opens its window sooner and
then spends longer before the first frame, in wgpu's adapter search (it
enumerates and loads GL as well as Vulkan). Asking wgpu for Vulkan only gives
nearly all of it back: +5 MB RSS and +5 MB PSS over round 1 (the larger
binary), the same startup within noise, and 20 MB less GPU memory.

An earlier set of four runs with round 1's host on `/tmp` (tmpfs) read 71–72
MB for it; 13.5 MB of its binary was swapped out. Those are not used.

Renderer: blade (0.2.2) draws through Vulkan only. Upstream's wgpu asks for
`Backends::VULKAN | Backends::GL` on Linux. Here it found two adapters,
`AMD Radeon 890M (RADV STRIX1)` on Vulkan and the same GPU through radeonsi on
GL, tested the Vulkan one and took it ("Selected GPU adapter … (Vulkan)",
`MIRIN_METAL_GPUI_LOG=1`). Upstream also reads the compositor's GPU from
`linux-dmabuf` feedback to pick the adapter ("Compositor GPU hint:
vendor=0x1002, device=0x150e"), which is what mirin's `gpu.rs` does by hand
for blade; mirin's `VK_LOADER_DRIVERS_SELECT` filter still applied in the
spike and is still worth keeping (it keeps the loader from mapping the other
GPU's driver at all). Enumerating GL is what loads `libgallium` and a GL
thread into every app: the memory, the 7 threads and most of the startup in
the last column above. A machine without Vulkan would get a working window
from GL, which blade could not give; the change worth making (and offering
upstream) is to try Vulkan first and load GL only when there is none.

Idle behaviour is the same: 0 frames and 0 ms of host CPU over 3 s on the
stress app for both, and the idle counter host made no wakeups in 5 s
(round 1: 10).

## 3. Which fork changes has upstream absorbed?

Classes: **a** upstream has it; **b** ports mechanically; **c** needs
redesign. Upstream paths are relative to the zed checkout. Sizes for b and c
are the fork's diff against the `forks-upstream` branch.

### GPUI (`forks/gpui/MIRIN.md`, 29 rows)

| Fork change | Class | Upstream evidence | Port |
| --- | --- | --- | --- |
| Explicit grid track lists | b | only `GridTemplate { repeat, min_size }`, `crates/gpui/src/style.rs:145-175`; `to_grid_repeat`, `taffy.rs:463` | ~95 lines; lengths go through upstream's device-pixel rounding |
| `justify_items` / `justify_self` | b | not in `Style` or `to_taffy` | ~8 lines |
| Text min-content width is the widest word | b | `elements/text.rs:626-633` still gives no wrap width for min-content | ~40 lines |
| Layer-shell surfaces | a | `WindowKind::LayerShell(LayerShellOptions)`, `platform.rs:2889`, `platform/layer_shell.rs`, `gpui_linux/src/linux/wayland/window.rs:164-208` | adapter only; differences below |
| Typed float literals | a | `taffy.rs:472` | nothing |
| Session-lock surfaces | b | no `ext_session_lock` anywhere | ~150 lines: one more `WaylandSurfaceState` variant |
| Layer surface on a chosen screen | a | `display_id` → `wl_output`, `wayland/client.rs:1322-1329`, with the startup roundtrip (`client.rs:1205`) | by `DisplayId`, not connector name |
| Idle windows stop committing, wake on dirty | a | `FrameLoop::Parked`, `wayland/window.rs:755-765, 975-1017`; `PlatformWindow::schedule_frame` | nothing; upstream keeps presenting for 1 s after fast input |
| Loop outlives its last window | a | `QuitMode::Explicit`, `app.rs:526` | nothing |
| Text input only while a field takes text; caret as the IME area | a | `update_ime_enabled`, `wayland/window.rs:1072-1096`; `InputHandler::accepts_text_input` | nothing; a handler can also refuse (a password field) |
| Dashi's unified title bar | b | none (Dashi-private) | ~165 lines + XML, in a `gpui_linux` fork; there is no extension point |
| Toplevel suspended state | a | `xdg_wm_base` v6, `State::Suspended → WindowVisibility::Hidden`, `wayland/window.rs:1255` | nothing |
| Layout reused only for the same truncation width | a | `elements/text.rs:654-669` | nothing |
| Per-paragraph font sizes | b | one `line_height` per layout | ~110 lines, re-applied (painting was restructured) |
| A truncated line is cut where it is drawn (`fit_to`) | b | cache half upstream; prepaint re-cut not | ~80 lines |
| Resize while maximized keeps the size | b | `resize`, `wayland/window.rs:1759` has no guard | ~32 lines |
| A line narrower than its ellipsis draws nothing | b | `truncate_line` still keeps the suffix | ~9 lines |
| A line is cut from a copy of its runs | a | `truncate_line` returns `Cow<[TextRun]>` | nothing |
| Least size after open (`set_min_size`) | b | none | ~30 lines |
| Wrapped line aligned by its ink end | b | `aligned_origin_x`, `text_system/line.rs:1003` | ~65 lines |
| No-break space, word joiner, quotes | a | UAX #14 through `icu_segmenter`, `line_wrapper.rs:545`; tested for U+00A0/U+202F | keep mirin's tests for quotes and U+2060 |
| Scroll by taffy's content size | b | `content_size = child_max - child_min`, `elements/div.rs:2092` | ~45 lines; taffy 0.15 calls it `scrollable_overflow_rect` |
| Wheel scrolls the innermost view that can move | b | `div.rs:3444-3490` adds the delta unclamped | ~50 lines |
| List scroll bar range counts padding | b | `max_scroll_offset`, `list.rs:848` | ~7 lines |
| Retained subtrees | c | only `AnyView::cached`, `view.rs:46`; `reuse_prepaint`/`reuse_paint`, `window.rs:4244` | ~850 lines with tests; section 4 |
| Element states of a retained subtree | c | `Frame::finish` still moves each state, `window.rs:1199` | ~45 lines; follows the retained port |
| Layout tree kept across frames | c | `clear()` drops the tree, `taffy.rs:53` | ~115 lines; section 4 |
| Taffy fork by path | b | `taffy = "=0.15.0"` | a `[patch.crates-io]` entry |
| `DispatchEventResult` public | a | `window.rs:2446` | nothing |

Counts: 11 a, 15 b (about 900 lines), 3 c. Two fork changes have no MIRIN.md
row: `Window::start_file_drag` with `wayland/drag_icon.rs` (drag files out
with an icon), which upstream covers differently (`external_drag_payload`,
no icon), and a `refresh()` on a file drop leaving, which upstream has.

### taffy (`forks/taffy/MIRIN.md`, 9 rows, against taffy 0.15.0)

| Fork change | Class | taffy 0.15 | Port |
| --- | --- | --- | --- |
| Container at its min/max width lays its children out again | b | not fixed (`compute_flexbox_layout`, one preliminary pass) | ~16 lines + test |
| Negative margin with `flex-shrink: 0` | a | fixed differently (`flexbox.rs:1619, 1655`) | keep the test |
| Fit-content cross size for the base size (column) | b | not fixed | ~42 lines |
| Fit-content hypothetical cross size (column) | b | not fixed | ~28 lines |
| End margins count toward content size | b | not fixed; the accumulator is now a `Rect` (`scrollable_overflow.rs`) | ~12 lines, reshaped |
| Incremental rounding (`round_changed`) | drop | upstream GPUI calls `disable_rounding()` and snaps edges itself (`crates/gpui/src/taffy.rs:39, 356-390`) | nothing to port; the same saving has to be made in GPUI's own snapping |
| `remove` keeps a re-parented child, drops the context | a / b | context dropped; parent still cleared | ~6 lines |
| `contains` | b | none | ~4 lines |
| Detached layout | c | none; out-of-flow boxes are now hoisted and placed in a last pass | rewrite |

So a taffy fork is still needed on upstream (four flexbox fixes that shadcn
layouts hit, plus what retention needs), now of 0.15.

### The ones that matter most

**Layer shell.** Upstream's is a superset in most ways and differs in shape:

| | mirin fork | upstream |
| --- | --- | --- |
| Where | `WindowOptions::layer_shell` | `WindowOptions::kind = WindowKind::LayerShell(..)` |
| Layer default | `Top` | `Overlay` |
| Anchor | four bools | bitflags |
| Exclusive zone | `i32` | `Option<Pixels>`, plus `exclusive_edge` |
| Margin | four `i32` | `Option<(Pixels × 4)>` |
| Keyboard default | `None` | `OnDemand` |
| Screen | `output: Option<String>` (connector name) | `WindowOptions::display_id` |
| After creation | size only | size, `Window::set_exclusive_zone`, `set_exclusive_edge`, `set_input_region` |
| Popups | none | `WindowKind::AnchoredPopup` (xdg_popup), also from a layer surface |
| Stretching | sends 0 on an axis anchored to both edges | sends the window's size; a bar gets its size from `window_bounds` |

Two things to add for Dashi: a way to name the screen (a `PlatformDisplay`
has no connector name; its `uuid()` is derived from it), and the 0-size
request for a stretched axis so a bar follows its output's width. Both are
small `gpui_linux` changes and upstreamable.

**Session lock.** Not upstream. The port is a third surface role beside xdg
and layer surfaces; upstream's `target_output` would let it lock a chosen
screen instead of the first.

**Frame callbacks and idle.** Upstream's Wayland window now parks when a
frame had nothing to draw and asks for a frame callback only when it draws,
which is the fork's change. Wake-up is `PlatformWindow::schedule_frame`
(called when a window becomes dirty) instead of the fork's `redraw_waker`.
Measured: 0 frames while idle on both.

**Text input gating.** Upstream enables `zwp_text_input_v3` only while the
window is active, an input handler is set, and the handler accepts text; the
candidate area with nothing composed is the selection head. Same as the
fork, plus the handler's own veto.

**Taffy.** Upstream GPUI lays out in device pixels with taffy's rounding
off, and snaps each node's absolute edges afterwards. The fork's incremental
rounding lives in taffy and has no place there.

## 4. How would round 1's performance work port?

What upstream has today, compared with 0.2.2:

| Mechanism | 0.2.2 | Upstream | Same? |
| --- | --- | --- | --- |
| `Window::draw` | request layout, prepaint, paint of the whole tree; `layout_engine.clear()`; `next_frame.finish()` | the same sequence (`window.rs:3660-3800`), plus accessibility and a frame pacer | yes |
| Layout tree | a new taffy tree every frame | the same (`taffy.rs:53`) | yes: no persistent tree |
| Layout cache | taffy's per-node cache, lost with the tree | the same | yes |
| Rounding | taffy rounds the whole tree | GPUI snaps absolute edges per node on demand, cached per frame | different |
| Element state | `Frame::element_states`, moved key by key each frame | the same (`window.rs:1044, 1199`) | yes |
| View reuse | `AnyView::cached(style)`: size from outside, reuse when bounds, mask and text style match | the same rule (`view.rs`, `prepaint_view`), now also through a `View` trait | yes |
| `reuse_prepaint` / `reuse_paint` | copy ranges of last frame's lists | the same, with one more index in test builds | yes |
| Dispatch tree | `reuse_subtree` | the same | yes |

So upstream has no equivalent of round 1's work: no persistent layout tree,
no reuse for a subtree that sizes itself from its content, no cheaper
element-state carry. The gap the fork closed is still open upstream, and the
stress bench shows it: ~100 ms a frame on upstream against ~4.5 ms
with retention.

What lives in mirin-metal carries over as it is, and ran in the spike: the
patch protocol (0.1 ms parse and apply, 0.2 KB per update), the document's
generations, and giving a GPUI element id only to views that interact.

What the port needs:

- **`elements/retained.rs` (541 lines + tests).** The element, its range
  bookkeeping and `ElementStateScope` sit on parts of `Window` and `Frame`
  that did not change shape (`PrepaintStateIndex`, `PaintIndex`, the
  `Element` trait), so about two thirds ports as it is.
- **Moved subtrees.** The fork rebuilds a subtree that moved and lays it out
  detached "as its kept nodes sit", relying on taffy rounding relative to the
  parent. Upstream snaps to absolute device pixels, so a subtree that moves by
  a fractional amount can change its inner geometry by a pixel. The reuse test
  has to compare device-pixel bounds, and the detached layout has to be told
  the twin's absolute origin.
- **Persistent tree (`taffy.rs`, ~115 lines in the fork).** Upstream's engine
  keeps two per-frame maps beside the tree (`absolute_layout_bounds`,
  `absolute_outer_origins`); a kept subtree needs its entries kept or
  recomputed, and that is where the fork's incremental-rounding saving has to
  be made again.
- **taffy 0.15.** `contains`, the `remove` fix and the detached layout are
  needed again; the detached layout is a rewrite for the new measure
  signature and the out-of-flow pass.
- **Accessibility.** Upstream builds an AccessKit tree during the frame. A
  subtree that is copied instead of drawn must carry its accessibility nodes
  too; `AnyView::cached` is the precedent to read.

Estimate: 6 to 10 working days, most of it the moved-subtree case and making
the fork's `retained` test (same quads, glyphs and hitboxes as drawing
everything) pass on upstream. It is also the part most worth offering
upstream, since Zed has the same full-tree frame.

## 5. Maintenance model and migration order

### What to fork

On Linux the build takes 14 crates from the zed repository, all Apache-2.0:

| Crate | Lines (src) | Fork it? |
| --- | --- | --- |
| `gpui` | 92,700 | yes: layout, text, retained, grid |
| `gpui_linux` | 17,475 | yes: session lock, Dashi chrome, layer-shell additions, min size |
| `gpui_wgpu` | 6,249 | one small change: try Vulkan first and load GL only when there is none (section 2); upstreamable |
| `gpui_platform`, `gpui_macros`, `gpui_util`, `gpui_shared_string`, `collections`, `refineable` (+ derive), `sum_tree`, `scheduler`, `http_client`, `ztracing` (+ macro) | 14,000 together | no, but they must come from the same commit |

`gpui_macos` and `gpui_windows` join when those platforms do. The dependency
closure is 536 packages on Linux (the fork's build: 573). None is GPL-only;
zed's GPL crates (the editor, workspace, and so on) are not in it. `self_cell`
is `Apache-2.0 OR GPL-2.0-only` (taken as Apache) and `option-ext` is MPL-2.0;
both are in the fork's build today as well. Upstream pins several
dependencies to git commits of its own forks
(`async-task`, `async-process`, `calloop`, `khronos-egl`, `font-kit`, `oo7`,
`xim`) and wgpu to an unreleased commit; a dependent has to repeat the four
`[patch.crates-io]` entries GPUI's crates need, because a workspace's patches
do not reach packages outside it (`spikes/gpui-next/Cargo.toml`).

Apache-2.0 asks that changed files say so and that the license travels with
the source: `MIRIN.md` and the `// mirin:` comments already do the first.

### How to track it

Keep the scheme `forks/README.md` describes, with one directory for the
whole set instead of one per crate:

- `forks/zed/` mirrors the zed repository's layout, pruned: `Cargo.toml`
  (upstream's workspace root, kept because the crates inherit their edition,
  dependencies and lints from it), `Cargo.lock`, `LICENSE-APACHE`,
  `rust-toolchain.toml`, and `crates/<the 14 above>` (plus the rest of
  `crates/gpui*` and `bench_metrics`, which cargo must be able to read to
  resolve even where they are not built). This is exactly the spike's `zed/`
  directory, 14 MB of files; the spike shows cargo is content with it (a
  path dependency reads the root manifest for inheritance and does not load
  the other members). Running GPUI's own tests from there was not tried: it
  needs the root manifest's member list cut to the kept crates and a few more
  of them (`reqwest_client`, `util_macros`, `tooling/perf`).
- The `forks-upstream` branch holds that directory as upstream has it at one
  commit; a sync replaces it with a newer commit's and merges the branch, as
  now. `fetch-zed.sh` is that step's first half.
- Sync to the commit of a stable Zed release, about monthly, so each merge
  is small. Upstream moves fast in these crates; a year of drift is how the
  fork got here.
- `crates/mirin-metal` depends on `forks/zed/crates/gpui` and
  `gpui_platform` by path and patches taffy to `forks/taffy` (0.15).

Why snapshots and not history: `git subtree` or a filtered history of these
paths drags thousands of zed commits into mirin for little gain; merges of
monthly snapshots already carry mirin's changes forward. A GitHub fork of zed
is still worth having for one purpose, sending changes upstream: 22 of the
fork's 29 rows are marked upstreamable (some "in spirit"), 11 are upstream
already in some form, and each one accepted leaves the fork for good.
Depending on that fork by git instead of an in-repo directory would
make every build clone zed and split changes that touch GPUI and mirin-metal
together into two repositories.

### Migration order

| Step | What | Effort |
| --- | --- | --- |
| 0 | Now, during round 2: stop adding fork changes to code upstream replaced (blade renderer, Wayland frame loop, text input enabling) unless they are needed before the switch | none |
| 1 | `forks/zed/` snapshot and the `forks-upstream` scheme; taffy 0.15 on `forks-upstream`; mirin-metal builds on both through a `gpui-next` cargo feature and a `upstream.rs`-style shim (the spike's patch is the start), so benches and `layout-check` compare the two hosts until the switch | 2 days |
| 2 | Class b in `gpui` core: grid tracks, `justify_*`, text min-content, per-paragraph sizes, `fit_to`, ink-end alignment, narrow ellipsis, scroll extent, wheel, list padding (~500 lines), with their tests | 4–6 days |
| 3 | taffy 0.15 fork: four flexbox fixes, `contains`, `remove` (~110 lines); run mirin-metal's layout tests | 2 days |
| 4 | `gpui_linux`: session lock, Dashi chrome, screen by name and stretched layer surfaces, `set_min_size`, resize while maximized, file drag icon (~450 lines) | 3–4 days |
| 5 | Retained subtrees and the persistent layout tree (section 4) | 6–10 days |
| 6 | mirin-metal: port its tests, decide accessibility (GPUI's built-in AccessKit tree could replace `access/` and the accesskit_unix fork), limit wgpu to Vulkan where it is present | 3–5 days |
| 7 | Check every Dashi app and the example browser for layout and text changes (taffy 0.9 → 0.15, device-pixel snapping, cosmic-text 0.14 → 0.19), benches, footprint; switch the default; delete `forks/gpui` | 3–5 days |
| alongside | Send the upstreamable rows to Zed, smallest first | per PR |

Steps 2, 3 and 4 are independent of each other; 5 needs 1 and 3.

Risks: layout or text differences across Dashi's apps that only show on
screen (step 7 is there for that); the retained port taking longer than
estimated, during which the old fork stays the default; upstream changing the
frame internals under the port (sync before starting step 5, not during).

## 6. Round 4: the migration under way

Branch `gpui-next-port` (from `metal-forks` at `a494f9c`). Sections 1–5 are
the spike; this one is what is real now, and replaces the spike's
`spikes/gpui-next/` way of building (kept for its numbers).

### What is in the tree

- **Upstream as forks.** `forks/zed/` holds the GPUI crates of zed at
  `f8cfc7ed` (the spike's commit; a day old, so not worth a newer one) in
  zed's own layout, and `forks/taffy-next/` holds taffy 0.15.0, the version
  upstream GPUI pins. Both came in pristine on the branch
  `forks-upstream-next` (made from `forks-upstream`, one commit) and were
  merged into this branch, as `forks/README.md` describes; that README now
  says what was taken and how to re-sync. 20 crates, the ones a build of
  mirin-metal resolves on any target, `examples/` left out (6.9 MB of files).
  Every one is `Apache-2.0` in its manifest, with `LICENSE-APACHE` beside it;
  none of zed's GPL crates is in. taffy is MIT. The old forks
  (`forks/gpui`, `forks/taffy`, `forks/blade-graphics`) are untouched.
- **A second build, side by side.** `crates/mirin-metal/next/Cargo.toml`
  builds the same `../src` on `forks/zed` with the `gpui-next` feature, its
  own lockfile (the spike's, which started from zed's) and its own
  `target/`. `crates/mirin-metal/Cargo.toml` builds what it built; its only
  change declares the `gpui-next` cfg so the lint knows it. Every API that
  differs in shape is one function in `src/gpui_api/` (`fork.rs` and
  `upstream.rs`, the same signatures; 17 + 157 + 229 lines), so the rest of
  the crate has no `cfg` for them: focus with `cx`, the app's start, quit
  mode, window-closed callbacks, `AsyncApp::update`, scroll ranges as a
  point, `ShapedLine::paint`'s alignment, `BoxShadow::inset`, keystroke
  parsing, `on_scroll`, layer-shell options as a window kind, visibility for
  suspension. What upstream lacks altogether is ported into `forks/zed` with
  the fork's API instead, and the shim goes; 10 stand-ins marked `GAP` remain
  (Dashi chrome, session lock, file drag-out, per-paragraph sizes; the
  screen a layer surface names; and from round 4's lists lane, a list's
  content origin, without which its rows each move on their own as before
  that lane, and glyph variants in scene traces). Round 5's resize lane
  added `stretchable` as an eleventh, and the taffy fork's answer for a row
  at another width (`Cache::get_stretched`) was missing from
  `forks/taffy-next`; round 6 ported both ("Round 6: layout as the default
  build's, and resize" below). Tests that need a fork-only feature are
  `cfg`'d with a comment: the fork's three helper tests (`reuses_layout`,
  `cut_line`, `ink_end_x`), the scroll-snap switch, and the moved-count
  assertion. mirin-metal's source grew by 564 lines and lost 117, most of
  it `gpui_api/` and `cx` passed down for focus.

  ```sh
  cd crates/mirin-metal/next
  cargo build --release --bin mirin-metal-host    # ~2 min from cold
  cargo test --lib                                 # 189 pass, 1 ignored
  cargo clippy --all-targets -- -D warnings
  ```

### Fork changes, against upstream (updated)

`forks/zed/MIRIN.md` and `forks/taffy-next/MIRIN.md` list what is ported.
Against `forks/gpui/MIRIN.md`'s 49 rows (29 from the spike's count, 20 more
from rounds 2 and 3):

| Status | Rows |
| --- | --- |
| Ported (`forks/zed`) | grid track lists; `justify_items`/`justify_self`; text min-content is the widest word; scroll by taffy's content size; wheel scrolls the innermost view; list scroll bar counts padding; narrow ellipsis draws nothing; `set_window_min_size` (Wayland); resize while maximized; `scene_drawn`/`scene_digest`; retained subtrees in place, with the layout tree kept across frames (below); round 6: `Retained::stretchable`, a scroll view's children's bounds to `on_children_prepainted`, and the fork's layout rounding (text at its line height's fraction, edges rounded as taffy 0.9 rounds them, scroll offsets halves away from zero); round 6 too (next-platform, next-retain2): glyphs placed from their line's grid point, per-paragraph font sizes, `fit_to`, ink-end alignment, session lock, Dashi's unified title bar, a layer surface's screen by connector name and the stretched axis, file drag-out with an icon, `MIRIN_METAL_SCALE`, and the retained rows below |
| Ported (`forks/taffy-next`) | relayout at a min/max width; fit-content base size; fit-content hypothetical cross size; end margins in the scrollable overflow; `remove` keeps a re-parented child; `contains`; `below_changed_since` (round 5); a row answered from another width (round 6) |
| Upstream has it | layer shell; a layer surface's screen (by `DisplayId`); typed float literals; idle windows stop committing; loop outlives its last window; text input only while a field takes it; suspended state (as visibility); layout reused only for the same truncation width; a line cut from a copy of its runs; no-break spaces and quotes (UAX #14); `DispatchEventResult` public; **scroll views paint at whole device pixels** (round 3: upstream snaps every element offset to device pixels in `Window::layout_bounds`, always, so `MIRIN_METAL_SCROLL_SNAP=0` has no effect there); taffy's negative-margin fix |
| Moot | blade's shared pipelines and the blade-graphics fork's allocator (no blade; round 5 did the same for wgpu: pipelines built on first use and shared, 4 MiB memory blocks); a renderer that starts with the window's transparency (with pipelines built on first use, turning opaque only configures the surface again); taffy's incremental rounding and detached layout (GPUI rounds itself; a copy laid out apart is a root with its twin's size) |
| Still applies, not ported | none of the rows this table counted, with the three round 6 lanes together ("Round 6: the three lanes together" below; round 5 ported the footprint rows and the startup milestones log: "Round 5: a small app's footprint" below). What upstream still does differently is in step 5's and step 7's "Left" |
| Its own question | accessibility: upstream GPUI brings AccessKit 0.24 and accesskit_unix 0.22 and publishes a tree of elements with a role (none in mirin-metal); mirin-metal's `access/` and the accesskit_unix fork (0.24) still publish its tree, so both are in the build (step 6) |

### Retained subtrees on upstream GPUI

**Design.** Upstream's frame is still 0.2.2's (section 4): request layout,
prepaint, paint of the whole tree, `reuse_prepaint`/`reuse_paint` copying
ranges of last frame's lists for `AnyView::cached`, and a taffy tree made
from nothing each frame. The port keeps the fork's model and fits it to
that frame in steps, each usable alone:

1. *In place* (done). `elements/retained.rs` (444 lines) is the fork's
   element, minus what later steps add. A subtree whose version, view and
   statics (text style, scale, rem size, opacity) are unchanged hands its
   kept taffy root to its parent instead of building; taffy's own cache
   answers for it. When it lands where it was drawn, at its size, under the
   same content mask, its last prepaint and paint ranges are copied with
   upstream's own `reuse_prepaint`/`reuse_paint` (hitboxes, dispatch nodes,
   tooltips, deferred draws, element states, line layouts; scene, listeners,
   cursors, input handlers, tab stops), as a cached view's are. Nested
   subtrees: each one drawn inside another registers its record with it
   (`Window::retained_nested`), and a copied subtree moves every nested
   record's ranges along (`PrepaintStateIndex::rebase`, `PaintIndex::rebase`,
   `LineLayoutIndex::rebase`), so they name the right stretch next frame
   whichever of them is drawn then. Ranges are checked before use
   (`prepaint_range_valid`, `paint_range_valid`, the font generation).
   The layout engine keeps a tree across frames: nodes made while a subtree
   builds are its own (`begin_owned`/`end_owned`), freed when its state goes
   (`released`); the frame's own nodes are freed at its end, children first;
   with nothing retained the tree is cleared whole, as before. taffy-next's
   `remove` keeps a child a new parent adopted.
   Anywhere else (it moved, or its size or mask changed) the subtree is
   built again and laid out *apart*, as a root with its twin's size, its
   edges rounded from where the twin sits (`place_detached`: upstream snaps
   absolute edges, so the copy's origin is the twin's unrounded one), and
   the subtrees inside it are built with it. That is what the fork did
   before round 2, and it gives the same layout, which the tests check.
2. *Moves* (done in round 5, not as planned here: see "Round 5" below;
   the gate for grow and scroll). Copy a drawing that moved
   by whole device pixels, as the fork's `reuse_*_moved`: hitboxes and
   primitives shifted, each under the content mask it has there. That needs
   what 0.2.2 needed: a record of which mask each primitive and hitbox was
   pushed under (the fork's `MaskMap`), so masks inside the subtree move
   with it and are clipped again by the ones around it; pins for what keeps
   its place (tooltips, deferred draws, input handlers, drags, drops, group
   styles, a pointer over it); and the device grid (`Grid`) at scale
   factors that are not powers of two. Upstream's absolute edge rounding
   helps: a move by whole device pixels rounds every edge inside as it was,
   except a half pixel exactly on either side of zero
   (`round_half_toward_zero`), which the plan must refuse. Also
   `insert_spanning`: upstream's `Scene::replay` inserts every primitive
   into the bounds tree again, a third of a reused frame on the fork.
   A first cut that stays exact without the mask map, for drawings that are
   whole on both sides of the move (every row of a grid that grows above
   it, every row of a scroll view but the two at its edges): record, while
   a subtree paints, whether anything of it was left out or clipped by the
   mask around it (`Scene::insert_primitive`'s early return, a glyph culled
   in `paint_line`, a layer pushed clipped, a mask pushed that the one
   around it cuts), and its extent (every primitive's and hitbox's bounds,
   every mask not the one around it). Move it only when nothing was left
   out, the mask around it then held its extent and the one now holds the
   extent moved, the unrounded origin of its root moved by whole device
   pixels at a scale factor of 1, 2 or 4, it draws no path (vertices), its
   ranges hold no tooltip, deferred draw or input handler, no `div` in it
   pinned it (drag, drop, tooltip, group styles), and the pointer is over
   neither its old nor its new extent. Then a copied primitive or hitbox
   takes the mask around it now where it had the one around it then, and
   its own moved otherwise; a layer moves; the nested records' bounds and
   masks move too. The mask map then lifts the "whole" condition for the
   rows at a scroll view's edges, and the grid lifts the scale-factor one.
   Estimate 3–4 days.
3. *Skips and parked drawings* (done in round 5; round 2/3's `skippable`, `parked`,
   `Recording`/`Region`: a subtree nothing shows of is left out; its
   drawing is kept within a budget and copied back). Needs 2. 2–3 days.
4. *Building onto kept nodes* (its core done in round 5; round 2's `begin_bind`: a subtree drawn
   again keeps its layout, and the subtrees inside it are each copied,
   moved or left out), with taffy-next's `inner_changed_since`,
   `last_measure_inputs` and `asked_since`, and *element state scopes* (a
   reused subtree carrying its elements' states as one entry; upstream still
   moves each one). 2–3 days.

**Measured** (step 1; release hosts, `bench/stress.tsx`, ~15k nodes,
`ref/host-r3` and this branch's upstream host back to back, two runs
each, medians; `frame` per update):

| stress bench (15k nodes), frame | host-r3 (fork, rounds 1–3) | upstream, step 1 | upstream, nothing retained (spike, section 2) |
| --- | --- | --- | --- |
| select | 2.8–3.0 ms (median 3.0) | 4.2–5.5 ms (4.9) | 96–204 ms |
| type | 1.7–1.9 ms (1.8) | 3.9–4.5 ms (4.2) | 98–246 ms |
| hover | 2.8–2.9 ms (2.9) | 4.2–4.9 ms (4.8) | 96–239 ms |
| select, the grid in a scroll view | 2.9–3.4 ms (3.0) | 4.8–10.5 ms (5.5) | — |
| grow (every row moves) | 3.7–4.2 ms (4.1) | 108–133 ms (108) | — |
| grow, the grid in a scroll view | 3.9–4.7 ms (4.5) | 112–266 ms (138) | — |
| scroll, 40 px a step | 3.3–4.0 ms (3.5) | 113–140 ms (129) | — |
| resize, 100 px a step | 15.7–16.7 ms (16.2) | 116–209 ms (134) | — |
| host CPU per update, select | 5.0–6.0 ms | 7.5–8.5 ms | — |
| RSS idle | 243–260 MB | 271–275 MB | 229–233 MB |

Four runs each, alternating with host-r3 (the last two upstream runs are
`host-next-4`, the same retained code with ink-end alignment); the second
upstream run had a loaded machine (its grow in the scroll view and its
resize are the high ends). Patch
parse and apply, the driver, `KB` and accessibility are the same on both
hosts (they are mirin-metal's). `MIRIN_METAL_ACCESS_CHECK=1` on the
upstream host: no complaints over the whole bench.

Footprint (`bench/footprint.tsx --app=counter`, three starts each, medians):

| counter demo, 800×600 | host-r3 | upstream |
| --- | --- | --- |
| host start → first content frame | 77 ms | 95 ms |
| host RSS / PSS / anonymous | 58.7 / 24.4 / 7.6 MB | 103.9 / 45.6 / 17.4 MB |
| GPU memory (gtt) | 12.7 MB | 52.2 MB |
| threads | 15 | 45 |
| idle wakeups per 5 s | 10 | 0 |

Round 2's footprint work is what that table shows missing: GL loaded beside
Vulkan, a background thread per core (24 workers), every face of a font
family loaded, path textures and an allocator sized for a prototype. Each
has a row above under "still applies"; none ports as written (blade is
gone), all port in spirit (step 6).

So step 1 gives upstream what round 1 gave the fork for changes made in place:
copied in place, a select, a keystroke or a hover costs 4–5 ms of frame
where upstream without retention costs ~100 ms, within 1.5–2.5 ms of host-r3
(the rest is what host-r3 has and step 1 does not: element states carried
as one entry, a replayed drawing placed once in the bounds tree). What
moves (grow, scroll, resize) is drawn again with everything inside it, as
upstream does without retention: step 2 is the gate.

### Round 5: moves, skips, parked drawings, building onto kept nodes

Branch `next-retain` (from `metal-forks` at `9d618af`). Steps 2, 3 and the
core of 4 are in `forks/zed` (`elements/retained.rs` and
`retained/{plan,recording,steady,parked}.rs`; 2,400 lines added with the window,
scene, taffy and dispatch hooks; `forks/zed/MIRIN.md` lists them), with one
row in `forks/taffy-next` (`below_changed_since`). The default build is
unchanged. They were done in the brief's order, but the order turned out
not to be separable on the stress app: its grid is one retained subtree
holding 100 rows of 25 cards, and the grid is never whole on screen, so a
grid that moved was built again *apart*, with every row and card inside
built with it. Moves alone changed nothing there (grow 142 ms, scroll 121
ms, the same as `host-next-r4`); building onto kept nodes (step 4) is what
lets each row be copied, moved or left out on its own, and skips are what
keep the rows out of view from being drawn.

**Moves (step 2).** Not the fork's grid and mask map, but upstream's own
rounding: upstream snaps every absolute edge and every primitive to device
pixels, so a drawing moved by whole device pixels draws what drawing it
there does wherever arithmetic is exact. What a subtree drawn anew records
(`recording.rs`, through hooks in `Window::paint_*`, `with_content_mask`,
`insert_hitbox`, `layout_bounds` and `Scene::insert_primitive`):

- *what it rounds* (`steady.rs`): every edge `layout_bounds` rounds and every
  position `paint_*` rounds (quads, borders' covers, glyphs' subpixel
  variants, emoji, icons, underlines), per axis. A position within 1/64 of
  a device pixel of where its rounding turns, and not there by exact
  arithmetic, fixes that axis; one exactly on a half (upstream rounds
  halves toward zero) keeps the move from taking it across zero. An
  origin summed from the subtree's root in multiples of 1/256 below 2^15
  is exact; the root's own unrounded origin must move by a whole number of
  device pixels (`Place`). A scroll view inside the subtree snaps on its
  own and fixes both axes. Moves are made at scale factors that are powers
  of two, where `R/s + O` is exact.
- *what the mask around it hid* (`left_out`): primitives and glyphs it
  culled or dropped; within 256 px of that mask they are kept in the drawing
  unshown (`SceneReach::keeps`, `Window::retained_glyph_shows`), so a row
  scrolling into view is whole. A copy is made where `left_out` stays hidden.
- *what must not have been clipped* (`strict`): masks pushed inside it as
  given, and borders and underlines drawn in parts with masks of their own.
  Each primitive and hitbox then takes the mask around it where it is
  copied, or its own moved and clipped by that one (`Scene::replay_moved`,
  `Window::reuse_prepaint_moved`). A layer keeps its unclipped bounds and
  its mask and is clipped again the same way (it only orders draws).
- *what knows where it is* (`pinned`): deferred draws, input handlers,
  tooltips, window control areas, paths, transformed sprites, a `div`'s
  drag, drop, tooltip or group style.
- *where the pointer was* when it was drawn: a copy is made where the pointer
  was over the drawing neither then nor is now, or (in place) did not move.
  Upstream decides hover styles and `on_hover` at paint from the hit test,
  and a resize can move the pointer without a move event (found by
  `layout-check scroll`: a card heard no `hover false`).

Tried and taken back: working out each strip of a border again where a
drawing clipped by its view's edge moved (`Quad::border_strips` against the
mask). It made scrolling cheaper (4.7 ms a step against 6.1) but drew what
drawing everything does not on `layout-check scroll` and
`scroll-fractional`, and a later press then hit another card; the cause was
not found within the round. Borders drawn in strips stay in `strict`.

**Skips and parked drawings (step 3).** A clean subtree that may be left out
(`skippable`), inert (no focus, key context, key, action or modifier
listener, tab stop; `DispatchTree::range_is_inert`) and with no notified
view inside is not drawn where its extent shows nowhere; one whose root was
only resized (nothing below it changed: taffy-next's `below_changed_since`)
reaches as far as before, grown with its root. Its element states, and the
retained subtrees' states inside with them, go out of the frame with it
(`take_element_states`) and come back when it is drawn or copied again, so
their kept nodes stay alive. Its drawing is parked (`parked.rs`, a port of
the fork's within the same 24,000-item budget): hitboxes, dispatch nodes,
primitives, listeners, cursor styles, element state keys and line layouts
are taken out of the last frame and put back at the end of the frame
before the one it shows again in, from where it is copied like any moved
drawing. A drawing on upstream carries its masks in its primitives, so
nothing needs renumbering but its dispatch nodes.

**Building onto kept nodes (step 4, core).** A clean subtree that can't be
copied is built again with every layout request answered by the node it
made last time, in order (`TaffyLayoutEngine::begin_bind`/`end_bind`);
nothing is laid out, and the retained subtrees inside are each planned on
their own. A measured leaf takes the new element's function, which is
asked what the old one was last asked (kept by GPUI's own measure wrapper,
`NodeContext::last`, so taffy needs no change); that is what a layout from
nothing leaves it with only for nodes measured only in the layout they were
made for (`any_asked_since`). Otherwise the subtree is built apart once and
made anew the next time it is laid out (`remake`), so a window resize does
not leave every row built apart for good. Element state scopes (a reused
subtree's states carried as one entry) and `insert_spanning` are not done.

**Measured** (release hosts, `bench/stress.tsx --visible`, ~15k nodes;
`host-next-r5` is this branch, interleaved with `ref/host-r4` and
`ref/host-next-r4`, two runs each, medians; `frame` per update):

| stress bench (15k nodes), frame | host-next-r5 (this branch) | host-r4 (fork) | host-next-r4 (round 4) |
| --- | --- | --- | --- |
| select | 3.9 ms (both runs) | 1.9 ms | 4.4–4.5 ms (4.45) |
| type | 3.1–3.2 ms (3.15) | 1.1 ms | 3.6 ms |
| hover | 4.0–4.1 ms (4.05) | 2.2–2.3 ms (2.25) | 4.4–4.5 ms (4.45) |
| grow (every row moves) | 4.3–4.5 ms (4.4) | 3.4–3.5 ms (3.45) | 137–149 ms (143) |
| grow, the grid in a scroll view | 5.4–5.8 ms (5.6) | 3.6–3.8 ms (3.7) | 151–161 ms (156) |
| select, the grid in a scroll view | 3.9–4.3 ms (4.1) | 2.2–2.3 ms (2.25) | 4.5–4.9 ms (4.7) |
| scroll, 40 px a step | 5.3–5.4 ms (5.35) | 2.4 ms | 123–145 ms (134) |
| resize, 100 px a step | 14.3–14.4 ms (14.35) | 8.4–8.5 ms (8.45) | 159–160 ms (160) |
| scroll across, 40 px a step | 4.7–4.9 ms (4.8) | 2.5–2.6 ms (2.55) | 111–124 ms (117) |
| host CPU per update: grow / scroll / resize | 6.3 / 7.0 / 18.8 ms | 5.9 / 4.2 / 11.3 ms | 160 / 98 / 186 ms |
| RSS idle / at the end | 230–233 / 319–320 MB | 202 / 312–313 MB | 264–265 / 331–332 MB |

Each step, one run of the same bench as it landed (single runs, so the
machine's noise of ±0.5 ms applies; frame medians in ms):

| upstream host | grow | scroll | resize | across |
| --- | --- | --- | --- | --- |
| round 4 (copies in place) | 138 | 110–150 | 160–267 | 110 |
| + moves (whole drawings, power-of-two scales) | 142 | 121 | — | — |
| + building onto kept nodes | 62 | 64 | — | — |
| + skips (not drawn while unseen) | 5.2 | 6.3 | 21.7 | 4.9 |
| + clipped drawings move, rows only resized stay undrawn | 7.4 (a loaded run: its select was 5.6) | 5.9 | 15.0 | 4.8 |
| + parked drawings, layers moved with their masks, made anew after a stale measure | 4.6 | 6.1 | 15.4 | 4.8 |
| as landed (two runs, above) | 4.4 | 5.35 | 14.35 | 4.8 |

On grow and the scroll steps the frames now draw the grid's own elements
again onto its nodes and copy each row (`1 redrawn, 15 moved` a scroll
frame, besides a row coming into view); a resize still lays out every row
at its new width in taffy (about a quarter of its frame, where taffy 0.15's
cache keeps fewer entries than the fork's 0.9 with round 4's two extra
slots) and draws the rows in view again. What a select, a keystroke or a
hover costs over host-r4 (1.9–2 ms) is what step 1 already left: element
states carried key by key, and a copied drawing's primitives each put in
the bounds tree.

**Correctness.** `layout-check <app> host-next-r5 host-next-r5 --visible
--scene --env-b=MIRIN_METAL_RETAIN=0`: `grid`, `browser`, `scroll`, `scroll-fractional` and `across`
lay out and draw the same at every step. Round 4's upstream host against
this one (`layout-check grid ref/host-next-r4 host-next-r5 --scene`, both
retaining): the same at every step. `MIRIN_METAL_ACCESS_CHECK=1`
over the whole stress bench: no complaint. mirin-metal's tests on the
upstream build: 201 pass, 1 ignored, among them ten ports of the fork's
GPUI-level retained tests (`src/retain/gpui_tests.rs`: rows kept and
redrawn, scrolled, below one that grew, cells inside moved rows, the pointer
over moving rows, a view notified while left out, a subtree whose elements
differ from build to build, rows that may not move, rows scrolled out and
back, a row hovered as it leaves) and one of its own (cells that hear hovers
hear what drawing everything tells them), comparing every frame's
`Window::last_scene_drawn` with retention and without; the GAP in
`retain/tests.rs` (rows moved when what is above the grid grows) is closed.
Differences from the fork's tests: cells come into view clipped with their
own masks clipped by the view's, so they are built again onto their kept
nodes (no layout) where the fork's mask map moves them; the fork's budget
test is not ported (no test hook for the budget). taffy-next: 170 pass.

### Round 6: the retention gaps (next-retain2)

Branch `next-retain2` (from `metal-forks` at `467af84`). Step 5's "Left"
list, but for glyphs placed from their line's grid point and resize's
taffy time (another lane's). All of it is in `forks/zed`
(`forks/zed/MIRIN.md` has a row each); the default build is unchanged.

- **Interactions** (`insert_spanning`, element state scopes). A profile of
  select, type and hover on `host-next-r5` put a third of the frame in
  `BoundsTree::insert`: `Scene::replay` put every primitive of a copied
  drawing in the bounds tree again to find its draw order. A drawing whose
  primitives and layers each show where it is copied exactly when they
  showed where it was, with no layer around it, now goes in once, as the
  bounds of what it shows (`BoundsTree::insert_spanning`,
  `Scene::replay_as_one`): its primitives keep their orders among
  themselves, rebased above what is under those bounds. What overlaps is
  painted in the same order; only the numbers differ, so the upstream
  retained tests now also compare what each frame paints over what
  (`Window::last_scene_stacking`; reversing the rebase fails five of them).
  That alone took select, type and hover from 3.25 / 3.1 / 3.85 ms to
  1.95 / 1.45 / 1.95 (two runs each, host-r5: 2.3 / 1.6 / 2.15). Element
  states now live in the retained subtree being drawn
  (`ElementStateScope`, as on the fork), so a copied or left-out subtree
  carries them as one where the frame moved each from last frame's map to
  the next: on the stress bench that is lost in select, type and hover's
  noise, but scroll costs 3.15 ms (CPU 5.0) with scopes against 3.8 (CPU
  10.1) without them (the finished host with and without, two runs each),
  so they stay.
- **The mask map.** The scroll frames of `host-next-r5` drew 53 subtrees
  again: the grid, the two rows at the view's edges and their 50 cards.
  Not for masks pushed inside (the cards have none) but for their borders:
  upstream paints a border on its own quad, in strips, each under the
  content mask intersected with its strip (`paint_quad`), so every card
  had masks of its own that the view's edge clipped (`strict`). The frame
  now keeps every content mask as given (`MaskNode`), every paint
  operation and hitbox the mask it was drawn under, and every strip its
  strip; a copied drawing pushes the masks pushed inside it again, moved,
  under the mask around it where it lands (`MaskMap`), and each primitive,
  strip, layer and hitbox is clipped by its mask as that clips there. That
  is the fork's mask map, on upstream's frame. While a subtree is drawn
  anew, what its own masks let through without the one around it is how
  far it reaches, and what the one around it hides of that is kept unshown
  near it or left out, as before only for what it drew under that one.
  Scroll frames now draw the grid and the row coming into view, and move
  the rest.
- **Why round 5's attempt drew differently** (`cfc3ae6`, recomputing
  border strips for clipped moves): a moved copy dropped a layer that
  ended up empty (`Scene::replay_moved`, as `paint_layer` drops one), so
  the copy had two operations fewer than the drawing it copied, and the
  ranges of the drawings inside it (rebased by offset) named the wrong
  operations from then on: a row copied part of another's primitives, and
  of its hitboxes, which is the press that hit another card. Moves of
  clipped drawings are what first produce empty layers. Found the same way
  here (`layout-check scroll` on the strips alone: 14 steps drew
  differently; an upstream test of cells that hear hovers lost 8
  operations a copy). An empty layer is now kept as a marker: the
  operations match, nothing is pushed.
- **The device grid.** At 1.25, 1.5 or 1.75 a whole device pixel divided
  by the scale factor and multiplied back is a few float steps off, so a
  content mask's `ceil` could take the next pixel in one place and not in
  another, and a hitbox moved by `by / scale` differed in its last bits
  from one laid out there; moves were refused off powers of two. Where
  scaling is not exact (`elements/retained/grid.rs`): a device position
  within 1/256 of a whole pixel is that pixel before it is floored or
  ceiled (`cover_device`: every mask and shadow, retained or not, so a
  drawing is the same either way), a node's origin is its device position
  and the element offset divided once (`Window::layout_bounds`), as a
  moved position is computed, and a logical position within 1/512 of a
  whole device pixel moves through it (`Grid::moved`); one off it fixes
  its axis (`Steadiness::on_grid`, `settled_floor`). A drawing with masks
  pushed inside still does not move there: whoever pushes a mask sums its
  size in logical pixels, which the copy can't reproduce to the bit. At a
  power of two nothing changes. `MIRIN_METAL_SCALE` now works on the
  upstream build (`gpui_linux`'s `scale_override`, the fork's row) to bench
  it. At 1.5 the stress bench's grow and scroll fell from 13.4 and 17.1 ms
  (round 5's code with `MIRIN_METAL_SCALE` ported) to 3.2 and 2.9;
  scrolling across did not (12.1 ms): its cards are drawn again because
  their glyphs' subpixel variants are rounded from each glyph's own
  position (`paint_glyph`), which lands near where the variant turns in
  almost every card; that is the fork's "glyphs placed from their line's
  grid point" row, not yet ported (text painting is the platform lane's).

**Measured** (release hosts, `bench/stress.tsx --visible`, ~15k nodes;
`host-next-r6` is this branch, interleaved with `ref/host-next-r5` and
`ref/host-r5`, two runs each, medians; `frame` per update; the machine
was shared with three other lanes' benches, so ±0.5 ms):

| stress bench (15k nodes), frame | host-next-r6 (this branch) | host-next-r5 | host-r5 (default build) |
| --- | --- | --- | --- |
| select | 2.2–2.6 ms (2.4) | 3.5–3.8 ms (3.65) | 2.6 ms |
| type | 1.8–2.0 ms (1.9) | 3.2–3.8 ms (3.5) | 1.2–1.7 ms (1.45) |
| hover | 2.3–2.4 ms (2.35) | 3.7–3.8 ms (3.75) | 2.2–2.3 ms (2.25) |
| grow (every row moves) | 2.8–3.1 ms (2.95) | 4.0–4.5 ms (4.25) | 3.7–5.2 ms (4.45) |
| grow, the grid in a scroll view | 2.6–3.1 ms (2.85) | 5.3–5.4 ms (5.35) | 3.2–3.8 ms (3.5) |
| select, the grid in a scroll view | 3.3–3.4 ms (3.35) | 4.4–4.7 ms (4.55) | 2.6–2.7 ms (2.65) |
| scroll, 40 px a step | 2.8–3.0 ms (2.9) | 4.8–4.9 ms (4.85) | 2.8–3.1 ms (2.95) |
| scroll across | 2.9–3.2 ms (3.05) | 4.3–5.0 ms (4.65) | 2.9–3.0 ms (2.95) |
| resize, 100 px a step (the layout lane's) | 8.4–8.5 ms (8.45) | 10.3–11.0 ms (10.65) | 2.2 ms |
| host CPU per update: select / scroll / across | 5.0 / 4.8 / 4.8 ms | 6.0 / 6.8 / 6.6 ms | 5.0 / 4.1 / 4.1 ms |
| RSS idle / at the end | 192–196 / 285–288 MB | 193–195 / 285–286 MB | 200–205 / 316 MB |

The same bench at `MIRIN_METAL_SCALE=1.5` (one run each):

| at 1.5, frame | host-next-r6 | round 5's code with `MIRIN_METAL_SCALE` | host-r5 |
| --- | --- | --- | --- |
| select / type / hover | 2.1 / 1.7 / 2.2 ms | 2.2 / — / — ms | 2.7 / 1.8 / 2.6 ms |
| grow / grow in a scroll view | 3.2 / 3.3 ms | 13.4 / — ms | 6.8 / 7.0 ms |
| scroll / scroll across | 2.9 / 12.1 ms | 17.1 / 12.6 ms | 3.1 / 3.0 ms |

(`ref/host-next-r5` has no `MIRIN_METAL_SCALE`, so it draws at 1 there;
the middle column is this branch after `insert_spanning`, element state
scopes and the scale override, before strips, the mask map and the grid.)

As it went (single runs, the same noise): `insert_spanning` alone took
select / type / hover from 3.25 / 3.1 / 3.85 to 1.95 / 1.45 / 1.95 ms (two
runs each against host-next-r5 and host-r5 then: 2.3 / 1.6 / 2.15); border
strips moved took scroll from 3.6 (profiled host with `insert_spanning`)
to 3.2 ms, `53 redrawn, 15 moved` a scroll frame to `27 redrawn` only when
a row first comes into view and `1 redrawn, 32 moved` otherwise.

**Correctness.** `layout-check <app> host-next-r6 host-next-r6 --visible
--scene --env-b=MIRIN_METAL_RETAIN=0`: `grid`, `browser`, `scroll`,
`scroll-fractional` and `across` lay out and draw the same at every step,
at a scale factor of 1 and with both hosts at `MIRIN_METAL_SCALE=1.5`
(all five, every step). Against `ref/host-next-r5` (both retaining, `--scene`): `grid`
and `scroll` the same at every step, so nothing drawn at 1 changed. (Against
`host-r4` upstream differs by design: "Tests and layout against host-r3".)
`MIRIN_METAL_ACCESS_CHECK=1` over the whole stress bench: no complaint.
mirin-metal's tests on the upstream build: 203 pass, 1 ignored. New or
changed: every upstream retained test also compares what each frame
paints over what; rows carry a border (drawn in strips); ports of the
fork's scaled tests (`rows_move_by_whole_device_pixels_at_any_scale_factor`
at 1, 2, 1.25, 1.5, 1.75, 3 and 1.1; `small_wheel_steps_draw_what_drawing_everything_does`
at 1, 1.5 and 2). With the mask map, the cells test (rows of cells that
clip their text, scrolled unevenly at 2) moves 67 subtrees and draws 18
again, where it moved 46 and drew 72. GPUI's own tests still can't run
from `forks/zed` (round 4), so `grid.rs`' two unit tests did not run;
their arithmetic was checked apart (every whole device pixel below 12,000
divided by 1.25, 1.5, 1.75, 3 and 1.1 and multiplied back is within 1/1024
of itself).

### Tests and layout against host-r3

- mirin-metal's tests on the upstream build: 188 pass, 1 ignored (the one
  the fork ignores too); 3 are left out, each testing a fork helper
  upstream has its own way of (`reuses_layout` twice, `cut_line`). The
  default build: 191 pass, as before.
- `layout-check` of `ref/host-r3` against the upstream host (step 1 not
  yet; the same holds with it): `grid` 2,990 of 3,044 nodes differ at every
  step, `scroll` 4,536 of 4,562, `browser` 1 of 52–60 on most steps, 13 on
  the accordion and list steps, 20 on the card example and 38 while typing
  in search. The cause is the one the spike found: upstream rounds a
  measured leaf's size *up* to the device pixel
  (`snap_measured_size_to_device_pixels`, `ceil`), where the fork's taffy
  rounds every edge to the nearest; a line of text 14.x px tall is 15 px
  upstream and 14 on the fork, so each card is a pixel taller and every row
  below sits lower. Not quite: a host built with that rounding changed to
  the nearest pixel (as the fork's taffy does) gives the same differences
  to the node (2,990 on `grid`, 102 on `browser`), so it is the text's
  line height itself that comes out 15 px upstream where it is 14 on the
  fork, for the same 11 px text, a difference in how the text's metrics
  reach the line height (upstream snaps the line height to the device
  pixel, `window.pixel_snap`, and shapes with cosmic-text 0.19). Which
  text sizes it hits and whether to match the fork is step 7's question.
- The upstream host against itself, retention on and off
  (`--scene --env-b=MIRIN_METAL_RETAIN=0`): `grid` and `browser`
  identical, layouts and drawings, at every step. `scroll` and
  `scroll-fractional` laid out the same but drew one card differently at
  each pointer move after a scroll: a card's hover color was copied stale.
  Upstream paints a hover style from the hit test but notifies the view
  only when a mouse move changes the element's `hover_state`, which only
  mouse moves set; a card scrolled under a resting pointer was painted
  hovered with its state still "not hovered", so when the pointer left
  nothing was notified, and a retained card copied in place kept the color
  (drawing everything hid it). The listener now compares with what the
  frame painted (`div.rs`, a `forks/zed` row). A second fix went in on the
  way: a notified view is marked dirty itself, not only the views on its
  dispatch path, which starts at the last sibling view set on the same node
  (`Window::mark_view_dirty`). With both (`host-next-6`), all four apps
  (`grid`, `browser`, `scroll`, `scroll-fractional`) lay out and draw the
  same with retention and without, at every step.
- GPUI's own tests are not run from `forks/zed`: they need zed's workspace
  (its root manifest's member list cut to the kept crates, and
  `util_macros` and `tooling/perf` imported), left for step 6. taffy-next's
  own tests (`cargo test --lib` with the next build's lockfile): 169 pass.

What changes on screen with upstream, in short: text boxes a pixel taller
where the line height has a fraction (most text sizes but 16 px), rows
under them a pixel lower each; a scrolled view's content at the device pixel
upstream picks (halves toward zero, where the fork rounded them to nearest);
a box laid out with a fractional width now has its right edge where the
next one starts (absolute edge rounding, upstream's "closure").

### Round 6: layout as the default build's, and resize (next-layout)

Branch `next-layout` (from `metal-forks` at `467af84`). Two goals: the
upstream build lays out exactly as the default build does (step 7's
question), and a resize costs there what it costs on the fork.

**Why text boxes were a pixel taller.** Not the measured sizes' `ceil`
alone (round 4 tried that) but three roundings the fork does not do, any
one of which moves the grid:

- `TextLayout::layout` snapped the line height to the device pixel
  (`window.pixel_snap`): 9 px text is 14.56 px a line (GPUI's default line
  height is φ, 1.618), laid out 15 tall. The fork lays it out at 14.56.
- `snap_measured_size_to_device_pixels` ceiled every measured size; with
  the line height snapped that was a no-op for heights, which is why
  changing it alone changed nothing.
- `layout_bounds` rounded each node's absolute edges (halves toward zero).
  The fork's taffy 0.9 rounds a node's place in its parent on its own
  (halves away from zero) and its size as the difference of its rounded
  absolute edges, so its absolute origin is the sum of rounded places, not
  the rounded sum. With fractional text heights those differ: a 14.56 px
  text is 14 or 15 tall on the fork by where it sits.

Matching the fork takes all three (`forks/zed/MIRIN.md`, round 6 rows):
the line height as styled, measured sizes as measured, and `layout_bounds`
rounding as taffy 0.9 does (`rounded_origins`; a copy laid out apart rounds
from its twin's rounded origin). Text paints the same way it does on the
fork: each line at the fraction, its glyphs snapped where they land
(upstream's paint already snaps glyph origins), so nothing renders wrongly;
lines of one text may sit 14 and 15 px apart, as they do on the fork today.
Matching was the right call: every Dashi app is laid out against the fork,
and upstream's snapped line heights made every box with text a pixel taller.

Two more parity fixes the layout checks found, both cheap:

- a scroll view's offset snapped halves away from zero, as the fork's
  `painted_scroll` does (upstream snapped toward zero: `scroll-fractional`
  differed in every node at the 40.5 px step);
- a view with a tracked scroll handle hands its children's bounds to
  `on_children_prepainted` (a port of the fork's row): mirin's layout map
  had no bounds for a scroll view's own children upstream (`scroll`'s banner
  and grid, the example browser's preview and sidebar rows, on every step,
  since round 4).

Fractional layouts cost the retained port something, which round 6 fixed
in `retained/` (next-retain2's files, kept small):

- a subtree is left out only where its root moved by whole device pixels:
  moved by a fraction, sizes inside may round otherwise, and mirin's layout
  map, which keeps a left-out subtree's bounds moved as they were, would miss
  it (`layout-check grid`: 475 nodes differed with retention and without,
  after a card grew by a fraction);
- `Steadiness` held every position within 1/64 px of a half as unsafe to
  move. Text a fraction of a pixel tall puts many edges there, so rows no
  longer moved (the retain test's 8: 6 moved). Now a position near a half
  (or near a whole pixel, for floors) but not on it holds when `f32` can't
  carry it across: moved within its binade, every sum moves exactly
  (rounding commutes with a shift by a multiple of the last place's unit);
  across one, while it is further from the half than 32 units in the last
  place. And a move of the unrounded layout by whole pixels give or take
  what `f32` lost (28.000008: a sum that crossed a power of two) is a
  move, held to the same margin plus that slack.

**Resize.** Round 5 found taffy 0.15 measuring each card more than once.
The cause is 0.15's cache key: it compares the parent's size too, so when a
row's width changed every card in it missed its cache (their parent's size
changed) and ran its column algorithm and measured its texts again, on every
resize. The default build's fixes, ported where they apply:

- *separate slots for definite and max-content measures*: moot. 0.15's
  measure cache is associative (nine entries, any query, a second chance
  before eviction), so a definite and a max-content query keep their own
  entries already;
- `below_changed_since`: round 5 ported it;
- *a row at another width answers from its cache* (`Cache::get_stretched`,
  `compute_stretch_bound`): ported, with what 0.15 added (right-to-left rows,
  sizing keywords such as `stretch` and `fit-content`, and out-of-flow boxes
  that bubble to a containing block: a statically positioned item with
  children refuses it, as its absolutely placed child would be placed from
  the row's edges). The parent's size is not compared for a row that may
  stretch. The fork's randomized test is ported (rows of every kind,
  right-to-left and static items added, 32 seeds across 19 widths, kept and
  from nothing, exact) with targeted tests for the new refusals, and the
  stress grid resized measures nothing;
- *stretchable retained rows*: ported (`Retained::stretchable`,
  `Drawn::stretch`): a root that draws nothing of its size, only resized,
  takes the new size and layout as its drawing's and is planned as if
  unchanged. mirin-metal's `draws_nothing_of_its_size` shim is no longer a
  `GAP`. A GPUI-level test (`rows_only_resized_keep_their_drawings`)
  compares every frame with drawing everything, in a column and in a
  scroll view.

**Measured** (release hosts, `bench/stress.tsx --visible`, ~15k nodes;
`host-next-r5` as round 5 left it (base), this branch with the resize work
alone (s1: taffy-next's stretch answer and stretchable rows, no parity
change), this branch whole (p8), and `ref/host-r5`, interleaved, two runs
each, both runs given; `frame` per update, host CPU in brackets):

| stress bench (15k nodes) | host-next-r5 | resize work alone | this branch | host-r5 |
| --- | --- | --- | --- | --- |
| resize, 100 px a step | 10.8 / 10.9 ms (14.2 / 15.0) | 4.9 / 5.1 ms (8.3 / 9.2) | **4.6 / 4.4 ms (7.5 / 7.5)** | 2.0 / 2.4 ms (4.2) |
| select / type / hover | 3.5–3.7 / 3.1–3.3 / 3.5 ms | 3.5–3.7 / 2.4–3.2 / 3.4–4.2 ms | 3.6–4.2 / 3.2–3.5 / 3.3–3.4 ms | 2.4–2.5 / 1.5–1.6 / 2.3–2.6 ms |
| grow / in the scroll view | 4.0–4.3 / 5.1–5.2 ms | 3.2–3.7 / 4.8–5.1 ms | 4.0–4.1 / 5.7–6.0 ms | 3.9 / 3.7 ms |
| select in the scroll view / scroll / across | 3.5–4.0 / 5.0 / 4.4 ms | 4.0 / 4.9–5.1 / 4.3–4.4 ms | 4.0–4.3 / 5.0–5.3 / 4.3–4.4 ms | 2.1–2.6 / 2.8–2.9 / 2.9–3.0 ms |
| RSS idle / at the end | 192–195 / 284–285 MB | 193 / 286–288 MB | 194 / 288–290 MB | 200 / 311 MB |

A resize frame on upstream went from 10.8 to 4.5 ms, not to host-r5's 2.3.
Per resize (a profile of 400 resizes): the rows taffy no longer lays out
were half of it; the columns above the rows still run their flex algorithm
and the non-retained header's texts are measured again (taffy, 28% of what
is left), the accessibility tree's refresh (17%, mirin's, as on the fork),
copying the rows in view under the scroll view's new mask (9%), and the
prepaint and paint of the rest. What the fork has and this does not:
element state scopes and `insert_spanning` (what a select costs over the
fork too), and the fork's cheaper copy of a drawing under a new mask.

The layout parity costs a little where rows move in the scroll view
(`grow` there: 5.7–6.0 ms, was 5.1–5.2): with fractional text heights,
rows sit at fractions, and the row the view's edge clips, whose border
strips the mask cuts (`strict`), is built again onto its nodes (one row
and its 25 cards a frame in `grow`, against the grid alone before); which
row straddles an edge depends on the layout, so the fork's layout puts one
there where the old upstream layout did not. The fork moves such a row with
its mask map, which step 5 still lists.

**Layout against host-r5** (`layout-check <app> ref/host-r5 <this host>
--visible --scene`; before this round 2,990 of `grid`'s 3,044 nodes
differed at every step and 4,538 of `scroll`'s 4,564):

| app | nodes whose bounds differ | what else differs |
| --- | --- | --- |
| `grid` (11 steps) | none | the drawing digest |
| `scroll` (33 steps) | none | the drawing digest; which hover events are heard when content moves under a resting pointer (12 steps: upstream tells a card the pointer left it at the scroll or resize, the fork at the next pointer move; as before this round) |
| `scroll-fractional` (31 steps) | none | the same two |
| `browser` (12 steps) | the card example's 20 nodes (one step) | the drawing digest |

The card example (`card-demo`) is taffy 0.9 against taffy 0.15, not
rounding: on the fork the card (`w-full max-w-sm`, centered in the preview)
is 372 px tall where its header, form and footer need 394 with its padding,
so its footer overflows the card's bottom padding by 22 px; taffy 0.15 sizes
it to hold them. The fork is the one that lays it out wrongly here, so
matching it is not recommended; finding which of the fork's taffy 0.9 rows
(likely its `min`/`max-width` relayout) makes the card short is the
follow-up, on the default build.

Drawings differ because the renderers do (text painting, glyph placement
and colors are the `next-platform` lane's); the layout is the same.
Against itself, retention on and off (`--env-b=MIRIN_METAL_RETAIN=0`),
`grid`, `browser`, `scroll`, `scroll-fractional` and `across` lay out and
draw the same at every step. Not checked: other scale factors. At 1.25 or
1.5 upstream still rounds authored lengths and border widths to the device
pixel before layout (`to_taffy`), which the fork does not; at a scale of 1
that is a no-op for whole-pixel lengths.

Tests: mirin-metal on the upstream build 202 pass, 1 ignored (one new:
`rows_only_resized_keep_their_drawings`); on the default build 193 pass, 1
ignored (unchanged). taffy-next: 175 pass (5 new: the randomized trees, the
stress grid resized, a row of set widths, a row placing a box from its end,
a row with items sized from the space). `steady.rs`'s own tests (not run
from `forks/zed`, as GPUI's are not) pass compiled alone.
`MIRIN_METAL_ACCESS_CHECK=1` over the whole stress bench: no complaints.

### Round 5: a small app's footprint

Branch `next-footprint` (lane of round 5). Round 2 made the default build
lean in blade and the platform code (`docs/metal.md`, "Footprint: what one
small app costs"); upstream replaced blade with wgpu, so the same work is
redone there, in `forks/zed` (rows in `forks/zed/MIRIN.md`). Nothing in
`crates/mirin-metal/src` changed, so the default build is the same.

Measured with `bench/footprint.tsx --visible`, `ref/host-r4` (the default
build), `ref/host-next-r4` (upstream at round 4's end) and this branch's
upstream host back to back, three starts a run, two runs each (memory),
on the shared laptop while other lanes built and benched; start times are
from ten starts each, interleaved with host-r4, in the quietest stretch:

| counter demo, 800×600 | host-r4 | host-next-r4 | upstream now |
| --- | --- | --- | --- |
| host RSS | 57.9–58.5 MB | 102.8–103.9 MB | **68.1–68.6 MB** |
| host PSS / private dirty | 24.4–25.0 / 7.5 MB | 52–60 / 17.3 MB | 34.5–35.3 / 11.7 MB |
| GPU memory (gtt + vram) | 13.8 MB | 52.5 MB | **31.8 MB** |
| threads | 15 | 45 | **16** |
| host start → first content frame (median, range) | 34.5 ms (28–37) | 95–103 ms | **40 ms** (33–50) |
| idle, per 5 s | 0.1 ms, 10 wakeups | 0 ms, 0 wakeups | 0 ms, 0 wakeups |
| of RSS: binary / GPU driver / font files / heap | 15.6 / 30.7 / 0.3 / 1.7 MB | 21 / 45.5 / 16.5 / 7.4 MB | 21–22 / 30.7 / 0.3 / 5.2 MB |

| example browser, 1440×900 | host-r4 | host-next-r4 | upstream now |
| --- | --- | --- | --- |
| host RSS | 64.3–65.3 MB | 113.0–114.2 MB | **73.8–75.0 MB** |
| GPU memory | 29.2 MB | 99.9 MB | **47.2 MB** |
| threads | 15 | 45 | 16 |
| host start → first content frame (per-run medians) | 54–62 ms | 116–133 ms | 72–77 ms |

| stress bench, 15k nodes | host-next-r4 | upstream now |
| --- | --- | --- |
| RSS idle | 265–267 MB | **230–231 MB** |
| RSS at the end | 333–334 MB | **297–298 MB** |
| frame: select / type / hover | 3.6–4.6 / 2.6–4.1 / 4.5–9.0 ms | 4.4 / 3.4–3.5 / 4.4–4.5 ms |
| frame: grow / scroll / resize (nothing moves yet) | 140–221 / 132–146 / 156–160 ms | 138–140 / 134–142 / 158–184 ms |

The stress bench draws the same within noise (one resize run of 184 ms had
209 ms of CPU, its pair 158), and holds 35 MB less: the GL driver and the
font faces it no longer maps, and the path textures (38 MB of GPU memory at
its size) it no longer keeps without paths.

What changed, largest first, each measured on the counter as it went in
(`forks/zed/MIRIN.md` has the files and the reasons):

- **Vulkan alone** (GL only when Vulkan has no hardware adapter for the
  window), with the next item: RSS 103 → 84 MB, threads 45 → 18, GPU
  memory 52 → 47.5 MB, start ~100 → ~70 ms. Vulkan's part is the GL
  driver's mappings (`libgallium` and Mesa's GL side, 15 MB), its six
  threads and most of those 30 ms. A machine without Vulkan still gets a
  window from GL.
- **Four background threads** (upstream: one per core, 24 here): −20 threads.
- **Font faces loaded when picked, system fonts read on a thread**: −15.4 MB
  (74 Noto Sans files mapped, and their heap), ~5 ms of the first frame and
  the 7–9 ms scan off the main thread.
- **Pipelines built on first use and shared by a context's windows**: the
  renderer was created in 9–13 ms and built again (~13 ms) when the window
  turned opaque; now 0.8 ms, and the first frame builds the two it draws
  with (quads, subpixel sprites; 1.3 ms).
- **Path textures only while paths show, 4 MiB memory blocks**: GPU memory
  47.5 → 31.5 MB. What wgpu's allocator holds now is three 4 MiB blocks:
  the instance buffer (2 MiB) beside wgpu's zero-init buffer, the glyph
  atlas (4 MiB: upstream draws text with subpixel antialiasing, so its atlas
  is BGRA where the fork's is 1 MiB of alpha), and the staging block. The
  rest is the swapchain (four images, 7.7 MB, as on the fork) and the
  driver's own buffers. A FIFO swapchain changed nothing (tried).
- **No indirect-call validation**: wgpu compiled two compute pipelines with
  every device for indirect calls GPUI never makes.
- **The GPU context and the shaders prepared while the client connects**:
  the instance (12–15 ms, loading radv and its LLVM), the adapters (~5 ms)
  and a device (~4 ms) start on a background thread when the Wayland
  client starts connecting, and the shaders are parsed on another while the
  window opens; the first window takes them. Start median 42.5 → 40 ms over
  ten interleaved starts each; the first frame now reaches the screen 3–4
  ms after it is painted, where it took 7–13 ms (it parsed the shaders).
- **One system bus connection for the sleep and power-mode listeners**, and
  the sleep listener on the background executor: −2 threads (a zbus thread
  and smol's), ~0.5 MB.
- **The compose table at the first key**, and the **startup milestones**
  (`MIRIN_METAL_TRACE=1`: text system, system fonts read, GPU prepared and
  taken, GPU context, renderer, each shader module and pipeline, each font
  face).

A counter's start now (one trace): the text system 0.1–1.5 ms (the font
scan is on its thread, 8–11 ms), the Wayland client ready at 2–8 ms and the
window opened at once (the driver's first tree is there already); the GPU,
prepared since the client started connecting, ready at 16–22 ms; the
renderer 1 ms later; the first frame 9–11 ms (mirin's first render and
layout: the same 7.5 ms before the first font is asked for as on the fork);
first content frame at 31–45 ms.

What is left between upstream and host-r4 on the counter, and what it
would take:

| | MB | to cut it |
| --- | --- | --- |
| the binary mapped (shared between hosts) | +6 RSS | wgpu and naga (WGSL → SPIR-V), two AccessKit adapters, ashpd and zbus: 44 MB of binary where the fork has 33. `opt-level = "s"` or LTO for this build only (not tried) |
| the heap | +3.5 | 4.2 MB live in the main arena after the idle trim (glibc `malloc_stats`: in use, not fragmentation), where the fork has 1.7. Likely wgpu keeping both shader modules' naga IR for the pipelines still to build (Vulkan's hal translates per pipeline); not measured alone, no heap profiler on this machine |
| GPU: the BGRA glyph atlas and three 4 MiB blocks | +18 GPU | the atlas is upstream's subpixel text (a choice, not a cost to cut here); wgpu's least block is 4 MiB, so a small window holds a device, an atlas and a staging block of it |
| GPUI's accessibility adapter beside mirin's | +1.7–2.1, 1 thread | see below |
| D-Bus: the desktop portal and the system bus | ~1.3, 2 threads | both upstream features (appearance, cursor theme; sleep and power saving) |

**Accessibility: mirin's tree or GPUI's** (section 5's step 6). Both are in
the upstream build: mirin's `access/` publishes its tree through the
`accesskit_unix` fork, and every GPUI window makes its own
`accesskit_unix` 0.22 adapter, which publishes a window with no children
(mirin-metal gives no element a role). Measured on the counter with GPUI's
turned off (`Application::new_inaccessible`), mirin's turned off
(`MIRIN_METAL_ACCESSIBLE=0`) and both, three starts each:

| counter | host RSS | threads | start |
| --- | --- | --- | --- |
| both (as now) | 68.9 MB | 18 | no difference measurable |
| mirin's only | 66.8 MB | 17 | |
| GPUI's only | 66.8 MB | 17 | |
| neither | 65.2 MB | 16 | |

So each adapter costs the same to have, 1.7–2.1 MB and a thread (their bus
connections are made on that thread, after the first frame). What differs is
what each costs to keep up to date. Mirin's tree is incremental: on the
stress bench (15k nodes) an update builds the nodes that changed (2–6) and
hands over the ones that differ, 0.1 ms; it works with retained subtrees
because it is built from mirin's own tree, not from painting. GPUI's is
built while an assistive technology is connected, from every element with an
id and a role as it prepaints, and the whole tree is handed over every frame
(`A11yNodeBuilder::finalize`): 15k nodes a frame on the stress bench, and a
subtree copied in place (`reuse_prepaint`) does not prepaint, so its nodes
would be missing unless the retained port recorded and replayed them. It
would also lose the fork's adapter rows (the app's name, a window focused
at creation announced, bounds changes sent only while someone listens).
**Recommendation: keep mirin's tree, and turn GPUI's adapter off in the
upstream build (`Application::new_inaccessible` in `gpui_api/upstream.rs`)**:
−2.1 MB and a thread now, and no second, empty application for a screen
reader to find. Not switched in round 5, as its brief asked; switched
after it (GPUI's adapter is off on the upstream build).

Round 6 (the adapter's thread, `docs/metal.md` section 5b): mirin's tree
now goes through forks of AccessKit's AT-SPI layer and consumer as well
(`forks/accesskit_atspi_common`, `forks/accesskit_consumer`), which
`next/Cargo.toml` patches in as the default build's manifest does, so the
upstream build gets the same: nodes added under a parent with many
children no longer cost the adapter's thread the square of their number.
Its `cargo test --lib` and clippy pass with them.

Checks: `layout-check` of host-next-r4 against this host, `--scene`, for
`grid`, `browser`, `scroll` and `scroll-fractional`: identical, layouts and
drawings, at every step; the host against itself with
`MIRIN_METAL_RETAIN=0`, the same four: identical;
the stress bench with `MIRIN_METAL_ACCESS_CHECK=1`: no complaints. mirin's
tests on this build: 190 pass, 1 ignored. GPUI's own tests still can't run
from `forks/zed` (round 4), so `cosmic_text_system.rs`' tests (lazy faces)
did not run; mirin's text tests go through it.

### Round 6: the platform and text ports (next-platform)

Branch `next-platform` (from `metal-forks` at `467af84`). Every stand-in
this lane owned in `src/gpui_api/upstream.rs` is gone, and `src/` calls the
same GPUI API on both builds for each: `Window::start_file_drag`,
`unlock_session`, `observe_window_chrome`/`chrome_controls`,
`StyledText::with_paragraph_sizes`, `TextLayout::line_height_for_index`,
`List::on_content_origin` and `describe_glyph_variants` are called directly,
and their shims left both `gpui_api` files. `with_surface` stays a shim (the
fork takes layer options and a lock flag on `WindowOptions`, upstream a
window kind), now taking `cx` to find a screen by name. One `GAP` is left in
`upstream.rs`, round 5's `stretchable` (not this lane's). The rows are in
`forks/zed/MIRIN.md`; in short:

- **Session lock.** `WindowKind::SessionLock` (upstream's shape: a kind
  beside `LayerShell`) locks the session with ext-session-lock-v1 on the
  display `display_id` names, or the first output advertised; the lock
  surface is configured like a layer surface (no commit before its first
  configure) and unlocks only through `Window::unlock_session`.
- **Dashi's unified title bar.** The protocol XML and its bindings moved
  into `gpui_linux` (`wayland-scanner`); the chrome object lives with the
  toplevel. The upstream host used to send a `standard`/`null` chrome event
  at start that the fork never sent; it no longer does.
- **Layer surfaces.** Upstream already opened a layer surface on
  `display_id`'s output and heard the outputs' names before a window
  opened; a display now has a name (`PlatformDisplay::name`) to find it by.
  A surface anchored to both ends of an axis asks for 0 along it, at open
  and on every configure, so it stretches on any compositor.
- **File drag-out.** `start_file_drag` reuses upstream's outbound drag
  (`start_external_drag`, a gpui drag handed over as it leaves the window)
  with the fork's icon (`drag_icon.rs`), offered for copying only, and no
  `FileDropEvent::Ended` for a drag gpui never began.
- **X11 least size.** `WM_NORMAL_HINTS`, keeping the largest size upstream
  sets at open.
- **Text.** Per-paragraph sizes and `fit_to` as the fork has them, the
  measure's cut shared with `fit_to` (`cut_text`); ink-end alignment for
  the layer a line paints in too (`line_paint_bounds`, upstream's own,
  aligned by the row's full width before); a glyph of a line placed from
  the line's device position and its own distance apart
  (`Window::paint_line_glyph`, `place_glyph_x`), on upstream's rounding
  (quarter-pixel variants to nearest, halves down), so it places every
  glyph right of zero exactly as `paint_glyph` did (120,000 positions
  checked) and a whole-pixel move keeps every variant: a retained subtree
  with text is no longer refused a move across because a glyph sits by a
  variant's edge, only when its line's position is not exact in `f32`.
  Without the fork's device grid this holds at power-of-two scales. (With
  next-retain2's grid in the same tree it holds at 1.5 too wherever a
  line's device position is exact in `f32`, which on the stress bench is
  every line: "Round 6: the three lanes together".)
  Scene descriptions name each glyph's variant on request
  (`MIRIN_METAL_TRACE_SCENE_GLYPHS=1`), and a list says where it paints its
  content, so a list's rows move as one layout-map group and accessibility
  node on upstream too.

**How each was checked.** The Wayland features under the nested
`dashi-comp --backend winit` (one output, `winit`, 2240×1400), with a small
driver per mode (`out/nplat/plat/app.tsx`), its events and a `grim`
screenshot of the whole output, on `host-r5`, `host-next-r5` and this
branch's upstream host. A layer surface anchored top, left and right, and
one left, top and bottom; one naming the output `winit`, and one naming no
screen there; a window asking for the unified title bar; a lock surface,
unlocked after 4 s. This branch's host matches `host-r5` in every event
and every root size (bars 2240×300 and 400×1400, the named screen's bar
2240×300, the unknown name's surface 400×300 where the compositor put it,
the chrome `unified` with controls 76×38 at 0,0, the lock 2240×1400 and its
host exiting after the unlock), and the screenshots differ only inside
the labels' text (the two builds' glyphs). `host-next-r5` opened the lock
as a 400×300 window and reported `standard` chrome. Not exercised: the
stretch itself (Dashi stretches a surface anchored at both ends whatever
size it asks for, so both builds were already 2240 wide there; other
compositors center the asked width), choosing among two screens (the
nested compositor has one), and the drag (the simulation's drag reaches
the driver, not the compositor, and a drag needs a real press's serial).
X11 is unexercised (no X server here). Text, lists and glyphs: mirin-metal's
tests on both builds (a new one for paragraph sizes), and `layout-check
--scene` (below). Unit tests added in `forks/zed` (`line_paint_bounds`,
`place_glyph_x`, `needs_refit`, `request_size`) do not run here: zed's
workspace manifest names crates that are not imported, and `gpui`'s
dev-dependencies need one (`util_macros`); `place_glyph_x`'s was run as a
copy.

**Layout, scenes and cost.** `layout-check --scene` against
`host-next-r5`: grid, browser and scroll identical, scenes included (the
glyph placement draws the same frames). Against itself with
`MIRIN_METAL_RETAIN=0`: grid, browser, scroll, scroll-fractional and
across identical, and browser, scroll and across identical with
`MIRIN_METAL_TRACE_SCENE_GLYPHS=1` (each glyph's variant compared too).
The stress bench with `MIRIN_METAL_ACCESS_CHECK=1`: no complaints. Frame
time is unchanged within noise (stress bench, medians of five runs of
`host-next-r5` and three of this branch's host, interleaved, one loaded
run of this host left out): select 4.0 / 3.9 ms, type 3.3 / 3.6, hover
3.5 / 3.6, grow 4.2 / 4.4, grow in the scroll view 5.2 / 5.3, scroll 5.0 /
5.3, resize 10.9 / 11.4, scroll across 4.4 / 4.5, RSS idle 192 / 192 MB.
Nothing here was meant to be faster; type's 0.3 ms is the largest gap and
is inside the runs' spread (3.2–3.4 against 3.5–3.9 on a shared machine).

### Round 6: the three lanes together

The next-platform, next-retain2 and next-layout lanes, applied in that
order onto `metal-forks` (467af84) and combined. Two designs for moves met
in `retained/plan.rs` and `Window::layout_bounds`:

- next-retain2's device grid: at 1.25, 1.5 or 1.75, positions move on
  the grid (`Grid::moved_point`), and a node's origin is its device
  position and the offset divided once.
- next-layout's slack: with text a fraction of a pixel tall, a move of
  the unrounded layout within 1/64 of whole pixels is a whole move
  (`whole_move`, `holds_within`), and scroll offsets snap halves away
  from zero.

Both are kept:

- **The offset.** `layout_bounds` snaps the offset halves away from zero
  at every scale. At an exact scale it adds the snapped offset. Elsewhere
  it adds the snapped offset to the rounded device position before the
  one division. `Place::of` snaps the same way.
- **`moved_by`.** It takes the whole part of the layout move, keeps every
  grid condition, and judges the layout with `holds_within(whole, slack)`.
  `Drawn::shift` moves the origin and the mask on the grid, and the place
  and the layout's steadiness by the whole part.
- **The slack applies at every scale.** The layout is summed in device
  pixels, and what is drawn is placed from edges rounded there, so the
  grid holds whatever the unrounded move's last bits. A first build
  allowed the slack at exact scales only. At 1.5 its grow took 4.9 ms
  against 2.55 with the slack (two runs each). Both builds draw the same
  as retention off at 1.5.
- **Paint rounding at those scales stays strict.** next-layout made a
  position near a half "held" (`near`, and the binade shortcut in
  `holds_within`) instead of fixing its axis. That argument holds for
  sums, not for a logical position multiplied by a scale that isn't a
  power of two. So at 1.25, 1.5 or 1.75 a painted position within 1/64
  of a half still fixes its axis (`Steadiness::round_half_scaled`), as
  under next-retain2 alone.
- **One more fix.** next-platform's per-paragraph line height was still
  snapped to the device pixel, where next-layout stopped snapping the
  text's. It is now unsnapped too, as on the fork. mirin-metal's
  `a_paragraph_sized_larger_takes_its_own_line_height` caught it.
- **Glyphs at 1.5.** next-platform's glyphs placed from their line, with
  next-retain2's grid, take scrolling across at 1.5 from 12.1 ms to 3.0:
  every line's device position on the stress bench is exact in `f32`.
  Settling a line's position on the grid first, as the fork's `glyph_x`
  does, was tried and measured no faster there (3.15 against 3.2 ms, two
  runs each), so it is left out.

**Correctness** (`host-int4`, the integrated release host):

- **Against itself.** `layout-check <app> host host --visible --scene
  --env-b=MIRIN_METAL_RETAIN=0` for `grid`, `browser`, `scroll`,
  `scroll-fractional` and `across`: every step lays out and draws the
  same, at 1 and with both hosts at `MIRIN_METAL_SCALE=1.5`.
- **Against `ref/host-r5`** (`--visible`): every node's bounds are the
  same at every step of `grid`, `scroll` and `scroll-fractional`, and of
  `browser` but the card example's 20 nodes (taffy 0.9's short card,
  above). `scroll` and `scroll-fractional` also differ in which hover
  events are heard when content moves under a resting pointer (10
  steps each), as before.
- **Accessibility.** `MIRIN_METAL_ACCESS_CHECK=1` over the stress bench:
  no complaints.
- **Tests.**
  - mirin-metal on the upstream build: 205 pass, 1 ignored.
  - On the default build: 194 pass, 1 ignored.
  - taffy-next: 175 pass.
  - `grid.rs`, `steady.rs` and `whole_move`, compiled alone: 6 pass.

**Measured** (release hosts, `bench/stress.tsx --visible`, ~15k nodes,
interleaved, two runs each, medians; frame per update, host CPU per
update in parentheses):

| stress bench | host-int4 (integrated) | host-r5 (default build) | host-next-r5 |
| --- | --- | --- | --- |
| select | 2.2 ms (4.5) | 2.5 ms (4.75) | 3.8 ms (6.0) |
| type | 1.85 ms (4.5) | 1.65 ms (3.75) | 3.1 ms (6.25) |
| hover | 2.2 ms (3.25) | 2.25 ms (3.5) | 3.35 ms (4.5) |
| grow | 1.8 ms (4.6) | 3.8 ms (5.4) | 3.85 ms (5.8) |
| grow in a scroll view | 3.1 ms (5.0) | 3.7 ms (5.8) | 5.1 ms (7.9) |
| select in a scroll view | 3.4 ms (5.8) | 2.55 ms (4.2) | 3.75 ms (6.7) |
| scroll | 3.0 ms (4.8) | 2.75 ms (4.2) | 4.85 ms (6.6) |
| resize | 1.8 ms (5.4) | 2.25 ms (4.2) | 10.7 ms (13.75) |
| scroll across | 3.05 ms (4.8) | 2.9 ms (4.2) | 4.25 ms (6.15) |
| RSS idle / at the end | 196 / 290 MB | 200 / 311 MB | 192 / 284 MB |

At `MIRIN_METAL_SCALE=1.5` (two runs each, interleaved; `host-next-r5`
has no scale override):

| at 1.5 | host-int4 | host-r5 |
| --- | --- | --- |
| select / type / hover | 2.15 / 1.8 / 2.05 ms | 2.4 / 1.45 / 2.3 ms |
| grow / grow in a scroll view | 2.0 / 3.0 ms | 6.5 / 6.85 ms |
| select in a scroll view | 3.2 ms | 2.65 ms |
| scroll / scroll across | 3.15 / 3.0 ms | 2.65 / 2.85 ms |
| resize | 1.95 ms | 2.1 ms |
| RSS idle / at the end | 233 / 285 MB | 215 / 318 MB |

### metal-0.9: Dashi 0.8's features on upstream GPUI

`metal-0.9` is Dashi 0.8.0's mirin (`wave5-0.8` at `a79a137`) with
`metal-forks` merged. 0.8 added six changes to the vendored GPUI and taffy
(now in `forks/gpui` and `forks/taffy`). On the upstream build each is
ported or already upstream's; none needed a `GAP` stand-in:

| 0.8 change | Upstream build |
| --- | --- |
| A long URL breaks after a slash or a hyphen | Upstream's own: GPUI wraps at UAX #14 break opportunities (`LineWrapper::break_indices`), which allow both. `render::wrap_tests`' three layouts pass as they are; the fork's rule itself (`LineWrapper::breaks_inside_word`, one unit test, `cfg`'d to the default build) may differ at the edges (a path's first slash, a run of hyphens). |
| Baseline alignment (`items_baseline` by a text's first baseline) | Ported (`forks/zed`: `set_layout_first_baseline`; the baseline rides on GPUI's node context into the leaf's output, so `forks/taffy-next` is unchanged). |
| A card as tall as its rows at its least width (taffy's cache) | Not needed: taffy 0.15 answers a query only from an entry for the same query. `render::card_tests` passes unchanged. |
| Tab stops (`tabSize`) | Ported (`forks/zed`: `apply_tab_stops`, `shape_text_tabbed`, `StyledText::with_tab_size`, the tab size in the line layout cache's key). |
| A continuous source's scroll moves as far as it says | Ported (`forks/zed`: `pixel_scroll_factor` in `gpui_linux`'s Wayland client). |
| A one-line text that fits its own box is not cut (`CUT_SLACK`) | Ported (`forks/zed`: `cut_text`, `needs_refit`). |

`host-next-09` (this build) against `host-next-r6` with `--scene`: the
same layouts and drawings in `grid`, `browser`, `scroll` and
`scroll-fractional`; retained against `MIRIN_METAL_RETAIN=0`, the same in
those and `across`. Against the 0.8.0 host it differs as the default build
does (`docs/metal.md` section 5b, "metal-0.9"), plus the `browser` card
taffy 0.15 lays out 11 px higher. Stress bench, frame (medians of two):
select 2.05 ms, type 1.55, hover 2.25, grow 1.75, grow in a scroll view
3.0, select in one 3.35, scroll 2.8, scroll across 2.55, resize 2.2; RSS
idle 195 MB.

### sumi step 1: a small app's footprint, and other scale factors (sumi-footprint)

Branch `sumi-footprint` (from `metal-arch` at `0e2e2e9`), lane B of step 1
of `engine.md`: the counter's footprint, the stress app's RSS at 1.5, and
layouts at 1.25, 1.5 and 2. Measured against `ref/host-main` (the default
build at the base) and `ref/host-next-main` (the upstream build at the
base), as "How this was measured" says, on the shared laptop while the other
lane built and benched.

**Where a counter's GPU memory was.** `fdinfo` gives a total, so every
buffer the driver made was logged instead: a preloaded shim around `ioctl`
that prints each `DRM_IOCTL_AMDGPU_GEM_CREATE` (size, domain) and each close,
on both hosts, with wgpu's own allocator report beside it
(`Device::generate_allocator_report`). The counter, two frames drawn:

| GPU buffers alive (MiB) | upstream at the base | default build | upstream now |
| --- | --- | --- | --- |
| command buffers (radv: 80 KiB each, and 16 KiB of uploads for those used) | 100: 8.0 | 6: 0.5 | 16: 1.4 |
| the allocator's shared blocks | 3 × 4: 12.0 (6.5 in use) | 1.0 + 3 × 0.25 | 2 + 1: 3.0 (1.8 in use) |
| swapchain, four images | 8.8 (made twice at start) | 8.8 | 8.8 (made once) |
| shader code and the rest | 1.0 | 0.8 | 1.0 |
| alive | 29.8 | 11.8 | 14.2 |

Round 5 took the 11 MB outside the allocator for "the driver's own
buffers". Most of it was wgpu's: wgpu-hal allocates command buffers 16 at a
time for every encoder wgpu-core has opened (a frame's, the queue's pending
writes, more while frames are in flight), and radv backs each with 80 KiB
when it is allocated, recorded into or not. And the allocator's least block
was 4 MiB twice over (wgpu-hal clamps what GPUI asks for, gpu-allocator
clamps again), so the 2 KiB of staging buffers held one, the buffers
another, and the BGRA glyph atlas (4 MiB at 1024²) filled a third.

What changed (rows in `forks/wgpu/MIRIN.md`, `forks/gpu-allocator/MIRIN.md`
and `forks/zed/MIRIN.md`):

- **Two small forks**, patched in by `next/Cargo.toml` alone: `forks/wgpu`
  (wgpu-hal alone, at the commit zed pins; the rest of wgpu stays the
  repository's) and `forks/gpu-allocator` (0.28.0). wgpu-hal allocates one
  command buffer at a time (its free list still reuses them), and both let a
  shared block be as small as 256 KiB. Neither can be done from GPUI: wgpu
  has no option for either. Three lines of code and a manifest between them.
- **Blocks of 2 MiB that double to 8** (host blocks: 1 to 4), where round 5
  had 4 MiB, the least wgpu allowed.
- **The first atlas texture of colors is 512²** (1 MiB, what the default
  build's first glyph atlas takes), the rest 1024² as before, and **a
  window's instance buffer starts at 256 KiB** and doubles in the frame that
  outgrows it (upstream: 2 MiB). So a counter's buffers and atlas share one
  2 MiB block.
- **A window's renderer starts with the transparency the window will
  have**: the swapchain was made, freed and made again before the first
  frame (the half of the default build's row round 5 did not port).

The stress app allocates as many blocks as before and none per frame (51
buffers made over a run where it made 134; 28 MiB alive at the end where it
had 38.5): its staging buffers still fit the host blocks, which grow to
4 MiB as they did.

**The stress app at 1.5** held 233 MB at idle where it holds 195 at 1 (the
default build: 217 and 203). Sampling the host's mappings showed one
anonymous region twice the size at 1.5, and logging allocations of 8 MiB or
more with their backtraces named it: taffy's node storage (1,288 bytes a
node on taffy 0.15). A window opens at a scale of 1 and learns its scale
factor with its first configure, so its second frame makes every retained
subtree anew; each lets its old nodes go once the new ones are made, and
they were freed at the frame's end. The frame held the tree twice (35,200
nodes for 17,600), and the storage, which never shrinks, stayed at 90 MB
where it is 45 at 1. The nodes let go so far are now freed when the next
subtree starts making its own (`TaffyLayoutEngine::free_released`), which
take their places. This is what a real display at 1.25, 1.5 or 2 does too,
not only `MIRIN_METAL_SCALE`.

**The first frame.** A profile of 25 starts (`--features profiling`, 1 kHz)
put two things inside the counter's first frame that are not drawing:
`render::sans_family` running `fc-match` for the system's sans family (7–8 ms,
on both builds: round 5's "7.5 ms before the first font is asked for"), and
cosmic-text building its list of matching faces for the first text of each
weight (`FontSystem::get_font_matches`: it opens every installed face whose
weight differs to read its weight axis, 713 faces here, 2 ms of CPU and the
file system's time). The main thread waits ~15 ms for the GPU before that
frame, so both now run on a thread as the host starts
(`render::warm_fonts`: the family, upstream's `TextSystem::prewarm_fonts` for
its four weights, then the monospace family, which the first monospace text
otherwise waits for mid-frame). The default build gets the family alone (its
GPUI has no prewarm: a `GAP` shim in `gpui_api/fork.rs`).

**Layouts at 1.25, 1.5 and 2.** Upstream rounded every authored length and
border width to the device pixel before layout (`to_taffy`); the default
build keeps them as authored and rounds only the edges that result. At 1.25,
3,039 of `grid`'s 3,044 nodes differed between the builds. Lengths now reach
taffy unrounded (`AbsoluteLength::to_taffy`, borders, grid tracks; a scroll
view's padding is no longer snapped either), and a scroll view's extent is
rounded as its size is (the default build reads it from taffy 0.9's rounded
layout; unrounded, a view scrolled to its end and 0.4 px back painted a
device pixel away at 1.25 and 2). Borders still paint at whole device
pixels. A test lays out lengths of half a device pixel on both builds
(`render::scale_tests`).

| `layout-check`, layouts against `ref/host-main` | 1.25 | 1.5 | 2 |
| --- | --- | --- | --- |
| `grid` (11 steps) | identical | identical | identical |
| `browser` (12 steps) | the card's 20 nodes | the card's 20 nodes | the card's 20 nodes |
| `scroll` (33 steps) | identical; hover lines | identical; hover lines | identical; hover lines |
| `scroll-fractional` (31 steps) | identical; hover lines | identical; hover lines | identical; hover lines |

The card is taffy 0.9's short card (round 6), at every scale. The hover
lines are the ones known at 1: which hover events are heard when content
moves under a resting pointer (10 to 17 steps), no node's bounds. Retained
against `MIRIN_METAL_RETAIN=0` with `--scene`, the same four apps at 1,
1.25, 1.5 and 2: `grid`, `browser` and `scroll-fractional` lay out and draw
the same at every step. `scroll` does in most runs; in the others two to
four steps differ in a hover: the retained host hears (and draws) a card
hovered after a scroll or a resize a step before or after the other does.
It is timing, and the person's own pointer crossing the bench's visible
window, not this branch: the same check passes when run again on a quiet
machine (at 1, twice; at 1.5; at 2), `ref/host-next-main` gave the same
alternate drawings against itself and against this host (the digests
match), and no node's bounds ever differ. Against `ref/host-next-main` with `--scene` at 1, all
four apps are identical, layouts and drawings: at a scale of 1 with
whole-pixel lengths nothing here changes what is drawn.

**Measured** (`ref/host-next-main`, this branch's host, `ref/host-main`;
`bench/footprint.tsx --visible`, three starts a run, two runs each for the
counter and one for the browser; `bench/stress.tsx --visible`, two runs
each, both given; interleaved, under the bench lock):

| counter demo, 800×600 | upstream at the base | this branch | default build |
| --- | --- | --- | --- |
| host RSS | 67.1 / 67.5 MB | **64.6 / 65.2 MB** | 59.6 / 59.7 MB |
| private dirty | 11.6 MB | 9.4 MB | 7.5 MB |
| GPU memory (gtt + vram) | 31.8 MB | **16.2 MB** | 13.8 MB |
| host start → first content frame (a run's median) | 40 / 73 ms | **30 / 33 ms** | 34 / 46 ms |
| the same, medians of 15 and 12 interleaved starts | 35 ms (before the fonts' thread) | **30 / 27.5 ms** | 30 ms |
| threads, idle | 15, 0 wakeups | 15, 0 wakeups | 15, 10 wakeups per 5 s |
| of RSS: binary / heap and anonymous / fonts | 21.1 / 7.0 / 0.3 MB | 20.3 / 5.1 / 0.3 MB | 17.1 / 3.4 / 0.4 MB |

| example browser, 1440×900 | upstream at the base | this branch | default build |
| --- | --- | --- | --- |
| host RSS | 73.7 MB | **70.9 MB** | 65.6 MB |
| GPU memory | 47.2 MB | **35.6 MB** | 29.2 MB |
| host start → first content frame | 66 ms | **50 ms** | 49 ms |

| stress bench, 15k nodes | upstream at the base | this branch | default build |
| --- | --- | --- | --- |
| RSS idle, at 1 | 192 / 188 MB | **185 / 187 MB** | 197 / 197 MB |
| RSS idle, at 1.5 | 228 / 233 MB | **196 / 202 MB** | 213 / 211 MB |
| RSS at the end, at 1 | 281 / 280 MB | 277 / 277 MB | 309 / 313 MB |
| select / type / hover, at 1 | 2.4–2.5 / 1.3–2.0 / 2.2–2.3 ms | 2.2 / 1.6–1.9 / 2.2–2.5 ms | 1.9–2.5 / 1.6 / 2.2–2.4 ms |
| grow / scroll / resize, at 1 | 2.0–2.2 / 3.1–3.4 / 2.1–2.2 ms | 1.5–2.3 / 3.0 / 2.1–2.5 ms | 3.5 / 2.9–3.0 / 2.3 ms |
| grow and select in a scroll view / scroll across, at 1 | 2.8–3.5 / 2.6–3.9 / 3.0–3.5 ms | 3.2–3.7 / 3.2–4.2 / 3.1–3.2 ms | 3.2–3.9 / 2.4–2.7 / 2.9–3.1 ms |

Frame times are the other lane's subject and are here to show nothing in
this one moved them: the two upstream hosts are within each other's
spread on every scenario (the machine was shared; a run's medians differ
by up to 0.7 ms on the same host).

**What is still over the budget** (59 MB, 14 MB, 33 ms; noise 3 MB):

| | over | what it is, and what it would take |
| --- | --- | --- |
| counter RSS | +5 MB (64.9 against 59.7) | the binary mapped, +3 MB (24.2 MB of code against 18.2: wgpu, naga, two shader modules' validation), shared between hosts: thin LTO built the same size (46.1 against 45.9 MB) and leaving wgpu's GL backend out saved 0.4 MB of code, so neither is in. Heap and anonymous memory, +1.7 MB (5.1 against 3.4; it was +3.6): not found, there is no heap profiler on this machine; `opt-level = "s"` and fat LTO were not tried (each a build of several minutes) |
| counter GPU memory | +2.4 MB (16.2 against 13.8) | inside the noise the budget allows. 16 command buffers where the default build has 6 (0.9 MB: wgpu-core records a frame into several and keeps a pool per encoder), 3 MiB of blocks where it has 1.75 |
| first frame | none (30–33 ms) | what is left is the GPU: the instance, adapters and device are ready 18–22 ms after the host starts and the surface and renderer 5 ms later; the frame itself follows within 1–2 ms |

Not done, with what was learned: making the renderer when the first frame
is drawn rather than when the window opens would let the first layout run
while the GPU starts, but with the fonts warmed the layout is no longer
what the frame waits for. cosmic-text's match list still costs 2 ms on the
main thread for a weight that first appears after the first window's tree
(`FontMatchKey::new` opens every face of another weight); a per-face cache
of weight axes there would end it, in a fork of cosmic-text.

Checks: both builds `cargo fmt --check`, `cargo clippy --all-targets -- -D
warnings` and `cargo test` (the default build 217 and 8 pass, 1 ignored; the
upstream build 227 and 8 pass, 1 ignored; one new test on both); the GPUI
fork's own tests 96 pass; gpu-allocator's fork builds its tests (it has none
without a device); wgpu-hal's do not run from `forks/wgpu` (see its
`MIRIN.md`). The stress bench with `MIRIN_METAL_ACCESS_CHECK=1`: no complaints.


### State, what is left, and the default

The branch builds both hosts, the default exactly as before; the upstream
host runs every bench and passes its tests, with retained subtrees that
move, are left out, park their drawings and are built again onto their
kept nodes (round 5). Left of section 5's steps, updated:

| Step | What is left | Effort |
| --- | --- | --- |
| 1 | done (import, side-by-side build, re-sync recipe) | — |
| 2 | done in round 6 (next-platform, below): per-paragraph sizes, `fit_to`, the rest of ink-end alignment, glyph variants in scene traces, the list's content origin. Left: none of the fork's text rows; a fit when a truncated text wraps at another width than it was measured at keeps the measured wrap width, as the fork does | — |
| 3 | done | — |
| 4 | done in round 6 (next-platform, below). Left: the file drag with its icon exercised by a person's real press (no simulated input reaches the compositor), the lock and the layer screen on a session with two screens | ½ day (by hand, on Dashi) |
| 5 | retained: done in rounds 5 and 6 (moves, skips, parked drawings, building onto kept nodes, `insert_spanning`, element state scopes, the mask map, the device grid, stretchable rows, moves of fractional layouts, glyphs placed from their line; resize is at host-r5's 1.8–2.3 ms with taffy-next's row answered from another width). Left: select in a scroll view (3.4 ms against host-r5's 2.55, not profiled yet), a keystroke and scroll (0.2–0.3 ms over), and moving a drawing with masks pushed inside where scaling is not exact (the mask's producer sums it in logical pixels) | 1–2 days |
| 6 | footprint: done in round 5 (below), but for the binary's size and the heap; accessibility: mirin's `access/` kept, GPUI's adapter turned off (below) | — |
| 7 | layout: decided and done in round 6 (round as the fork does; `grid`, `scroll`, `scroll-fractional` lay out the same as host-r5, `browser` but the card taffy 0.9 makes too short). Left: other scale factors (upstream rounds authored lengths before layout), check every Dashi app, benches, footprint; switch the default; delete `forks/gpui`, `forks/taffy`, `forks/blade-graphics` | 2–4 days |

About 10–17 working days remain (round 6: step 5 from 4–6 days to 2–3) of the 23–34 the spike estimated (with
both round 5 lanes merged: retention's 16–24 counted step 6 at 4–6 days,
and the footprint lane did most of it). The retained port is no longer
the uncertain part: what moves costs 1–6 ms over host-r4 on upstream
instead of 100–150 ms more. Dashi's layouts (step 7) are now as large.

After round 6's next-platform lane (steps 2 and 4 done, less half a day
of checking the drag, the lock and the layer screen by hand on Dashi with
two screens): about 7–14 working days remain, steps 5 to 7 and that
check, before the other round 6 lanes' share of step 5 is counted.

With all three round 6 lanes in one tree ("Round 6: the three lanes
together" above): steps 2 and 4 done (less the half day by hand on Dashi),
step 5 down to 1–2 days, step 7 to 2–4. Step 6 is done too (GPUI's
adapter is off). About 4–7 working days remain.

**Not switching the default (round 5).** Moving no longer blocks it: grow,
scroll and scroll across cost 4–6 ms a frame on upstream (host-r4: 2.4–3.7),
resize 14 ms (8.5). What still does: every interaction on the upstream host
costs about twice host-r4's frame (select 3.9 against 1.9 ms, a keystroke
3.1 against 1.1, a resize 14 against 8.5), it holds 30 MB more at idle on
the stress app (231 against 202 MB) and far more on a small app (the
footprint lane's), layouts still differ by a pixel where text has a
fractional line height (step 7), and accessibility runs two trees (step
6). The default stays on `forks/gpui`. The switch is right once step 5's
remainder (element state scopes and `insert_spanning` for interactions;
the mask map for rows clipped at a view's edge) and steps 6 and 7 land:
then no bench is worse by more than noise, and every week on the fork
adds work in code upstream has replaced.

**Round 6 (next-retain2).** Interactions and moves no longer block it:
select, hover, grow, scroll and scroll across now cost what they cost on
host-r5 within noise or less (grow in a scroll view 2.85 against 3.5 ms),
a keystroke and select in a scroll view 0.45 and 0.7 ms more; at 1.5 grow
and scroll cost 3.2 and 2.9 ms (host-r5: 6.8 and 3.1). Left on retention:
scrolling across at fractional scales (glyph placement), and resize
(layout). The rest of the case above (footprint, step 6, step 7) stands.

**Round 6, the three lanes together.** No stress bench on the upstream
host is now slower than host-r5 by more than 0.3 ms, but select in a
scroll view (3.4 against 2.55 ms). Grow is twice as fast (1.8 against 3.8)
and resize faster (1.8 against 2.25). At 1.5 the upstream host matches or
beats host-r5 except scroll and select in a scroll view (0.5 ms over).
Layouts match host-r5 but the card taffy 0.9 lays out too short. What
still blocks the switch:
- that select;
- the footprint (RSS at idle is 196 against 200 MB at 1, but 233
  against 215 at 1.5);
- accessibility's two trees (step 6);
- step 7's checks of Dashi's apps at other scale factors.

**sumi step 1, frame time (`sumi-frame`, 2026-11-14).** The frame-time
blockers above are closed at a scale factor of 1; scroll at 1.5 is not.

- **Select in a scroll view was not the scroll view.** Run alone
  (`stress.tsx --only=select/sc`) it cost what a plain select does, on both
  builds; it cost 3.1–3.5 ms only after the bench's scroll. A subtree that
  can't be copied is built again from prepaint, while the subtree around it
  is watched for the entities it reads, and mirin-metal's build reads the
  root view: the one around then counted as notified on every frame and was
  never left out again. Every row that scrolled out of view after a card in
  it had been built so stayed in the frame, copied unseen (56 subtrees
  copied a select where 40 show, more with every row scrolled past). What a
  build reads now counts for the frame alone (`App::unattributed_accesses`).
- **A frame that copies most of a window copied too much.** Profiles of a
  keystroke, a select and a scroll put most of the frame in copying last
  frame's drawing: every record inside a copied subtree gone over twice a
  frame (now told only when next looked at), each primitive copied five
  times (two), dispatch nodes pushed and popped through three stacks (one
  pass), a line layout's key hashed twice a frame (kept), and, after the
  frame, every entity the window read removed and inserted again (only
  what changed). `forks/zed/MIRIN.md` has a row each.
- **Measured** (`stress.tsx --visible`, release hosts, a quiet machine,
  two interleaved runs each, medians; frame ms):

  | scale 1 | `sumi-frame` | `host-next-main` | `host-main` |
  | --- | --- | --- | --- |
  | select / type / hover | 1.6 / 1.0 / 1.75 | 1.9 / 1.4 / 2.15 | 1.85 / 1.0 / 1.95 |
  | grow / scroll / resize | 1.45 / 2.65 / 1.8 | 1.95 / 3.05 / 2.0 | 3.3 / 2.55 / 2.3 |
  | select / grow in a scroll view | 1.65 / 1.7 | 3.1 / 2.95 | 2.2 / 3.55 |
  | scroll across | 2.35 | 2.9 | 2.4 |
  | RSS idle / at the end | 194 / 282 MB | 193 / 280 MB | 203 / 312 MB |

  | at 1.5 | `sumi-frame` | `host-next-main` (one run) | `host-main` |
  | --- | --- | --- | --- |
  | select / type / hover | 1.75 / 1.05 / 1.85 | 2.0 / 1.4 / 2.2 | 1.9 / 1.0 / 2.0 |
  | grow / scroll / resize | 1.7 / 2.9 / 2.2 | 1.8 / 3.0 / 2.2 | 6.55 / 2.5 / 2.45 |
  | select / grow in a scroll view | 1.95 / 1.85 | 3.3 / 3.1 | 2.2 / 7.0 |
  | scroll across | 2.35 | 2.7 | 2.45 |

  Instructions the window's thread runs per frame (a host built with
  `--features profiling` counts them; load does not move them), millions,
  before these changes, after, and the default build: select 9.45 / 7.17 /
  8.69, a keystroke 5.74 / 4.08 / 5.72, scroll 16.23 / 10.41 / 15.40,
  select in a scroll view 15.47 / 8.21 / 9.33.
- **Left.** Scroll at 1.5 is 0.4 ms over the default build (2.9 against
  2.5), as before; at 1 it is at the default build's (2.65 against 2.55).
  A scroll frame builds the grid again onto its nodes and moves every row
  in view, with the row under the pointer and its card drawn again, and on
  the way down the row coming into view is shaped for the first time (21 of
  the bench's 48 frames). What is left of it is the copy itself (scene
  operations, dispatch nodes, hitboxes), which the retained frame
  (`engine.md`, step 4) removes; at 1.5 a drawing with masks pushed inside
  still does not move. Correctness: `layout-check` against
  `host-next-main` with `--scene` (`grid`, `browser`, `scroll`,
  `scroll-fractional`) and against itself with `MIRIN_METAL_RETAIN=0` (those
  and `across`, at 1 and at 1.5): identical at every step; against
  `host-main`, the known differences only.

**sumi step 1, lane B (sumi-footprint).** Of what blocked the switch above:
the footprint at 1.5 is closed (stress RSS at idle 196–202 MB at 1.5 against
the default build's 211–213, and 185–187 against 197 at 1), and layouts at
1.25, 1.5 and 2 now match the default build but for the card taffy 0.9
makes too short (step 7's "other scale factors"). The counter is at 16 MB
of GPU memory (budget 14, within its noise) and a first frame of 30–33 ms
(budget 33); its RSS is 65 MB against 59, the binary's size and 1.7 MB of
heap ("sumi step 1: a small app's footprint" above). Two forks joined for
it, `forks/wgpu` (wgpu-hal alone) and `forks/gpu-allocator`. Left of step
7: checking Dashi's apps themselves at their scale factors, by eye.

## How this was measured

- Hosts: `/tmp/claude-1000/host-r1` (round 1, `5fbcfb7`) and
  `spikes/gpui-next/target/release/mirin-metal-host`, both `cargo build
  --release` with the default release profile. For the counter's memory both
  were copied to the same disk directory first (see the note under its
  table); the stress and browser runs used round 1's host from `/tmp`, so its
  RSS there may read low by up to 13 MB.
- Every run through `/tmp/claude-1000/runbench.sh` (a nested dashi-comp,
  one bench at a time machine-wide), alternating hosts, on an AMD Radeon 890M
  laptop while other builds ran. Medians per run; ranges are across runs.
- `total` (input to painted frame) is the nested compositor's once-a-second
  frame callback (`docs/metal.md`, 5b) and is left out.
- Counter startup and memory: `bench/footprint.tsx` from the footprint lane
  (`perf-footprint`, `4dbca91`), three starts per run.
- Tests: `cargo test --lib` in `spikes/gpui-next` (GPUI's test platform, no
  GPU).
- Fork-change classification: read against the upstream checkout and the
  taffy 0.15.0 source, not run; sizes are the fork's diff against
  `forks-upstream`.
