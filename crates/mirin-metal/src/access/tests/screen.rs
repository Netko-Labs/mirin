//! A window as the host has it, for the tests: the tree patches change,
//! what a paint records in the layout map (as `render.rs` and `retain.rs`
//! do), the tree kept for the adapter, and AccessKit's own tree hearing
//! every update (it panics on one that names a node it cannot place).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;
use std::sync::Mutex;

use accesskit::{Node, NodeId, Rect};
use accesskit_consumer::{common_filter, NodeRef, Tree, TreeChangeHandler};
use gpui::{point, px, size, Bounds, Pixels};

use super::super::published::Published;
use super::super::tree::{node_id, Facts, Targets};
use crate::layout::{scroll_group, LayoutMap};
use crate::patch::{parse_patch, Document};
use crate::tree::{parse_tree, NodeSpec};

struct Quiet;

impl TreeChangeHandler for Quiet {
    fn node_added(&mut self, _: &NodeRef) {}
    fn node_updated(&mut self, _: &NodeRef, _: &NodeRef) {}
    fn focus_moved(&mut self, _: Option<&NodeRef>, _: Option<&NodeRef>) {}
    fn node_removed(&mut self, _: &NodeRef) {}
}

/// Every node under the root of AccessKit's own tree, by id.
fn nodes_of(tree: &Tree) -> BTreeMap<u64, Node> {
    fn gather(node: &NodeRef, nodes: &mut BTreeMap<u64, Node>) {
        nodes.insert(node.locate().0 .0, node.data().clone());
        for child in node.children() {
            gather(&child, nodes);
        }
    }
    let mut nodes = BTreeMap::new();
    gather(&tree.state().root(), &mut nodes);
    nodes
}

/// Where a screen reader finds each node that has bounds: in the window,
/// AccessKit having added up the frames above it.
fn boxes_of(tree: &Tree) -> BTreeMap<u64, Rect> {
    fn gather(node: &NodeRef, boxes: &mut BTreeMap<u64, Rect>) {
        if let Some(found) = node.bounding_box() {
            boxes.insert(node.locate().0 .0, found);
        }
        for child in node.children() {
            gather(&child, boxes);
        }
    }
    let mut boxes = BTreeMap::new();
    gather(&tree.state().root(), &mut boxes);
    boxes
}

/// The tree as a screen reader walks it (the nodes AccessKit's adapters
/// leave out are not in it): each node's role, name, value, and where it is.
fn outline_of(tree: &Tree) -> Vec<String> {
    fn gather(node: &NodeRef, depth: usize, lines: &mut Vec<String>) {
        let found = node.bounding_box().map(|b| (b.x0, b.y0, b.x1, b.y1));
        lines.push(format!(
            "{depth} {:?} {:?} {:?} {found:?}",
            node.role(),
            node.label(),
            node.value()
        ));
        for child in node.filtered_children(&common_filter) {
            gather(&child, depth + 1, lines);
        }
    }
    let mut lines = Vec::new();
    gather(&tree.state().root(), 0, &mut lines);
    lines
}

pub(super) fn at(x: f64, y: f64) -> Rect {
    Rect::new(x, y, x + 10.0, y + 10.0)
}

fn pixels(rect: Rect) -> Bounds<Pixels> {
    Bounds::new(
        point(px(rect.x0 as f32), px(rect.y0 as f32)),
        size(px(rect.width() as f32), px(rect.height() as f32)),
    )
}

pub(super) struct Screen {
    pub(super) document: Document,
    pub(super) title: String,
    /// Where elements are painted in the window, when not at the origin;
    /// None is not painted.
    pub(super) painted: HashMap<String, Option<Rect>>,
    /// The views GPUI keeps the drawing of, and the group of each.
    retained: HashMap<String, u64>,
    /// How many groups there have been.
    groups: u64,
    /// The tree each retained view was last drawn anew for.
    drawn: HashMap<String, u64>,
    /// Elements painted elsewhere since the last frame: the retained
    /// subtrees around them are drawn anew.
    dirty: HashSet<String>,
    /// The ones painted elsewhere on their own, what is under them staying
    /// where it was: a retained subtree of theirs is drawn anew as well.
    alone: HashSet<String>,
    pub(super) layout: LayoutMap,
    focused: Option<String>,
    typed: Option<String>,
    published: Published,
    targets: Mutex<Targets>,
    heard: Option<Tree>,
}

/// What one update took: nodes made from their elements, nodes handed over.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Took {
    pub(super) built: usize,
    pub(super) sent: usize,
}

