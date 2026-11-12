# mirin's AccessKit AT-SPI layer fork

`accesskit_atspi_common` 0.21.1 from crates.io (The AccessKit contributors,
MIT OR Apache-2.0), forked in the monorepo (`forks/accesskit_atspi_common`)
because a large tree cost the Unix adapter's thread time that grew with the
square of a parent's children. `forks/accesskit_unix` depends on it by path,
and `crates/mirin-metal` (both builds) patches crates.io's to it. Every change
is marked with a `// mirin:` comment in the source.

| Change | Files | Why |
| --- | --- | --- |
| A node's place among its filtered siblings is looked up, for a parent with many (`SiblingIndex`) | `src/sibling_index.rs` (new; tests in `src/sibling_index/tests.rs`), `src/context.rs` (`write_tree`, `generation`, `sibling_index`), `src/adapter.rs`, `src/node.rs` (`index_in_parent`, `cache_node`), `src/lib.rs` | Every node the tree adds to the bus goes through `cache_node` (the `AddAccessible` signal), which counted the filtered siblings before the node, running the filter (which walks the node's ancestors) at each step: n children added at once cost O(n²) filter runs. On Metal's stress bench a switch of layout re-adds 2500 cards under one parent: 0.6–0.9 s of the adapter thread's CPU, 77% of it in that count. Now a node with fewer than 16 filtered siblings before it is counted as before; past that, the parent's filtered children are listed once for the tree as it is (each write of the tree is a new generation, and the list is dropped with it) and the place is looked up. The same for `Accessible.GetIndexInParent`. A node the list leaves out is counted as before. The test checks every place and child count against the count on random trees changed at random. Upstreamable. |
| Children gained and lost are found through sets for long lists (`ChildSet`) | `src/node.rs` (`notify_children_changes`) | When a node with n filtered children changed (a window resized whose list is among its children), each child was searched for in the other list: n² comparisons on the window's thread (2.2–2.6 ms at 2500 children; 0.7 ms now). Lists of at most 16, or looked up in at most 16 times, are still searched; the events and their order are the same (the same test). Upstreamable. |
| The consumer fork by path (`[dependencies.accesskit_consumer] path`) | `Cargo.toml` | The places above rely on the consumer's sibling walks agreeing with its lists of children (`forks/accesskit_consumer/MIRIN.md`), also when this crate is built alone for its tests. |

Its tests build it alone with mirin-metal's lockfile:
`cp ../../crates/mirin-metal/Cargo.lock . && CARGO_TARGET_DIR=../../crates/mirin-metal/target/atspi-alone cargo test --lib`,
then remove the copied `Cargo.lock`.

To update: see `../README.md` (merge the `forks-upstream` branch), then
reconcile the changes above.
