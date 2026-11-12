# mirin's AccessKit Unix adapter fork

`accesskit_unix` 0.24.1 from crates.io (The AccessKit contributors, MIT OR
Apache-2.0), forked in the monorepo (`forks/accesskit_unix`) so a Metal host names itself to screen readers,
announces a window that has the keyboard as it appears, and sends bounds
changes only to a bus where something listens for them. Every change is
marked with a `// mirin:` comment in the source.

| Change | Files | Why |
| --- | --- | --- |
| The application's name (`set_app_name`) | `src/context.rs`, `src/lib.rs` | The AT-SPI application object was named after the executable's file, so Orca called every Metal app and every Dashi surface "mirin-metal-host". A program may now name itself before its first window's tree reaches the bus; otherwise the file name, as before. Upstreamable. |
| A window focused already announces its activation (`focused_on_creation`) | `src/adapter.rs`, `src/context.rs` | An adapter whose window had the keyboard before the tree reached the bus was made focused: it sent the focused node's focus event but never `window:activate`, and Orca ignores focus from a window that isn't its active one, so a launcher shown again (a new window on a resident host, focused at once) said nothing. It is now made unfocused and then focused, which sends `window:activate` and then the focus. Upstreamable. |

| Bounds changes are sent only while something listens for them (`bounds_changed`) | `src/listeners.rs` (new), `src/adapter.rs`, `src/atspi/bus.rs`, `src/context.rs`, `src/lib.rs` | AT-SPI clients register the events they want and toolkits send only those (at-spi2-atk asks the registry who listens); AccessKit sends every event to the bus. Bounds change in bulk (a window resized, a list reflowed: one `object:bounds-changed` a node, 2500 a frame on Metal's stress bench before its tree moved content as frames), and neither Orca nor the Dashi shell registers for them. The adapter asks `Registry.GetRegisteredEvents` when it joins the bus and again when bounds change, at most once a second (`Message::AskListeners`), and drops a bounds change at its source while no registration takes it in (by class or by event, however spelled); when the registry cannot be asked they are sent as before. A client that registers later hears bounds changes from the next ask on. It does not follow the registry's signals: a stream on the bus's connection outlived the connection's own tasks when accessibility was turned off (its drop queues a call nothing runs any more) and kept the application on the bus, answering nobody. Extents are answered from the tree on request either way. Upstreamable (for every event, as at-spi2-atk does). |
| A count of the signals made (`signals_queued`) | `src/listeners.rs`, `src/adapter.rs`, `src/lib.rs` | What an update tells the bus was only measurable from outside (a bus monitor). The adapter counts each event and cache change it queues; Metal's trace prints the difference across an update. |
| The adapter's thread is named `accesskit` | `src/context.rs` (`get_or_init_messages`) | Its CPU could be told from the program's only by its stacks in a profile; named, `/proc/<pid>/task/*/comm` finds it (Metal's `bench/stress.tsx` reports its part of each scenario's CPU). Upstreamable. |
| The AT-SPI layer fork by path (`[dependencies.accesskit_atspi_common] path`) | `Cargo.toml` | Its node places and children changes no longer grow with the square of a parent's children (`../accesskit_atspi_common/MIRIN.md`), also when this crate is built alone for its tests. |

To update: see `../README.md` (merge the `forks-upstream` branch), then
reconcile the changes above.
