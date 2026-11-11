# mirin's AccessKit Unix adapter fork

`accesskit_unix` 0.24.1 from crates.io (The AccessKit contributors, MIT OR
Apache-2.0), vendored so a Metal host names itself to screen readers and
announces a window that has the keyboard as it appears. Every change is
marked with a `// mirin:` comment in the source.

| Change | Files | Why |
| --- | --- | --- |
| The application's name (`set_app_name`) | `src/context.rs`, `src/lib.rs` | The AT-SPI application object was named after the executable's file, so Orca called every Metal app and every Dashi surface "mirin-metal-host". A program may now name itself before its first window's tree reaches the bus; otherwise the file name, as before. Upstreamable. |
| A window focused already announces its activation (`focused_on_creation`) | `src/adapter.rs`, `src/context.rs` | An adapter whose window had the keyboard before the tree reached the bus was made focused: it sent the focused node's focus event but never `window:activate`, and Orca ignores focus from a window that isn't its active one, so a launcher shown again (a new window on a resident host, focused at once) said nothing. It is now made unfocused and then focused, which sends `window:activate` and then the focus. Upstreamable. |

To update: copy the new release over this directory (minus `Cargo.lock`,
`Cargo.toml.orig`, `CHANGELOG.md`, `.cargo_vcs_info.json`, and `.cargo-ok`),
then re-apply the changes above.
