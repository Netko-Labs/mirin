//! One update's pass over the element tree: which views are made again
//! (`Fragment`: a view's subtree, kept by the generation it was made in) and
//! which nodes that changes, leaves, or moves (`published.rs` hands them
//! over).

use std::collections::hash_map::Entry;
use std::collections::HashMap;

use accesskit::{Node, NodeId};

use super::published::Kept;
use super::tree::{self, node_id, Facts, ROOT};
use crate::patch::Document;
use crate::tree::{NodeSpec, ViewProps};

/// What a view's subtree came to, good while its generation stands.
pub(super) struct Fragment {
    /// The view's id (its place under its parent when it has none).
    id: Box<str>,
    /// The update anything at or under it last changed in, when it was made.
    generation: u64,
    /// The nodes it gives the node above: its own, or its children's when
    /// it is only layout.
    out: Vec<NodeId>,
    /// The first selected node at or under it.
    pub(super) selected: Option<NodeId>,
    /// The nodes made here: its own, its texts' and its fields'.
    own: Vec<NodeId>,
    /// Its child views, in order.
    children: Vec<Fragment>,
}

/// A fragment being made again, and what it was made of before: what still
/// stands is kept, the rest leaves the tree.
#[derive(Default)]
struct Making {
    out: Vec<NodeId>,
    selected: Option<NodeId>,
    own: Vec<NodeId>,
    children: Vec<Fragment>,
    old_id: Option<Box<str>>,
    old_own: Vec<NodeId>,
    old_children: Vec<Option<Fragment>>,
    /// Where the next child view was last time, when nothing came or went.
    next: usize,
    /// Where each old child is, once one is out of step.
    places: Option<HashMap<Box<str>, usize>>,
}

impl Making {
    fn after(old: Option<Fragment>) -> Self {
        let Some(old) = old else {
            return Self::default();
        };
        Self {
            old_id: Some(old.id),
            old_own: old.own,
            old_children: old.children.into_iter().map(Some).collect(),
            ..Self::default()
        }
    }

    /// What the child view `id` came to last time, if it was here.
    fn before(&mut self, id: &str) -> Option<Fragment> {
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
enum Place<'a> {
    /// The tree's root.
    Top,
    /// Under the view with this id, at this place among its children.
    Under(&'a str, usize),
}

impl Place<'_> {
    fn key(self) -> String {
        match self {
            Place::Top => "root".to_owned(),
            Place::Under(parent, index) => format!("{parent}/{index}"),
        }
    }
}

/// One update's pass over the element tree.
pub(super) struct Walk<'a> {
    document: &'a Document,
    facts: &'a Facts<'a>,
    kept: &'a mut HashMap<NodeId, Kept>,
    stamp: u64,
    /// Nodes that are new or differ from what was handed over.
    pub(super) changed: Vec<NodeId>,
    /// Nodes that left the tree.
    pub(super) gone: Vec<NodeId>,
    /// How many nodes were made from their elements.
    pub(super) built: usize,
    /// How many kept nodes' bounds were compared with the paint.
    pub(super) compared: usize,
    /// Inside a view whose bounds are compared once it is made (`view`).
    looking: bool,
}

impl<'a> Walk<'a> {
    pub(super) fn new(
        document: &'a Document,
        facts: &'a Facts<'a>,
        kept: &'a mut HashMap<NodeId, Kept>,
        stamp: u64,
    ) -> Self {
        Self {
            document,
            facts,
            kept,
            stamp,
            changed: Vec::new(),
            gone: Vec::new(),
            built: 0,
            compared: 0,
            looking: false,
        }
    }

    /// `node` is what `id` is now; it is in the update when that differs
    /// from what was kept.
    fn keep(&mut self, id: NodeId, base: Node, element: Option<&str>, typed: bool) {
        self.built += 1;
        let bounds = element.and_then(|element| (self.facts.bounds)(element));
        let stamp = self.stamp;
        match self.kept.entry(id) {
            Entry::Occupied(mut entry) => {
                let kept = entry.get_mut();
                kept.stamp = stamp;
                let same = kept.base == base
                    && kept.bounds == bounds
                    && kept.element.as_deref() == element
                    && kept.typed == typed;
                if !same {
                    kept.base = base;
                    kept.bounds = bounds;
                    kept.element = element.map(Box::from);
                    kept.typed = typed;
                    self.changed.push(id);
                }
            }
            Entry::Vacant(entry) => {
                entry.insert(Kept {
                    base,
                    element: element.map(Box::from),
                    bounds,
                    typed,
                    stamp,
                });
                self.changed.push(id);
            }
        }
    }

    /// `id` is no longer made where it was: gone, unless this update made
    /// it somewhere else (an element that moved).
    fn drop_node(&mut self, id: NodeId) {
        if self
            .kept
            .get(&id)
            .is_some_and(|kept| kept.stamp != self.stamp)
        {
            self.kept.remove(&id);
            self.gone.push(id);
        }
    }

    fn discard(&mut self, fragment: Fragment) {
        for id in fragment.own {
            self.drop_node(id);
        }
        for child in fragment.children {
            self.discard(child);
        }
    }

