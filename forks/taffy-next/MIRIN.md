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

`../taffy`'s fix for a negative margin on an item with `flex-shrink: 0` is
in 0.15 in its own way. Its incremental rounding is moot: upstream GPUI turns
taffy's rounding off and snaps edges itself. `contains`, the `remove` fix and
the detached layout follow the retained-subtree port
(`docs/metal/gpui-next.md`).

To update: see `../README.md` (merge the `forks-upstream-next` branch), then
reconcile the changes above. Keep the version equal to the one upstream GPUI
pins.
