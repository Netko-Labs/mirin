# mirin's taffy 0.15 fork

`taffy` 0.15.0 from crates.io (DioxusLabs, MIT), the version upstream GPUI
(`../zed`) pins, forked in the monorepo (`forks/taffy-next`) beside the 0.9.0
fork (`../taffy`) that the gpui 0.2.2 fork uses. Every change is marked with a
`// mirin:` comment. Rows that port a change of `../taffy` say which
(`../taffy/MIRIN.md`).

| Change | Files | Why |
| --- | --- | --- |
| A flex container whose width its `min-width` or `max-width` set (not its content) lays its children out again at that width | `src/compute/flexbox.rs` (`compute_flexbox_layout`) | Port of `../taffy`'s row; 0.15 still lays the children out once, for the content's width. Upstreamable. |
| Fit-content cross size for flex base sizes in column containers | `src/compute/flexbox.rs` (`determine_flex_base_size`, `tree_measure_cross`) | Port of `../taffy`'s row (spec 9.2.3.E); not fixed in 0.15. Upstreamable. |
| Fit-content cross size for the hypothetical cross size of a non-stretched item in a column | `src/compute/flexbox.rs` (`determine_hypothetical_cross_size`; tested in mirin-metal's `render::one_line_tests`) | Port of `../taffy`'s row (spec 9.4.7); not fixed in 0.15. Upstreamable. |
| A flex item's end margins count toward its container's scrollable overflow | `src/compute/flexbox.rs` (`calculate_flex_item`; tested in mirin-metal's `render::scroll_tests`) | Port of `../taffy`'s row: 0.15 counts each item's border box (`compute_scrollable_overflow_contribution`), CSS Overflow 3 its margin box. Upstreamable. |
| `remove` clears a child's parent only where it is still that parent | `src/tree/taffy_tree.rs` | Port of `../taffy`'s row: a kept subtree is adopted by the next frame's parent before the last one is removed; removing it used to orphan the subtree. (0.15 already drops the context.) |
| `contains` | `src/tree/taffy_tree.rs` | Port of `../taffy`'s row: a kept node id can outlive its node; GPUI checks before reusing one. |
| What a layout changed below a node (`set_layout_epoch`, `below_changed_since`; `NodeData::below_changed_at`, marked in `set_unrounded_layout`) | `src/tree/taffy_tree.rs` (test `a_node_only_resized_changed_nothing_below_it`) | Port of `../taffy`'s row for upstream GPUI, which rounds itself (so the mark is on the unrounded layout, not on rounding): GPUI leaves a retained subtree whose root was only resized (a row stretched to a window's new width) undrawn while nothing of it shows, without drawing it to learn how far it reaches, when nothing below its root changed. |

`../taffy`'s fix for a negative margin on an item with `flex-shrink: 0` is
in 0.15 in its own way. Its incremental rounding is moot: upstream GPUI turns
taffy's rounding off and snaps edges itself. Its detached layout is not
needed: GPUI lays a copy out as a root with its twin's size
(`TaffyLayoutEngine::place_detached`). What a layout changed inside a node is
GPUI's comparison of a root's unrounded box (`TaffyLayoutEngine::node_box`),
and what a measured leaf was last asked is kept by GPUI's measure function
(`NodeContext::last`), so neither needs taffy.

To update: see `../README.md` (merge the `forks-upstream-next` branch), then
reconcile the changes above. Keep the version equal to the one upstream GPUI
pins.
