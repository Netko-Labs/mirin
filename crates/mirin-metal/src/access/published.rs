//! The accessibility tree as the adapter has it, kept so the next update
//! costs what changed and carries only the nodes that did.
//!
//! - **The element tree.** Each view's subtree is remembered by the
//!   generation it was made in (`patch::Document::subtree_generation`): a
//!   view whose generation stands is skipped with everything under it, and
//!   only views a patch reached are made again. A whole tree changes every
//!   generation, so it is made again whole.
//! - **Bounds.** They come from the last paint, and move without the tree
//!   changing (a scroll, a resize, a row that grew above): when the layout
//!   says any did (`Facts::moved`), every kept node's bounds are compared
//!   with where it was painted, and the ones that differ go in the update.
//!   A view whose own props changed may also stop painting what is under it
//!   with nothing moving, so the bounds under it are compared then too.
//! - **The keyboard.** What is typed in the focused field and the option a
//!   focused combo box points at are laid over that one node, so moving the
//!   focus or typing rebuilds nothing.
//!
//! A node is in an update only when it differs from the one last handed
//! over. Nodes that left the tree are never named: AccessKit drops what is
//! no longer under the root.
use std::collections::HashMap;
use std::sync::Mutex;

use accesskit::{Action, Node, NodeId, Rect, Role, TreeId, TreeInfo, TreeUpdate};

use super::tree::{node_id, Facts, Targets, ROOT};
use super::walk::{Fragment, Walk};
use crate::patch::Document;

/// A node as last handed over, apart: what its element says, and what the
/// renderer adds.
pub(super) struct Kept {
    /// The node from its element alone: no bounds, a field's value the
    /// driver's.
    pub(super) base: Node,
    /// The view or field it stands for: where its bounds come from, and
    /// where a press or a focus on it goes. None for text and the window.
    pub(super) element: Option<Box<str>>,
    pub(super) bounds: Option<Rect>,
    /// A field whose words are published (never a password's): with the
    /// keyboard, what is typed stands for the driver's value.
    pub(super) typed: bool,
    /// The update that last made it.
    pub(super) stamp: u64,
}

impl Kept {
    /// The node handed over: its element's, at its bounds, under `overlay`.
    fn node(&self, overlay: Option<&Overlay>) -> Node {
        let mut node = self.base.clone();
        if let Some(bounds) = self.bounds {
            node.set_bounds(bounds);
        }
        if let Some(overlay) = overlay {
            if let Some(value) = overlay.value.as_deref() {
                node.set_value(value);
            }
            if let Some(active) = overlay.active {
                node.set_active_descendant(active);
            }
        }
        node
    }
}

/// What the node with the keyboard says beyond its element.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Overlay {
    node: NodeId,
    /// What is typed in the field.
    value: Option<String>,
    /// The selected option a combo box points at.
    active: Option<NodeId>,
}

/// The tree's nodes since the last update, and what making them took.
pub(crate) struct Update {
    /// Only the nodes that changed; the whole tree the first time.
    pub tree: TreeUpdate,
    /// How many nodes were made again from their elements.
    pub built: usize,
    /// How many kept nodes' bounds were compared with the paint.
    pub compared: usize,
}

/// One window's accessibility tree as last handed to the adapter.
#[derive(Default)]
pub(crate) struct Published {
    kept: HashMap<NodeId, Kept>,
    /// The window's fragment, over the tree's; none before the first update.
    window: Option<Fragment>,
    overlay: Option<Overlay>,
    stamp: u64,
}

impl Published {
    /// Bring the tree in line with `document` as just painted, and say which
    /// nodes changed. `targets` follows: where a press or a focus on each
    /// node goes.
    pub(crate) fn update(
        &mut self,
        document: &Document,
        facts: &Facts,
        targets: &Mutex<Targets>,
    ) -> Update {
        self.stamp += 1;
        let first = self.window.is_none();
        let mut walk = Walk::new(document, facts, &mut self.kept, self.stamp);
        let window = walk.window(self.window.take());
        if facts.moved {
            walk.follow_all();
        }
        let Walk {
            mut changed,
            gone,
            built,
            compared,
            ..
        } = walk;
        let selected = window.selected;
        self.window = Some(window);

        // The element with the keyboard is the focus when it is a node that
        // takes it: a field, or a focusable view.
        let focused = facts.focused.and_then(|element| {
            let id = node_id(element);
            let kept = self.kept.get(&id)?;
            let takes = kept.base.supports_action(Action::Focus);
            (takes && kept.element.as_deref() == Some(element)).then_some((id, kept))
        });
        let overlay = focused.and_then(|(node, kept)| {
            let value = facts.typed.filter(|_| kept.typed).map(str::to_owned);
            let active = selected.filter(|_| kept.base.role() == Role::EditableComboBox);
            (value.is_some() || active.is_some()).then_some(Overlay {
                node,
                value,
                active,
            })
        });
        let focus = focused.map_or(ROOT, |(id, _)| id);
        if overlay != self.overlay {
            changed.extend(self.overlay.iter().map(|overlay| overlay.node));
            changed.extend(overlay.iter().map(|overlay| overlay.node));
            self.overlay = overlay;
        }
        changed.sort_unstable_by_key(|id| id.0);
        changed.dedup();

        if let Ok(mut targets) = targets.lock() {
            for id in gone {
                targets.forget(id);
            }
            for id in &changed {
                if let Some(kept) = self.kept.get(id) {
                    targets.set(*id, &kept.base, kept.element.as_deref());
                }
            }
        }
        let nodes = changed
            .into_iter()
            .filter_map(|id| Some((id, self.node(id)?)))
            .collect();
        let info = first.then(|| {
            let mut info = TreeInfo::new(ROOT);
            info.toolkit_name = Some("mirin metal".into());
            info
        });
        Update {
            tree: TreeUpdate {
                nodes,
                tree: info,
                tree_id: TreeId::ROOT,
                focus,
            },
            built,
            compared,
        }
    }

    /// The node `id` as handed over.
    fn node(&self, id: NodeId) -> Option<Node> {
        let overlay = self.overlay.as_ref().filter(|overlay| overlay.node == id);
        Some(self.kept.get(&id)?.node(overlay))
    }

    /// Whether nothing is kept (nothing handed over yet, or forgotten).
    pub(crate) fn is_empty(&self) -> bool {
        self.window.is_none()
    }

    /// How many nodes differ from `other`'s (kept by one and not the other,
    /// or not the same node): none when a tree kept across updates is the
    /// tree made from nothing.
    pub(crate) fn differences(&self, other: &Self) -> usize {
        let differs = |id: &NodeId| self.node(*id) != other.node(*id);
        let here = self.kept.keys().filter(|id| differs(id)).count();
        let there = other.kept.keys();
        here + there.filter(|id| !self.kept.contains_key(id)).count()
    }
}
