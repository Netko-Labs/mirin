# mirin's fork of upstream GPUI

The GPUI crates of the zed repository (Zed Industries, Apache-2.0) at
commit `f8cfc7ed` (`../README.md` says what is here and how to re-sync),
forked in the monorepo so `crates/mirin-metal` can build on upstream GPUI
(`crates/mirin-metal/next/Cargo.toml`) beside the fork of gpui 0.2.2
(`../gpui`) until it replaces it (`docs/metal/gpui-next.md`). Every change is
listed here and marked with a `// mirin:` comment in the source. Rows that
port a change of `../gpui` say which (`../gpui/MIRIN.md`).

| Change | Files | Why |
| --- | --- | --- |
| Explicit grid track lists (`Style::grid_template_columns` / `grid_template_rows`, `GridTrack`, `TrackBreadth`) | `crates/gpui/src/style.rs`, `crates/gpui/src/taffy.rs` | Port of `../gpui`'s row: Tailwind `grid-cols-[16px_1fr]`, `grid-cols-[1fr_auto]`; upstream has only `repeat(N, minmax(_, 1fr))` (`GridTemplate`). A pixel breadth is rounded to device pixels as upstream rounds every length. Upstreamable. |
| `justify_items` / `justify_self` | `crates/gpui/src/style.rs`, `crates/gpui/src/taffy.rs` | Port of `../gpui`'s row: grid inline-axis alignment (`justify-self-end`, `justify-items-center`). Upstreamable. |
| Text min-content width is the widest word | `crates/gpui/src/elements/text.rs` (`widest_word`; a layout is reused only for the same wrap width) | Port of `../gpui`'s row: taffy asks text for its min-content size when sizing `auto`/`1fr` grid tracks and flex items; GPUI gave no wrap width there, so the text never wrapped. With min-content wrapping, an unwrapped query must not get the wrapped size back: upstream reused any layout for a query without a wrap width. Upstreamable. |
| A scroll view scrolls by taffy's content size (`Window::layout_scroll_extent`, `TaffyLayoutEngine::layout_scroll_extent`; `Interactivity::scroll_extent`) | `crates/gpui/src/taffy.rs`, `crates/gpui/src/window.rs`, `crates/gpui/src/elements/div.rs` (tested in mirin-metal's `render::scroll_tests`) | Port of `../gpui`'s row. Upstream still scrolls over the span between the children's border boxes plus the padding. taffy 0.15 measures the scrollable overflow from the padding box (`scrollable_overflow_rect`) and adds a scroll container's end padding itself; the extent is that, the start border and the end border. Upstreamable. |
| The wheel scrolls the innermost view that can still move, then the one around it (`wheel_scroll`; the list's `scroll` says whether it moved) | `crates/gpui/src/elements/div.rs`, `crates/gpui/src/elements/list.rs` (tested in mirin-metal's `render::scroll_tests`) | Port of `../gpui`'s row: every scroll view under the pointer took every turn, unclamped until the next frame, so a list in a page scrolled the page with it. Upstreamable. |
| A list's scroll bar range counts its padding (`max_scroll_offset`) | `crates/gpui/src/elements/list.rs` | Port of `../gpui`'s row (upstream now shares `max_scroll_offset` between the bar's range and its offset at the bottom). Upstreamable. |
| A line cut to a width narrower than its ellipsis draws nothing | `crates/gpui/src/text_system/line_wrapper.rs` (`truncate_line`; tested in mirin-metal's `render::one_line_tests`) | Port of `../gpui`'s row: the cut kept the affix whatever the width, so a box a few px wide drew a sliver of "…". Upstreamable. |
| Retained subtrees, in place (`retained(id, view, version, build)`, `Retained::on_prepaint`, `RetainedDraw`, `take_built_apart`; `movable` and `skippable` accepted, unused yet) | `crates/gpui/src/elements/retained.rs`, `crates/gpui/src/elements/mod.rs`, `crates/gpui/src/window.rs` (`retained_detached`, `retained_nested`, `layout_engine_mut`, `prepaint_range_valid`, `paint_range_valid`, `PrepaintStateIndex::rebase`, `PaintIndex::rebase`), `crates/gpui/src/text_system.rs` and `text_system/line_layout.rs` (`layouts_range_valid`, `LineLayoutIndex::rebase`) | Port of `../gpui`'s first retained rows onto upstream's frame model (`docs/metal/gpui-next.md`, "Retained subtrees on upstream GPUI"): a subtree whose content and view did not change keeps its taffy nodes, and where it lands as it was drawn (bounds, content mask) last frame's prepaint and paint ranges are copied, as `AnyView::cached` copies a view's, but sized from its content and nested. Anywhere else it is built again and laid out apart as its kept nodes sit. Upstreamable in spirit. |
| The layout engine keeps a tree across frames (`begin_owned`/`end_owned`, `released`, `contains`, `place_detached`; `clear` frees only the frame's own nodes and released ones, or everything when nothing is retained) | `crates/gpui/src/taffy.rs` | Retained subtrees keep their taffy nodes and taffy's cache. A copy laid out apart takes its twin's size and is rounded from where the twin sits (`detached_origins`), so its edges land where the twin's do: upstream snaps absolute edges. |
| A notified view is dirty itself, not only the views on its dispatch path (`Window::mark_view_dirty`) | `crates/gpui/src/window.rs` | Retained subtrees set their views on their parent's dispatch node, one after another, so the node names the last; the path from a notified sibling then skipped it, and a card's hover change was copied stale while its row was rebuilt (found by `layout-check scroll --scene` against `MIRIN_METAL_RETAIN=0`). Upstreamable (sibling `AnyView`s set on one node have the same gap). |
| A hover listener compares with what the frame paints (`hover_state.element` set at paint from the hit test) | `crates/gpui/src/elements/div.rs` | Upstream paints a hover style from the hit test but notifies only when a mouse move changes `hover_state`, which only mouse moves set: content that scrolled under a resting pointer was painted hovered, and when the pointer then left, nothing was notified; a view copied from that frame (a retained subtree, `AnyView::cached`) kept the hover color (found by `layout-check scroll --scene` against `MIRIN_METAL_RETAIN=0`). Upstreamable. |
| `Window::scene_drawn`, `scene_digest` (hidden); `Scene::describe`, `Primitive::describe` | `crates/gpui/src/window.rs`, `crates/gpui/src/scene.rs` | Port of `../gpui`'s row: the primitives and hittable hitboxes of the frame being painted, without draw orders or atlas places, and a digest of them; mirin-metal traces it (`MIRIN_METAL_TRACE_SCENE`) so `layout-check --scene` can tell that retained subtrees draw what drawing everything does. |
| The least size can change after the window opened (`PlatformWindow::set_min_size`, `Window::set_window_min_size`) | `crates/gpui/src/platform.rs`, `crates/gpui/src/window.rs`, `crates/gpui_linux/src/linux/wayland/window.rs` | Port of `../gpui`'s row, Wayland only (`xdg_toplevel.set_min_size`, applied with the next frame, which it asks for); X11 and the other platforms keep the first, as before the fork's X11 half is ported. Upstreamable. |
| A resize asked of a maximized or full-screen window keeps its size and moves the size it goes back to by as much (`restored_size`) | `crates/gpui_linux/src/linux/wayland/window.rs` | Port of `../gpui`'s row: an app that widens its window to show a sidebar while zoomed set the window's geometry, and the compositor took it out of the maximized state. Upstreamable. |
| A wrapped line is aligned by where its ink ends (`ink_end_x`, `wrapped_line_end_x`; `paint_line`, `paint_line_background` and `aligned_origin_x` take the text) | `crates/gpui/src/text_system/line.rs` (tested in mirin-metal's `render::tests`) | Port of `../gpui`'s row: a right-aligned or centered text that wrapped at a space kept that space at the end of the line. `LineLayout::paint` has no text and aligns as before. Upstreamable. |

Fork changes upstream has in its own way (nothing to port; see
`docs/metal/gpui-next.md` for the evidence): layer-shell surfaces and the
screen they open on, typed float literals, idle windows that stop
committing, the loop outliving its last window (`QuitMode::Explicit`),
text input only while a field takes text, the toplevel's suspended state
(as window visibility), a layout reused only for the same truncation
width, a line cut from a copy of its runs, no-break spaces and quotes
(UAX #14), `DispatchEventResult` public, and scroll views painted at whole
device pixels (`Window::layout_bounds` snaps the element offset; always on,
so `MIRIN_METAL_SCROLL_SNAP=0` has no effect on this build).

To update: see `../README.md` (merge the `forks-upstream-next` branch), then
reconcile the changes above.

Checks: mirin-metal's tests on this fork, `cd crates/mirin-metal/next &&
cargo test --lib` (the shared sources, with `--features gpui-next` by
default), and `cargo clippy --all-targets -- -D warnings` there.