/// The ids of the elements at and under `node`.
fn ids_under(node: &NodeSpec, ids: &mut Vec<String>) {
    match node {
        NodeSpec::View { props, children } => {
            ids.extend(props.id.clone());
            children.iter().for_each(|child| ids_under(child, ids));
        }
        NodeSpec::Input { props } => ids.push(props.id.clone()),
        _ => {}
    }
}

/// The element `id` at or under `node`.
fn find<'a>(node: &'a NodeSpec, id: &str) -> Option<&'a NodeSpec> {
    match node {
        NodeSpec::View { props, children } if props.id.as_deref() != Some(id) => {
            children.iter().find_map(|child| find(child, id))
        }
        NodeSpec::View { .. } => Some(node),
        NodeSpec::Input { props } if props.id == id => Some(node),
        _ => None,
    }
}

impl Screen {
    pub(super) fn new(json: &str) -> Self {
        Self {
            document: Document::new(parse_tree(json).expect("the tree parses")),
            title: "Launcher".to_owned(),
            painted: HashMap::new(),
            retained: HashMap::new(),
            groups: 0,
            drawn: HashMap::new(),
            dirty: HashSet::new(),
            alone: HashSet::new(),
            layout: LayoutMap::default(),
            focused: None,
            typed: None,
            published: Published::default(),
            targets: Mutex::default(),
            heard: None,
        }
    }

