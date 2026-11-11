//! The retained tree a window shows, changed in place by patches, and when
//! each node last changed.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::rc::Rc;

use super::{PatchOp, Touched};
use crate::tree::NodeSpec;

/// Why a patch could not be applied; the driver is asked for the whole tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PatchError(String);

impl fmt::Display for PatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl PatchError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

fn error(message: impl Into<String>) -> PatchError {
    PatchError(message.into())
}

/// What a patch changed that the renderer keeps state for.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Applied {
    /// What came, went, moved, or changed (`Touched`).
    pub(crate) touched: Touched,
    /// Fields whose props changed (they stayed where they were).
    pub(crate) fields: Vec<String>,
}

impl Applied {
    /// A whole tree, or a patch that failed: anything may have changed.
    pub(crate) fn everything() -> Self {
        Self {
            touched: Touched::ALL,
            fields: Vec::new(),
        }
    }
}

/// Where a node is (its parent's id; none for the root, or under a node with
/// no id) and when it changed.
#[derive(Debug, Clone)]
struct Entry {
    parent: Option<String>,
    /// The update its own props, text, or list of children last changed in.
    own: u64,
    /// The update anything in its subtree (itself included) last changed in.
    subtree: u64,
}

type Index = HashMap<String, Entry>;

/// The tree a window shows. A whole tree replaces it; a patch changes it in
/// place (`apply`). Every update has a generation, one more than the last;
/// `own_generation` and `subtree_generation` say which update last changed a
/// node, or anything under it, so the renderer can keep what it built for a
/// subtree whose generation it has seen.
pub(crate) struct Document {
    tree: Rc<NodeSpec>,
    /// Where each node with an id is; built on the first patch after a whole
    /// tree, so a driver that never patches never pays for it.
    index: Option<Index>,
    generation: u64,
    /// The generation of the last whole tree (or failed patch): every node
    /// changed then.
    replaced_at: u64,
}

impl std::ops::Deref for Document {
    type Target = NodeSpec;

    fn deref(&self) -> &NodeSpec {
        &self.tree
    }
}

impl Document {
    pub(crate) fn new(tree: NodeSpec) -> Self {
        Self {
            tree: Rc::new(tree),
            index: None,
            generation: 1,
            replaced_at: 1,
        }
    }

    /// The tree, shared with a frame that walks it. Holding it past the frame
    /// makes the next patch copy the whole tree.
    pub(crate) fn tree(&self) -> &Rc<NodeSpec> {
        &self.tree
    }

    /// Replace the whole tree: every node changes in this generation.
    pub(crate) fn replace(&mut self, tree: NodeSpec) {
        self.generation += 1;
        self.replaced_at = self.generation;
        self.index = None;
        self.tree = Rc::new(tree);
    }

