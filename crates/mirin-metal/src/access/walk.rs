//! One update's pass over the element tree: which views are made again
//! (`Fragment`: a view's subtree, kept by the generation it was made in) and
//! which nodes that changes, leaves, or moves (`published.rs` hands them
//! over).
//!
//! A view whose content moves as one (it scrolls, or GPUI keeps its drawing:
//! a group of the layout) is a frame for the nodes under it when any has a
//! place of its own (`place.rs`): its node carries where the group is, and
//! a view that is only layout gets a node for that alone, one a screen
//! reader never sees (a generic container: its children are the node
//! above's, as before).

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};

use accesskit::{Node, NodeId, Role};

use super::follow::Frames;
use super::fragment::{Fragment, Making, Place};
use super::published::Kept;
use super::tree::{self, node_id, Facts, ROOT};
use crate::layout::scroll_group;
use crate::patch::Document;
use crate::tree::{NodeSpec, ViewProps};

/// One update's pass over the element tree.
pub(super) struct Walk<'a> {
    document: &'a Document,
    pub(super) facts: &'a Facts<'a>,
    pub(super) kept: &'a mut HashMap<NodeId, Kept>,
    /// The node that is the frame of each group, the frame around each
    /// frame, and the nodes placed by the window (`place.rs`).
    pub(super) frames: &'a mut HashMap<u64, NodeId>,
    pub(super) around: &'a mut HashMap<u64, Option<u64>>,
    pub(super) loose: &'a mut HashSet<NodeId>,
    pub(super) stamp: u64,
    /// The frame the nodes being made are placed in.
    space: Option<u64>,
    /// Nodes that are new or differ from what was handed over.
    pub(super) changed: Vec<NodeId>,
    /// Nodes that left the tree.
    pub(super) gone: Vec<NodeId>,
    /// How many nodes were made from their elements.
    pub(super) built: usize,
    /// How many kept nodes were placed again (the layout said they moved).
    pub(super) compared: usize,
}

impl<'a> Walk<'a> {
    pub(super) fn new(
        document: &'a Document,
        facts: &'a Facts<'a>,
        kept: &'a mut HashMap<NodeId, Kept>,
        frames: Frames<'a>,
        stamp: u64,
    ) -> Self {
        Self {
            document,
            facts,
            kept,
            frames: frames.frames,
            around: frames.around,
            loose: frames.loose,
            stamp,
            space: None,
            changed: Vec::new(),
            gone: Vec::new(),
            built: 0,
            compared: 0,
        }
    }

    /// `node` is what `id` is now, the frame of group `frame` when one is
    /// given; it is in the update when that differs from what was kept.
    fn keep(
        &mut self,
        id: NodeId,
        base: Node,
        element: Option<&str>,
        typed: bool,
        frame: Option<u64>,
    ) {
        self.built += 1;
        let space = self.space;
        let place = self.place(element, space, frame);
        let stamp = self.stamp;
        let was = match self.kept.entry(id) {
            Entry::Occupied(mut entry) => {
                let kept = entry.get_mut();
                kept.stamp = stamp;
                let same = kept.base == base
                    && kept.place.bounds == place.bounds
                    && kept.place.offset == place.offset
                    && kept.element.as_deref() == element
                    && kept.typed == typed;
                let was = kept.frame;
                (kept.space, kept.frame, kept.place) = (space, frame, place);
                if !same {
                    kept.base = base;
                    kept.element = element.map(Box::from);
                    kept.typed = typed;
                    self.changed.push(id);
                }
                was
            }
            Entry::Vacant(entry) => {
                entry.insert(Kept {
                    base,
                    element: element.map(Box::from),
                    space,
                    frame,
                    place,
                    typed,
                    stamp,
                });
                self.changed.push(id);
                None
            }
        };
        if was != frame {
            if let Some(group) = was.filter(|group| self.frames.get(group) == Some(&id)) {
                self.frames.remove(&group);
            }
            if let Some(group) = frame {
                self.frames.insert(group, id);
            }
        }
        self.placed(id, place.loose);
    }

    /// `id` is no longer made where it was: gone, unless this update made
    /// it somewhere else (an element that moved).
    fn drop_node(&mut self, id: NodeId) {
        let Some(kept) = self.kept.get(&id).filter(|kept| kept.stamp != self.stamp) else {
            return;
        };
        if let Some(group) = kept
            .frame
            .filter(|group| self.frames.get(group) == Some(&id))
        {
            self.frames.remove(&group);
        }
        self.loose.remove(&id);
        self.kept.remove(&id);
        self.gone.push(id);
    }

