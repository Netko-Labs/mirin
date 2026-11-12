# mirin's AccessKit consumer fork

`accesskit_consumer` 0.39.2 from crates.io (The AccessKit contributors, MIT OR
Apache-2.0), forked in the monorepo (`forks/accesskit_consumer`) for a bug in
its filtered sibling walks and to keep its tree once instead of twice. `forks/accesskit_atspi_common` depends on it by
path, and `crates/mirin-metal` (both builds) patches crates.io's to it, so its
tests' own AccessKit tree is this one too. Every change is marked with a
`// mirin:` comment in the source.

| Change | Files | Why |
| --- | --- | --- |
| A hidden sibling after an empty container is stepped over | `src/iterators.rs` (`next_filtered_sibling`, `previous_filtered_sibling`; test `hidden_after_empty`) | A walk that reached a container the filter sees through (`ExcludeNode`) with no children went on to the next sibling still meaning to look inside it: when that sibling was hidden whole (`ExcludeSubtree`) with children, the walk went into it and ended at its end. So a parent's filtered children stopped at such a pair (the siblings after it were missing from AT-SPI), and a node's count of the filtered siblings before it fell short. Found by the random trees of `forks/accesskit_atspi_common`'s sibling places, which compare a parent's list with each node's count. Metal's trees never hold that pair (no node of theirs is hidden or clips its children, so nothing is hidden whole, and a frame always has children), so what Metal publishes is unchanged. Upstreamable. |
| A node's data is shared by the tree's two states (`NodeState::data` is an `Arc<Node>`) | `src/node.rs`, `src/tree.rs` (test `shared_data`) | `Tree` keeps the tree as the adapter last reported it (`state`) and as the next update makes it (`next_state`), and copied every node into both: the whole tree deep-copied when it was made, and each changed node copied again after each update. A node's data is never changed in place (an update replaces it), so both states now point to the same data and a copy is a count. AccessKit's tree for Metal's stress bench (7600 nodes) went from 6.0 to 2.4 MB (RSS across `accesskit_atspi_common::Adapter::new` of a tree shaped like it, outside the host). Upstreamable. |

Its tests build it alone with mirin-metal's lockfile:
`cp ../../crates/mirin-metal/Cargo.lock . && CARGO_TARGET_DIR=../../crates/mirin-metal/target/consumer-alone cargo test --lib`,
then remove the copied `Cargo.lock`.

To update: see `../README.md` (merge the `forks-upstream` branch), then
reconcile the change above.