    pub(super) fn patch(&mut self, ops: &str) {
        let ops = parse_patch(&format!(r#"{{"patch":[{ops}]}}"#)).expect("the patch parses");
        self.document.apply(ops).expect("the patch applies");
    }

    /// GPUI keeps the drawing of view `id` from now on (or no longer). As in
    /// the host, that comes with a change to the tree at or under the view
    /// (`retain.rs` looks where a patch reached), which is the caller's to
    /// make.
    pub(super) fn retain(&mut self, id: &str, retained: bool) {
        self.drawn.remove(id);
        if retained {
            self.groups += 1;
            self.retained.entry(id.to_owned()).or_insert(self.groups);
        } else {
            self.retained.remove(id);
        }
    }

    fn bounds(&self, id: &str) -> Option<Rect> {
        match self.painted.get(id) {
            Some(bounds) => *bounds,
            None => Some(at(0.0, 0.0)),
        }
    }

    /// `id` is painted at `bounds` now (not at all for None): what draws it
    /// is drawn anew.
    pub(super) fn paint(&mut self, id: &str, bounds: Option<Rect>) {
        self.painted.insert(id.to_owned(), bounds);
        self.dirty.insert(id.to_owned());
        self.alone.insert(id.to_owned());
    }

    /// Everything under view `id` is painted `dy` further down, as it is: a
    /// scroll of its content.
    pub(super) fn scroll(&mut self, id: &str, dy: f64) {
        let mut ids = Vec::new();
        if let Some(NodeSpec::View { children, .. }) = find(&self.document, id) {
            children.iter().for_each(|child| ids_under(child, &mut ids));
        }
        assert!(!ids.is_empty(), "{id} has content");
        self.move_all(&ids, dy);
    }

    /// View `id` and everything under it are painted `dy` further down (what
    /// is above it grew): what draws the view is drawn anew, the view itself
    /// is moved as it is.
    pub(super) fn push(&mut self, id: &str, dy: f64) {
        let mut ids = Vec::new();
        if let Some(node) = find(&self.document, id) {
            ids_under(node, &mut ids);
        }
        assert!(!ids.is_empty(), "{id} is in the tree");
        self.move_all(&ids, dy);
        self.dirty.insert(id.to_owned());
    }

    fn move_all(&mut self, ids: &[String], dy: f64) {
        for id in ids {
            if let Some(bounds) = self.bounds(id) {
                let moved = bounds.with_origin((bounds.x0, bounds.y0 + dy));
                self.painted.insert(id.clone(), Some(moved));
            }
        }
    }

    pub(super) fn focus(&mut self, id: Option<&str>, typed: Option<&str>) {
        self.focused = id.map(str::to_owned);
        self.typed = typed.map(str::to_owned);
    }

    /// A frame: every painted element records its bounds in what draws it,
    /// except inside a retained view that is as it was, which only says
    /// where it is.
    pub(super) fn frame(&mut self) {
        self.layout.begin_frame();
        let tree = Rc::clone(self.document.tree());
        self.draw(&tree, None);
        self.layout.end_frame();
        self.dirty.clear();
        self.alone.clear();
    }

    /// Whether anything strictly under `node` was painted elsewhere.
    fn dirty_under(&self, node: &NodeSpec) -> bool {
        let NodeSpec::View { children, .. } = node else {
            return false;
        };
        let mut ids = Vec::new();
        children.iter().for_each(|child| ids_under(child, &mut ids));
        ids.iter().any(|id| self.dirty.contains(id))
    }

    fn draw(&mut self, node: &NodeSpec, group: Option<u64>) {
        let (id, children) = match node {
            NodeSpec::View { props, children } => (props.id.as_deref(), children.as_slice()),
            NodeSpec::Input { props } => (Some(props.id.as_str()), [].as_slice()),
            _ => return,
        };
        let bounds = id.and_then(|id| self.bounds(id));
        if let Some((id, bounds)) = id.zip(bounds) {
            self.layout.record(id, pixels(bounds), group);
        }
        let scrolls = matches!(node, NodeSpec::View { props, .. } if props.scroll);
        let mut inside = group;
        if let Some((id, bounds)) = id.zip(bounds) {
            let origin = pixels(bounds).origin;
            if scrolls {
                // Its content's group, where its first child is (the scroll).
                let first = children.iter().find_map(|child| {
                    let mut ids = Vec::new();
                    ids_under(child, &mut ids);
                    self.bounds(ids.first()?)
                });
                let origin = first.map_or(origin, |first| pixels(first).origin);
                inside = Some(scroll_group(id));
                self.layout
                    .touch_group(scroll_group(id), group, origin, true);
            } else if let Some(&retained) = self.retained.get(id) {
                let generation = self.document.subtree_generation(id);
                let anew = self.drawn.get(id) != Some(&generation)
                    || self.alone.contains(id)
                    || self.dirty_under(node);
                self.layout.touch_group(retained, group, origin, anew);
                if !anew {
                    return;
                }
                self.drawn.insert(id.to_owned(), generation);
                inside = Some(retained);
            }
        }
        for child in children {
            self.draw(child, inside);
        }
    }

    /// One update, as after a paint, checked against a tree made from
    /// nothing and against where everything was painted.
    pub(super) fn update(&mut self) -> Took {
        self.frame();
        let retained = &self.retained;
        let facts = Facts {
            title: &self.title,
            layout: &self.layout,
            retained: &|id| retained.get(id).copied(),
            focused: self.focused.as_deref(),
            typed: self.typed.as_deref(),
        };
        let update = self.published.update(&self.document, &facts, &self.targets);
        let took = Took {
            built: update.built,
            sent: update.tree.nodes.len(),
        };
        let focus = update.tree.focus;
        match &mut self.heard {
            Some(heard) => heard.update_and_process_changes(update.tree, &mut Quiet),
            None => self.heard = Some(Tree::new(update.tree, true)),
        }
        let heard = self.heard.as_ref().expect("the tree was just heard");

        let whole_targets = Mutex::default();
        let mut whole = Published::default();
        let whole_update = whole.update(&self.document, &facts, &whole_targets);
        assert_eq!(focus, whole_update.tree.focus, "the focus");
        let whole_nodes = whole_update.tree.nodes.len();
        let expected = Tree::new(whole_update.tree, true);
        assert_eq!(
            nodes_of(heard),
            nodes_of(&expected),
            "what a screen reader has"
        );
        assert_eq!(
            nodes_of(&expected).len(),
            whole_nodes,
            "a whole tree is all under the root"
        );
        assert_eq!(self.published.differences(&whole), 0, "what is kept");
        assert_eq!(
            *self.targets.lock().unwrap(),
            *whole_targets.lock().unwrap(),
            "where presses and focus go"
        );
        // Where a screen reader finds each element is where it was painted.
        assert_eq!(self.published.misplaced(&self.layout), 0, "the places");
        let mut ids = Vec::new();
        ids_under(&self.document, &mut ids);
        let boxes = boxes_of(heard);
        for id in ids {
            let node = node_id(&id);
            // Only layout: no node, or one that is only a frame.
            let stands = self.published.stands_for(node, &id);
            let painted = self.bounds(&id).filter(|_| stands);
            assert_eq!(boxes.get(&node.0).copied(), painted, "where {id} is");
        }
        took
    }

    pub(super) fn heard(&self, id: NodeId) -> Option<Node> {
        nodes_of(self.heard.as_ref()?).remove(&id.0)
    }

    /// How many nodes are frames now.
    pub(super) fn frames(&self) -> usize {
        let heard = self.heard.as_ref().expect("an update was heard");
        let nodes = nodes_of(heard);
        nodes
            .values()
            .filter(|node| node.transform().is_some())
            .count()
    }

    /// The tree as a screen reader walks it.
    pub(super) fn outline(&self) -> Vec<String> {
        outline_of(self.heard.as_ref().expect("an update was heard"))
    }
}
