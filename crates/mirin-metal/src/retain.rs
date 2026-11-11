//! Retained subtrees: parts of the tree GPUI keeps across frames.
//!
//! Every frame used to build, lay out, prepaint and paint the whole tree, so
//! a frame cost what the tree's size did whatever changed. A view whose
//! subtree renders only from its own content (no renderer-side state such as
//! a field's text, focus, or a scroll offset) becomes a retained subtree
//! (`gpui::retained`, mirin's GPUI fork): it is built only when its content
//! differs from the previous tree (its `version`) or GPUI notified it (a
//! hover style changed), and otherwise keeps its layout and last frame's
//! drawing. Trees are compared as they arrive (`Boundaries::sync`), which
//! is linear in the tree but far cheaper than drawing it.

use std::collections::HashMap;

use gpui::{
    div, prelude::*, AnyElement, App, Context, ElementId, Entity, EntityId, SharedString, Window,
};

use crate::patch::Document;
use crate::render::render_view;
use crate::tree::{NodeSpec, ViewProps};
use crate::window::RootView;

/// The fewest nodes a subtree has to be worth keeping: each kept subtree
/// costs some bookkeeping per frame it is drawn.
const MIN_NODES: usize = 4;

/// What notifications name a retained subtree by (GPUI's hover styles and
/// image loads notify the view they are drawn in): an entity per subtree.
pub(crate) struct Notified;

struct Boundary {
    /// Bumped whenever the subtree's content changes.
    version: u64,
    /// Its group in the layout map (`sim::LayoutMap::touch_group`).
    group: u64,
    entity: Entity<Notified>,
    /// Child indices from the root to it in the current tree.
    path: Vec<u32>,
    /// Found in the latest sync (and only once).
    seen: bool,
}

/// The retained subtrees of the current tree, by node id.
#[derive(Default)]
pub(crate) struct Boundaries {
    map: HashMap<String, Boundary>,
    next: u64,
    /// The tree generation the last sync saw (`patch::Document`).
    synced: u64,
}

/// What a subtree is, as far as keeping it goes.
struct Walk {
    /// Renders from its content alone.
    pure: bool,
    nodes: usize,
    /// Equal to the subtree it was paired with in the previous tree.
    same: bool,
}

impl Boundaries {
    /// Bring the retained subtrees in line with `doc` after an update:
    /// subtrees whose content changed get a new version, new ones are added,
    /// and ones no longer in the tree (or whose id is not unique) are dropped.
    /// After a patch (`by_generation`) a subtree changed when its subtree
    /// generation is newer than the last sync; after a whole tree it is
    /// compared with the one it replaced (`old`; none: all changed).
    pub(crate) fn sync(
        &mut self,
        old: Option<&NodeSpec>,
        doc: &Document,
        by_generation: bool,
        cx: &mut App,
    ) {
        if !enabled() {
            return;
        }
        for boundary in self.map.values_mut() {
            boundary.seen = false;
        }
        let mut path = Vec::new();
        let mut duplicates = Vec::new();
        let synced = self.synced;
        let changed = |id: &str| doc.subtree_generation(id) > synced;
        let changed: Option<&dyn Fn(&str) -> bool> = by_generation.then_some(&changed);
        self.walk(doc, old, changed, &mut path, &mut duplicates, cx);
        self.synced = doc.generation();
        self.map.retain(|_, boundary| boundary.seen);
        for id in duplicates {
            self.map.remove(&id);
        }
    }

    fn walk(
        &mut self,
        node: &NodeSpec,
        old: Option<&NodeSpec>,
        changed: Option<&dyn Fn(&str) -> bool>,
        path: &mut Vec<u32>,
        duplicates: &mut Vec<String>,
        cx: &mut App,
    ) -> Walk {
        let NodeSpec::View { props, children } = node else {
            return Walk {
                pure: !matches!(node, NodeSpec::Input { .. }),
                nodes: 1,
                same: old == Some(node),
            };
        };
        let old_view = match old {
            Some(NodeSpec::View { props, children }) => Some((props, children)),
            _ => None,
        };
        let by_index = old_view.is_some_and(|(_, old_children)| {
            old_children.len() == children.len()
                && old_children
                    .iter()
                    .zip(children)
                    .all(|(old, new)| crate::render::node_id(old) == crate::render::node_id(new))
        });
        let by_id: HashMap<String, &NodeSpec> = match old_view {
            Some((_, old_children)) if !by_index => old_children
                .iter()
                .filter_map(|child| crate::render::node_id(child).map(|id| (id, child)))
                .collect(),
            _ => HashMap::new(),
        };
        let mut walk = Walk {
            pure: pure_view(props, children),
            nodes: 1,
            same: by_index && old_view.is_some_and(|(old_props, _)| old_props == props),
        };
        for (index, child) in children.iter().enumerate() {
            let paired = match old_view {
                Some((_, old_children)) if by_index => old_children.get(index),
                Some(_) => crate::render::node_id(child).and_then(|id| by_id.get(&id).copied()),
                None => None,
            };
            path.push(index as u32);
            let child_walk = self.walk(child, paired, changed, path, duplicates, cx);
            path.pop();
            walk.pure &= child_walk.pure;
            walk.nodes += child_walk.nodes;
            walk.same &= child_walk.same;
        }
        if let Some(id) = props
            .id
            .as_deref()
            .filter(|_| walk.pure && walk.nodes >= MIN_NODES)
        {
            let same = changed.map_or(walk.same, |changed| !changed(id));
            self.keep(id, same, path, duplicates, cx);
        }
        walk
    }

