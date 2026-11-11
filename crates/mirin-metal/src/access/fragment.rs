//! What a walk keeps of the views it made (`walk.rs`): a view's subtree as
//! nodes, good while nothing at or under it changes.

use std::collections::HashMap;

use accesskit::NodeId;

/// What a view's subtree came to, good while its generation stands.
pub(super) struct Fragment {
    /// The view's id (its place under its parent when it has none).
    pub(super) id: Box<str>,
    /// The update anything at or under it last changed in, when it was made.
    pub(super) generation: u64,
    /// The frame around it when it was made: where its nodes are placed.
    pub(super) space: Option<u64>,
    /// The group its content moves as, if it does (a frame only when a node
    /// under it has a place).
    pub(super) frame: Option<u64>,
    /// Whether a node of it has a place in the frame around it.
    pub(super) placed: bool,
    /// The nodes it gives the node above: its own, or its children's when
    /// it is only layout.
    pub(super) out: Vec<NodeId>,
    /// The first selected node at or under it.
    pub(super) selected: Option<NodeId>,
    /// The nodes made here: its own, its texts' and its fields'.
    pub(super) own: Vec<NodeId>,
    /// Its child views, in order.
    pub(super) children: Vec<Fragment>,
}

/// A fragment being made again, and what it was made of before: what still
/// stands is kept, the rest leaves the tree.
#[derive(Default)]
pub(super) struct Making {
    pub(super) out: Vec<NodeId>,
    pub(super) selected: Option<NodeId>,
    /// Whether a node made under it so far has a place in the frame they
    /// are made in.
    pub(super) placed: bool,
    pub(super) own: Vec<NodeId>,
    pub(super) children: Vec<Fragment>,
    pub(super) old_id: Option<Box<str>>,
    pub(super) old_frame: Option<u64>,
    pub(super) old_own: Vec<NodeId>,
    pub(super) old_children: Vec<Option<Fragment>>,
    /// Where the next child view was last time, when nothing came or went.
    next: usize,
    /// Where each old child is, once one is out of step.
    places: Option<HashMap<Box<str>, usize>>,
}

impl Making {
    pub(super) fn after(old: Option<Fragment>) -> Self {
        let Some(old) = old else {
            return Self::default();
        };
        Self {
            old_id: Some(old.id),
            old_frame: old.frame,
            old_own: old.own,
            old_children: old.children.into_iter().map(Some).collect(),
            ..Self::default()
        }
    }

    /// What the child view `id` came to last time, if it was here.
    pub(super) fn before(&mut self, id: &str) -> Option<Fragment> {
        let in_step = self
            .old_children
            .get(self.next)
            .and_then(Option::as_ref)
            .is_some_and(|old| &*old.id == id);
        let at = if in_step {
            self.next
        } else {
            let places = self.places.get_or_insert_with(|| {
                let old = self.old_children.iter().enumerate();
                old.filter_map(|(at, old)| Some((old.as_ref()?.id.clone(), at)))
                    .collect()
            });
            *places.get(id)?
        };
        self.next = at + 1;
        self.old_children[at].take()
    }
}

/// Where an element is: what stands for the id of one that has none (text,
/// a view from a driver that names only some).
#[derive(Clone, Copy)]
pub(super) enum Place<'a> {
    /// The tree's root.
    Top,
    /// Under the view with this id, at this place among its children.
    Under(&'a str, usize),
}

impl Place<'_> {
    pub(super) fn key(self) -> String {
        match self {
            Place::Top => "root".to_owned(),
            Place::Under(parent, index) => format!("{parent}/{index}"),
        }
    }
}
