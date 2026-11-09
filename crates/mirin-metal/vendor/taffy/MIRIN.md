# mirin's taffy fork

`taffy` 0.9.0 from crates.io (DioxusLabs, MIT), vendored because GPUI pins
`taffy = "=0.9.0"` and its flexbox base-size step diverges from the spec in a
way shadcn layouts hit. Every change is marked with a `// mirin:` comment.

| Change | Files | Why |
| --- | --- | --- |
| A negative margin on an item with `flex-shrink: 0` takes off only the margin from the container's intrinsic main size | `src/compute/flexbox.rs` (`determine_container_main_size`, test `mirin_tests`) | The max-content flex fraction was divided by `max(1, flex_shrink × inner_flex_basis)` and multiplied back by `max(1, flex_shrink) × inner_flex_basis`; with `flex_shrink` 0 those differ, so a column whose 20-tall item had `margin-top: -4` came out 80 shorter, not 4, and a scroll view over it lost its range (Dashi's Settings). Upstreamable. |
| Fit-content cross size for flex base sizes in column containers | `src/compute/flexbox.rs` (`determine_flex_base_size`) | Spec 9.2.3.E sizes a non-stretched item with an auto cross size at fit-content. taffy measured it against the whole available width, so content that scales with width (an `aspect-square` day grid in a centered calendar) reported a height several times its final one, and the item kept it. Upstreamable. |
| Fit-content cross size for the hypothetical cross size of a non-stretched item in a column | `src/compute/flexbox.rs` (`determine_hypothetical_cross_size`; tested in mirin-metal's `render::one_line_tests`) | Spec 9.4.7 sizes an item with an auto cross size at fit-content. taffy measured an `align-items: center` item at its max-content width, so a box of one long line centered in a narrower column (Dashi's notice over a 480 pt window) overflowed both edges instead of wrapping. Upstreamable. |

To update: copy the new release over this directory (minus `examples/`,
`benches/`, `Cargo.lock`, `Cargo.toml.orig`, and the `[[example]]` entries in
`Cargo.toml`), then re-apply the changes above. Keep the version equal to the
one GPUI pins.