    fn discard(&mut self, fragment: Fragment) {
        if let Some(group) = fragment.frame {
            self.around.remove(&group);
        }
        for id in fragment.own {
            self.drop_node(id);
        }
        for child in fragment.children {
            self.discard(child);
        }
    }

    /// What was made last time and not this time leaves the tree.
    fn finish(
        &mut self,
        making: Making,
        id: &str,
        generation: u64,
        frame: Option<u64>,
        placed: bool,
    ) -> Fragment {
        if let Some(group) = making.old_frame.filter(|old| Some(*old) != frame) {
            self.around.remove(&group);
        }
        for id in making.old_own {
            self.drop_node(id);
        }
        for old in making.old_children.into_iter().flatten() {
            self.discard(old);
        }
        Fragment {
            id: making.old_id.unwrap_or_else(|| id.into()),
            generation,
            space: self.space,
            frame,
            placed,
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
                making.placed |= fragment.placed;
                making.children.push(fragment);
            }
            NodeSpec::Text { children, .. } => {
                let words = children.concat();
                if words.trim().is_empty() {
                    return;
                }
                let id = node_id(&place.key());
                self.keep(id, tree::text_node(words), None, false, None);
                making.own.push(id);
                out.push(id);
            }
            NodeSpec::Input { props } => {
                let id = node_id(&props.id);
                self.keep(
                    id,
                    tree::field_node(props),
                    Some(&props.id),
                    !props.secure,
                    None,
                );
                making.placed = true;
                making.own.push(id);
                out.push(id);
            }
            NodeSpec::Svg { .. } | NodeSpec::Image { .. } => {}
        }
    }

    /// The group view `props` moves its content as, if it does: a scroll
    /// view's content, or a retained subtree.
    fn frame_of(&self, props: &ViewProps) -> Option<u64> {
        let id = props.id.as_deref()?;
        if props.scroll || props.scroll_x {
            // A virtualized list's rows are its content's group too (`list.rs`).
            return Some(scroll_group(id));
        }
        (self.facts.retained)(id)
    }

    /// The view `id` and what is under it: as it was (`old`) while nothing
    /// at or under it changed and it is in the frame it was made in, else
    /// made again, its child views the same way.
    fn view(
        &mut self,
        props: &ViewProps,
        children: &[NodeSpec],
        id: &str,
        old: Option<Fragment>,
    ) -> Fragment {
        let generation = self.document.subtree_generation(id);
        let old = match old {
            Some(old) if old.generation == generation && old.space == self.space => return old,
            old => old,
        };
        // Whether it is a group is read where the tree changed: a view
        // becomes a retained subtree, or stops being one, only with a
        // change at or under it (`retain.rs` looks where a patch reached).
        let frame = self.frame_of(props);
        let mut making = Making::after(old);
        // What is under it is placed in its frame, when it has one.
        let around = self.space;
        if let Some(group) = frame {
            self.around.insert(group, around);
            self.space = frame;
        }
        let role = tree::view_role(props);
        // A label that stands for its content: nothing under it is a node.
        let walks = role.is_none_or(|role| !tree::stands_for_content(props, role));
        let mut inner = Vec::new();
        if walks {
            for (index, child) in children.iter().enumerate() {
                self.child(child, Place::Under(id, index), &mut making, &mut inner);
            }
        }
        self.space = around;
        // A frame only when a node under it has a place there.
        let within = std::mem::take(&mut making.placed);
        let frame_used = frame.filter(|_| within);
        let node_id = node_id(id);
        let placed = match role {
            Some(role) => {
                let mut node = tree::view_node(props, role);
                if tree::is_selected(props) {
                    making.selected = Some(node_id);
                }
                if walks {
                    node.set_children(inner);
                }
                self.keep(node_id, node, Some(id), false, frame_used);
                making.own.push(node_id);
                making.out.push(node_id);
                true
            }
            // Only layout, and a frame: a node for that alone.
            None if frame_used.is_some() => {
                let mut node = Node::new(Role::GenericContainer);
                node.set_children(inner);
                self.keep(node_id, node, None, false, frame_used);
                making.own.push(node_id);
                making.out.push(node_id);
                true
            }
            // Only layout: its children join the node above.
            None => {
                making.out = inner;
                within
            }
        };
        self.finish(making, id, generation, frame, placed)
    }

    /// The window over the whole tree.
    pub(super) fn window(&mut self, old: Option<Fragment>) -> Fragment {
        let mut making = Making::after(old);
        let mut top = Vec::new();
        self.child(self.document, Place::Top, &mut making, &mut top);
        let window = tree::window_node(self.facts.title, top);
        self.keep(ROOT, window, None, false, None);
        making.own.push(ROOT);
        making.out.push(ROOT);
        self.finish(making, "", self.document.generation(), None, false)
    }
}