    fn keep(
        &mut self,
        id: &str,
        same: bool,
        path: &[u32],
        duplicates: &mut Vec<String>,
        cx: &mut App,
    ) {
        if let Some(boundary) = self.map.get_mut(id) {
            if boundary.seen {
                // Two nodes with one id: neither can be found by it.
                duplicates.push(id.to_owned());
                return;
            }
            boundary.seen = true;
            path.clone_into(&mut boundary.path);
            if !same {
                self.next += 1;
                boundary.version = self.next;
            }
            return;
        }
        self.next += 1;
        let boundary = Boundary {
            version: self.next,
            group: self.next,
            entity: cx.new(|_| Notified),
            path: path.to_vec(),
            seen: true,
        };
        self.map.insert(id.to_owned(), boundary);
    }

    fn get(&self, id: &str) -> Option<&Boundary> {
        self.map.get(id)
    }
}

thread_local! {
    /// Retained subtrees built and reused since the last `take_counts` (traced per frame).
    static COUNTS: std::cell::Cell<(u32, u32)> = const { std::cell::Cell::new((0, 0)) };
}

/// How many retained subtrees were built and how many reused since the last call.
pub(crate) fn take_counts() -> (u32, u32) {
    COUNTS.with(|counts| counts.replace((0, 0)))
}

fn count(built: u32, reused: u32) {
    COUNTS.with(|counts| {
        let (b, r) = counts.get();
        counts.set((b + built, r + reused));
    });
}

/// Whether subtrees are kept (`MIRIN_METAL_RETAIN=0` draws every frame
/// whole, as before: for comparing the two).
fn enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("MIRIN_METAL_RETAIN").map_or(true, |value| value != "0"))
}

/// Whether a view renders from its own props alone (its children are
/// checked separately): nothing it draws reads renderer-side state that
/// changes without its content changing or GPUI notifying it.
fn pure_view(props: &ViewProps, children: &[NodeSpec]) -> bool {
    !(props.focusable
        || props.focus_group
        || props.focus_trap
        || props.selects_on_focus
        || props.focus_ring_color.is_some()
        || props.on_window_key
        || props.on_key_down
        || props.scroll
        || props.scroll_x
        || props.height_transition_ms.is_some()
        || props.drag_files.is_some()
        || props.on_drop
        || crate::list::virtualizes(props, children))
}

/// The node at `path` from `root`.
fn node_at<'a>(root: &'a NodeSpec, path: &[u32]) -> Option<&'a NodeSpec> {
    path.iter().try_fold(root, |node, &index| match node {
        NodeSpec::View { children, .. } => children.get(index as usize),
        _ => None,
    })
}

/// A retained subtree for the view `props`, when it is one.
pub(crate) fn boundary(
    props: &ViewProps,
    view: &mut RootView,
    cx: &mut Context<RootView>,
) -> Option<AnyElement> {
    let id = props.id.as_deref()?;
    let boundary = view.boundaries.get(id)?;
    // Whether it keeps its length in a scroll view is the one thing its
    // parent decides about how it renders (render.rs); it is part of its version.
    let keeps_length = std::mem::take(&mut view.keeps_length);
    let version = boundary.version * 2 + u64::from(keeps_length);
    let (group, parent) = (boundary.group, view.group);
    let notified: EntityId = boundary.entity.entity_id();
    let root = cx.entity();
    let node_id: SharedString = id.to_owned().into();
    let layout = view.layout.clone();
    let element = gpui::retained(
        ElementId::Name(node_id.clone()),
        notified,
        version,
        move |window: &mut Window, cx: &mut App| {
            root.update(cx, |view, cx| {
                build(view, &node_id, keeps_length, group, window, cx)
            })
        },
    )
    .on_prepaint(move |reused, _window, _cx| {
        layout.touch_group(group, parent, reused);
        count(0, u32::from(reused));
    });
    Some(element.into_any_element())
}

/// Build a retained subtree's elements (GPUI asks when it changed).
fn build(
    view: &mut RootView,
    id: &str,
    keeps_length: bool,
    group: u64,
    window: &mut Window,
    cx: &mut Context<RootView>,
) -> AnyElement {
    count(1, 0);
    // Shared only while it is built: a tree held past the frame makes the
    // next patch copy it whole.
    let tree = std::rc::Rc::clone(view.tree.tree());
    let node = view
        .boundaries
        .get(id)
        .and_then(|boundary| node_at(&tree, &boundary.path));
    let Some(NodeSpec::View { props, children }) = node else {
        return div().into_any_element();
    };
    let parent = view.group.replace(group);
    view.keeps_length = keeps_length;
    let element = render_view(props, children, view, window, cx);
    view.group = parent;
    element
}

#[cfg(test)]
mod tests;
