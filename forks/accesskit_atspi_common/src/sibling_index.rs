// mirin: where a node sits among its filtered parent's filtered children,
// remembered for parents with many of them (`MIRIN.md`).
//
// Upstream counts the node's preceding filtered siblings each time it is
// asked (`index_in_parent`, and every `cache_node`, which each node the tree
// adds to the bus goes through). Each step of that walk runs the filter,
// which looks at the node's ancestors, so a parent with n filtered children
// added at once (a list replaced, a view switched) cost O(n²) filter runs on
// the adapter's thread: 0.6-0.9 s of CPU for 2500 cards on Metal's stress
// bench. A node with fewer than `COUNTED` siblings before it is still
// counted; past that, its parent's filtered children are listed once for the
// tree as it now is and every sibling is looked up in that list until the
// tree changes.

use accesskit_consumer::{FullNodeId, NodeRef};
use std::collections::HashMap;

use crate::filters::filter;

/// Siblings counted one by one before the parent's list is made.
pub(crate) const COUNTED: usize = 16;

/// Each parent's filtered children's places, for one state of the tree.
#[derive(Debug, Default)]
pub(crate) struct SiblingIndex {
    /// The tree's generation the places are from (`Context::write_tree`).
    generation: u64,
    places: HashMap<FullNodeId, HashMap<FullNodeId, usize>>,
}

impl SiblingIndex {
    /// The number of `node`'s preceding filtered siblings, `parent` being its
    /// filtered parent, for the tree at `generation`; `node` and `parent` are
    /// from that tree, held while this runs.
    pub(crate) fn index(&mut self, generation: u64, node: &NodeRef, parent: &NodeRef) -> usize {
        let counted = node
            .preceding_filtered_siblings(&filter)
            .take(COUNTED)
            .count();
        if counted < COUNTED {
            return counted;
        }
        if self.generation != generation {
            self.generation = generation;
            self.places = HashMap::new();
        }
        let places = self.places.entry(parent.id()).or_insert_with(|| {
            parent
                .filtered_children(&filter)
                .enumerate()
                .map(|(index, child)| (child.id(), index))
                .collect()
        });
        // A node the parent's list leaves out (the focus, which the filter
        // keeps under a subtree it hides) is counted as upstream counts it.
        places
            .get(&node.id())
            .copied()
            .unwrap_or_else(|| node.preceding_filtered_siblings(&filter).count())
    }
}

#[cfg(test)]
mod tests;