    /// What was made last time and not this time leaves the tree.
    fn finish(&mut self, making: Making, id: &str, generation: u64) -> Fragment {
        for id in making.old_own {
            self.drop_node(id);
        }
        for old in making.old_children.into_iter().flatten() {
            self.discard(old);
        }
        Fragment {
            id: making.old_id.unwrap_or_else(|| id.into()),
            generation,
            out: making.out,
            selected: making.selected,
            own: making.own,
            children: making.children,
        }
    }

    /// The child at `place` as nodes; the ones that are its parent's
    /// children join `out`.
    fn child(&mut self, spec: &NodeSpec, place: Place, making: &mut Making, out: &mut Vec<NodeId>) {
        match spec {
            NodeSpec::View { props, children } => {
                let placed;
                let id = match props.id.as_deref() {
                    Some(id) => id,
                    None => {
                        placed = place.key();
                        &placed
                    }
                };
                let old = making.before(id);
                let fragment = self.view(props, children, id, old);
                out.extend_from_slice(&fragment.out);
                making.selected = making.selected.or(fragment.selected);
                making.children.push(fragment);
            }
            NodeSpec::Text { children, .. } => {
                let words = children.concat();
                if words.trim().is_empty() {
                    return;
                }
                let id = node_id(&place.key());
                self.keep(id, tree::text_node(words), None, false);
                making.own.push(id);
                out.push(id);
            }
            NodeSpec::Input { props } => {
                let id = node_id(&props.id);
                self.keep(id, tree::field_node(props), Some(&props.id), !props.secure);
                making.own.push(id);
                out.push(id);
            }
            NodeSpec::Svg { .. } | NodeSpec::Image { .. } => {}
        }
    }

    /// The view `id` and what is under it: as it was (`old`) while nothing
    /// at or under it changed, else made again, its child views the same way.
    fn view(
        &mut self,
        props: &ViewProps,
        children: &[NodeSpec],
        id: &str,
        old: Option<Fragment>,
    ) -> Fragment {
        let generation = self.document.subtree_generation(id);
        let old = match old {
            Some(old) if old.generation == generation => return old,
            old => old,
        };
        // Its own props or children changed: what it paints of what is under
        // it may have, with nothing moving. (Not needed inside a view that
        // looks already, or when every node is looked at anyway.)
        let looks = !self.facts.moved
            && !self.looking
            && old
                .as_ref()
                .is_some_and(|old| self.document.own_generation(id) > old.generation);
        self.looking |= looks;
        let fragment = self.make(props, children, id, generation, Making::after(old));
        if looks {
            self.looking = false;
            self.follow_under(&fragment);
        }
        fragment
    }

    fn make(
        &mut self,
        props: &ViewProps,
        children: &[NodeSpec],
        id: &str,
        generation: u64,
        mut making: Making,
    ) -> Fragment {
        let Some(role) = tree::view_role(props) else {
            // Only layout: its children join the node above.
            let mut out = Vec::new();
            for (index, child) in children.iter().enumerate() {
                self.child(child, Place::Under(id, index), &mut making, &mut out);
            }
            making.out = out;
            return self.finish(making, id, generation);
        };
        let node_id = node_id(id);
        let mut node = tree::view_node(props, role);
        if tree::is_selected(props) {
            making.selected = Some(node_id);
        }
        if !tree::stands_for_content(props, role) {
            let mut inner = Vec::new();
            for (index, child) in children.iter().enumerate() {
                self.child(child, Place::Under(id, index), &mut making, &mut inner);
            }
            node.set_children(inner);
        }
        self.keep(node_id, node, Some(id), false);
        making.own.push(node_id);
        making.out.push(node_id);
        self.finish(making, id, generation)
    }

    /// The window over the whole tree.
    pub(super) fn window(&mut self, old: Option<Fragment>) -> Fragment {
        let mut making = Making::after(old);
        let mut top = Vec::new();
        self.child(self.document, Place::Top, &mut making, &mut top);
        self.keep(ROOT, tree::window_node(self.facts.title, top), None, false);
        making.own.push(ROOT);
        making.out.push(ROOT);
        self.finish(making, "", self.document.generation())
    }

    /// Bounds follow the paint, not the tree: every node this update did not
    /// make is compared with where it was painted last.
    pub(super) fn follow_all(&mut self) {
        for (id, kept) in self.kept.iter_mut() {
            match follow(kept, self.stamp, self.facts) {
                Some(true) => self.changed.push(*id),
                Some(false) => {}
                None => continue,
            }
            self.compared += 1;
        }
    }

    /// The same for the nodes at and under `fragment`.
    fn follow_under(&mut self, fragment: &Fragment) {
        for id in &fragment.own {
            let kept = self.kept.get_mut(id);
            match kept.and_then(|kept| follow(kept, self.stamp, self.facts)) {
                Some(true) => self.changed.push(*id),
                Some(false) => {}
                None => continue,
            }
            self.compared += 1;
        }
        for child in &fragment.children {
            self.follow_under(child);
        }
    }
}

/// Bring a node not made in the update `stamp` to where its element was
/// painted last: whether that moved it, or None for a node with no bounds to
/// compare (text, the window, one this update made already).
fn follow(kept: &mut Kept, stamp: u64, facts: &Facts) -> Option<bool> {
    if kept.stamp == stamp {
        return None;
    }
    let bounds = (facts.bounds)(kept.element.as_deref()?);
    let moved = bounds != kept.bounds;
    kept.bounds = bounds;
    Some(moved)
}
