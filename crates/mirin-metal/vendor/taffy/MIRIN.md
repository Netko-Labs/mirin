# mirin's taffy fork

`taffy` 0.9.0 from crates.io (DioxusLabs, MIT), vendored because GPUI pins
`taffy = "=0.9.0"` and its flexbox base-size step diverges from the spec in a
way shadcn layouts hit. Every change is marked with a `// mirin:` comment.

| Change | Files | Why |
| --- | --- | --- |
| Fit-content cross size for flex base sizes in column containers | `src/compute/flexbox.rs` (`determine_flex_base_size`) | Spec 9.2.3.E sizes a non-stretched item with an auto cross size at fit-content. taffy measured it against the whole available width, so content that scales with width (an `aspect-square` day grid in a centered calendar) reported a height several times its final one, and the item kept it. Upstreamable. |

To update: copy the new release over this directory (minus `examples/`,
`benches/`, `Cargo.lock`, `Cargo.toml.orig`, and the `[[example]]` entries in
`Cargo.toml`), then re-apply the change above. Keep the version equal to the
one GPUI pins.