    /// The newest update's generation; it grows by one per update.
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    /// The update the node `id`'s own props, text, or list of children last
    /// changed in; an id it doesn't know (none, a node without one) answers
    /// the newest generation, as if it had just changed. For the renderer,
    /// to keep what it built for a node whose own generation it has seen.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn own_generation(&self, id: &str) -> u64 {
        self.lookup(id, |entry| entry.own)
    }

    /// The update anything in the node `id`'s subtree (itself included) last
    /// changed in; unknown ids answer the newest generation.
    pub(crate) fn subtree_generation(&self, id: &str) -> u64 {
        self.lookup(id, |entry| entry.subtree)
    }

    fn lookup(&self, id: &str, field: fn(&Entry) -> u64) -> u64 {
        match &self.index {
            None => self.replaced_at,
            Some(index) => index.get(id).map_or(self.generation, field),
        }
    }

    /// Apply a patch's ops in order, as one update, and say what renderer
    /// state they may concern. On an error the ops before it stay applied,
    /// every node counts as changed, and the tree is what it is until the
    /// driver sends a whole one.
    pub(crate) fn apply(&mut self, ops: Vec<PatchOp>) -> Result<Applied, PatchError> {
        self.generation += 1;
        let generation = self.generation;
        let mut index = match self.index.take() {
            Some(index) => index,
            None => match build_index(&self.tree, self.replaced_at) {
                Ok(index) => index,
                Err(error) => {
                    self.replaced_at = generation;
                    return Err(error);
                }
            },
        };
        if Rc::strong_count(&self.tree) > 1 {
            crate::trace::log(format_args!(
                "patch: the tree is still shared; copying it whole"
            ));
        }
        let root = Rc::make_mut(&mut self.tree);
        let mut changes = Changes {
            generation,
            changed: Vec::new(),
            applied: Applied::default(),
        };
        for op in ops {
            if let Err(error) = apply_op(root, &mut index, op, &mut changes) {
                self.replaced_at = generation;
                return Err(error);
            }
        }
        for id in changes.changed {
            propagate(&mut index, id, generation);
        }
        self.index = Some(index);
        Ok(changes.applied)
    }

    /// The node `id`, if the tree has it (found along its parents).
    pub(crate) fn find(&self, id: &str) -> Option<&NodeSpec> {
        let path = path(self.index.as_ref()?, id).ok()?;
        let mut node: &NodeSpec = &self.tree;
        if path.is_empty() {
            return (node.key() == Some(id)).then_some(node);
        }
        for key in &path {
            let NodeSpec::View { children, .. } = node else {
                return None;
            };
            node = children
                .iter()
                .find(|child| child.key() == Some(key.as_str()))?;
        }
        Some(node)
    }
}

/// Every node with an id, where it is. Ids must be unique, and the root must
/// have one, or nothing can be addressed.
fn build_index(root: &NodeSpec, generation: u64) -> Result<Index, PatchError> {
    if root.key().is_none() {
        return Err(error("the root has no id"));
    }
    let mut index = Index::new();
    add_subtree(&mut index, root, None, generation)?;
    Ok(index)
}

/// Index `node` and its subtree under `parent`, as changed in `generation`;
/// an id already indexed is an error (nothing is added then).
fn add_subtree(
    index: &mut Index,
    node: &NodeSpec,
    parent: Option<&str>,
    generation: u64,
) -> Result<(), PatchError> {
    let mut seen = HashSet::new();
    check_new(index, node, &mut seen)?;
    insert_entries(index, node, parent, generation);
    Ok(())
}

fn check_new<'a>(
    index: &Index,
    node: &'a NodeSpec,
    seen: &mut HashSet<&'a str>,
) -> Result<(), PatchError> {
    if let Some(key) = node.key() {
        if index.contains_key(key) || !seen.insert(key) {
            return Err(error(format!("id {key:?} is already in the tree")));
        }
    }
    if let NodeSpec::View { children, .. } = node {
        for child in children {
            check_new(index, child, seen)?;
        }
    }
    Ok(())
}

fn insert_entries(index: &mut Index, node: &NodeSpec, parent: Option<&str>, generation: u64) {
    let key = node.key();
    if let Some(key) = key {
        index.insert(
            key.to_owned(),
            Entry {
                parent: parent.map(str::to_owned),
                own: generation,
                subtree: generation,
            },
        );
    }
    if let NodeSpec::View { children, .. } = node {
        for child in children {
            insert_entries(index, child, key, generation);
        }
    }
}

fn remove_entries(index: &mut Index, node: &NodeSpec) {
    if let Some(key) = node.key() {
        index.remove(key);
    }
    if let NodeSpec::View { children, .. } = node {
        for child in children {
            remove_entries(index, child);
        }
    }
}

/// The ids from the root's child down to `id` (empty for the root).
fn path(index: &Index, id: &str) -> Result<Vec<String>, PatchError> {
    let mut path = Vec::new();
    let mut current = id;
    loop {
        let entry = index
            .get(current)
            .ok_or_else(|| error(format!("no node {current:?}")))?;
        match &entry.parent {
            Some(parent) => {
                path.push(current.to_owned());
                current = parent;
            }
            None => break,
        }
        if path.len() > index.len() {
            return Err(error("the tree's parents loop"));
        }
    }
    path.reverse();
    Ok(path)
}

