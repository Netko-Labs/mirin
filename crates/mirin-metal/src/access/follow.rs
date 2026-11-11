//! Bounds follow the paint, not the tree: after a walk made the views a
//! patch reached, the nodes it did not make and the layout says are
//! somewhere else are placed again (`place.rs`).

use std::collections::{HashMap, HashSet};

use accesskit::NodeId;

use super::place::{Placement, Spaces};
use super::tree::node_id;
use super::walk::Walk;
use crate::layout::Changes;

/// What a walk changes of the tree as kept, besides its nodes.
pub(super) struct Frames<'a> {
    pub(super) frames: &'a mut HashMap<u64, NodeId>,
    pub(super) around: &'a mut HashMap<u64, Option<u64>>,
    pub(super) loose: &'a mut HashSet<NodeId>,
}

impl Walk<'_> {
    pub(super) fn place(
        &self,
        element: Option<&str>,
        space: Option<u64>,
        frame: Option<u64>,
    ) -> Placement {
        let spaces = Spaces {
            layout: self.facts.layout,
            around: self.around,
        };
        spaces.place(element, space, frame)
    }

    /// `id` is placed so now.
    pub(super) fn placed(&mut self, id: NodeId, loose: bool) {
        if loose {
            self.loose.insert(id);
        } else if !self.loose.is_empty() {
            self.loose.remove(&id);
        }
    }

    /// Bounds follow the paint, not the tree: the nodes this update did not
    /// make and the layout says are somewhere else are placed again; every
    /// one, when it kept no account (`changes` is None).
    pub(super) fn follow(&mut self, changes: Option<&Changes>) {
        let Some(changes) = changes else {
            let all: Vec<NodeId> = self.kept.keys().copied().collect();
            return all.into_iter().for_each(|id| self.follow_node(id));
        };
        if changes.is_empty() {
            return;
        }
        for element in &changes.nodes {
            self.follow_node(node_id(element));
        }
        for group in &changes.groups {
            if let Some(&id) = self.frames.get(group) {
                self.follow_node(id);
            }
        }
        // Placed by the window: anything that moved may have moved them.
        let loose: Vec<NodeId> = self.loose.iter().copied().collect();
        loose.into_iter().for_each(|id| self.follow_node(id));
    }

    /// Place `id` again, unless this update made it or it has no place.
    fn follow_node(&mut self, id: NodeId) {
        let stamp = self.stamp;
        let Some(kept) = self
            .kept
            .get(&id)
            .filter(|kept| kept.stamp != stamp && (kept.element.is_some() || kept.frame.is_some()))
        else {
            return;
        };
        let place = self.place(kept.element.as_deref(), kept.space, kept.frame);
        self.compared += 1;
        if place == kept.place {
            return;
        }
        let moved = place.bounds != kept.place.bounds || place.offset != kept.place.offset;
        if let Some(kept) = self.kept.get_mut(&id) {
            kept.place = place;
        }
        if moved {
            self.changed.push(id);
        }
        self.placed(id, place.loose);
    }
}