/// The node `id`, found from the root along its parents.
fn locate<'a>(
    root: &'a mut NodeSpec,
    index: &Index,
    id: &str,
) -> Result<&'a mut NodeSpec, PatchError> {
    let path = path(index, id)?;
    if path.is_empty() && root.key() != Some(id) {
        return Err(error(format!("node {id:?} is not under the root")));
    }
    let mut node = root;
    for key in &path {
        let NodeSpec::View { children, .. } = node else {
            return Err(error(format!(
                "node {key:?} is under a node that isn't a view"
            )));
        };
        let at = children
            .iter()
            .position(|child| child.key() == Some(key.as_str()))
            .ok_or_else(|| error(format!("node {key:?} is not where the index has it")))?;
        node = &mut children[at];
    }
    Ok(node)
}

fn children_of<'a>(
    root: &'a mut NodeSpec,
    index: &Index,
    id: &str,
) -> Result<&'a mut Vec<NodeSpec>, PatchError> {
    match locate(root, index, id)? {
        NodeSpec::View { children, .. } => Ok(children),
        _ => Err(error(format!("node {id:?} is not a view"))),
    }
}

/// Where in `parent`'s children a node goes: before `before`, else at the end.
fn position(
    children: &[NodeSpec],
    index: &Index,
    parent: &str,
    before: Option<&str>,
) -> Result<usize, PatchError> {
    let Some(before) = before else {
        return Ok(children.len());
    };
    let under = index
        .get(before)
        .is_some_and(|entry| entry.parent.as_deref() == Some(parent));
    children
        .iter()
        .position(|child| child.key() == Some(before))
        .filter(|_| under)
        .ok_or_else(|| error(format!("{before:?} is not a child of {parent:?}")))
}

/// What one patch's ops changed so far.
struct Changes {
    generation: u64,
    /// Nodes whose own props or children changed, for `propagate`.
    changed: Vec<String>,
    applied: Applied,
}

/// How far up from a node whose children change a scroll view may make a
/// list of them (`list.rs` looks through up to four wrappers).
const LIST_DEPTH: usize = 5;

/// Whether `id` or one of its nearest ancestors scrolls: its children may
/// make (or stop making) a virtualized list.
fn near_scroll(root: &NodeSpec, index: &Index, id: &str) -> Result<bool, PatchError> {
    let path = path(index, id)?;
    let mut node = root;
    let mut found = Vec::with_capacity(path.len() + 1);
    found.push(scrolls(node));
    for key in &path {
        let NodeSpec::View { children, .. } = node else {
            break;
        };
        let Some(child) = children
            .iter()
            .find(|child| child.key() == Some(key.as_str()))
        else {
            break;
        };
        node = child;
        found.push(scrolls(node));
    }
    Ok(found
        .iter()
        .rev()
        .take(LIST_DEPTH + 1)
        .any(|&scroll| scroll))
}

fn scrolls(node: &NodeSpec) -> bool {
    matches!(node, NodeSpec::View { props, .. } if props.scroll)
}

fn apply_op(
    root: &mut NodeSpec,
    index: &mut Index,
    op: PatchOp,
    changes: &mut Changes,
) -> Result<(), PatchError> {
    let generation = changes.generation;
    let changed = &mut changes.changed;
    match op {
        PatchOp::Insert {
            parent,
            before,
            node,
        } => {
            if near_scroll(root, index, &parent)? {
                changes.applied.touched |= Touched::LISTS;
            }
            changes.applied.touched |= Touched::of_subtree(&node);
            let children = children_of(root, index, &parent)?;
            let at = position(children, index, &parent, before.as_deref())?;
            add_subtree(index, &node, Some(&parent), generation)?;
            children.insert(at, *node);
            touch(index, &parent, generation);
            changed.push(parent);
        }
        PatchOp::Remove { id } => {
            let parent = index
                .get(&id)
                .ok_or_else(|| error(format!("no node {id:?}")))?
                .parent
                .clone()
                .ok_or_else(|| error(format!("{id:?} has no parent to leave")))?;
            if near_scroll(root, index, &parent)? {
                changes.applied.touched |= Touched::LISTS;
            }
            let children = children_of(root, index, &parent)?;
            let at = position(children, index, &parent, Some(&id))?;
            let removed = children.remove(at);
            changes.applied.touched |= Touched::of_subtree(&removed);
            remove_entries(index, &removed);
            touch(index, &parent, generation);
            changed.push(parent);
        }
        PatchOp::Move { id, parent, before } => {
            let from = index
                .get(&id)
                .ok_or_else(|| error(format!("no node {id:?}")))?
                .parent
                .clone()
                .ok_or_else(|| error(format!("{id:?} has no parent to leave")))?;
            if before.as_deref() == Some(id.as_str()) || path(index, &parent)?.contains(&id) {
                return Err(error(format!("{id:?} can't go inside or before itself")));
            }
            // Checked before anything changes: `before` is under the new parent.
            if let Some(before) = before.as_deref() {
                let under = index
                    .get(before)
                    .is_some_and(|entry| entry.parent.as_deref() == Some(parent.as_str()));
                if !under {
                    return Err(error(format!("{before:?} is not a child of {parent:?}")));
                }
            }
            if near_scroll(root, index, &from)? || near_scroll(root, index, &parent)? {
                changes.applied.touched |= Touched::LISTS;
            }
            let children = children_of(root, index, &from)?;
            let at = position(children, index, &from, Some(&id))?;
            let node = children.remove(at);
            changes.applied.touched |= Touched::of_subtree(&node);
            let children = children_of(root, index, &parent)?;
            let to = position(children, index, &parent, before.as_deref())?;
            children.insert(to, node);
            if let Some(entry) = index.get_mut(&id) {
                entry.parent = Some(parent.clone());
            }
            touch(index, &from, generation);
            touch(index, &parent, generation);
            changed.push(from);
            changed.push(parent);
        }
        PatchOp::Set { id, node } => {
            if node.key() != Some(id.as_str()) {
                return Err(error(format!("set {id:?}: the node must keep its id")));
            }
            if matches!(&*node, NodeSpec::View { children, .. } if !children.is_empty()) {
                return Err(error(format!("set {id:?}: a view's children are not set")));
            }
            let target = locate(root, index, &id)?;
            if std::mem::discriminant(target) != std::mem::discriminant(&*node) {
                return Err(error(format!("set {id:?}: the node must keep its type")));
            }
            // A field that stays where it was keeps its place in the Tab order.
            if matches!(&*node, NodeSpec::Input { .. }) {
                changes.applied.fields.push(id.clone());
            } else {
                changes.applied.touched |= Touched::of_node(target) | Touched::of_node(&node);
            }
            match (target, *node) {
                (NodeSpec::View { props, .. }, NodeSpec::View { props: new, .. }) => *props = new,
                (target, new) => *target = new,
            }
            touch(index, &id, generation);
            changed.push(id);
        }
    }
    Ok(())
}

/// The node's own props or children changed in `generation`.
fn touch(index: &mut Index, id: &str, generation: u64) {
    if let Some(entry) = index.get_mut(id) {
        entry.own = generation;
    }
}

/// Mark `id` and its ancestors as having changed below in `generation`,
/// stopping at the first ancestor already marked (its own are too).
fn propagate(index: &mut Index, id: String, generation: u64) {
    let mut current = Some(id);
    while let Some(id) = current {
        let Some(entry) = index.get_mut(&id) else {
            return;
        };
        if entry.subtree == generation {
            return;
        }
        entry.subtree = generation;
        current = entry.parent.clone();
    }
}
