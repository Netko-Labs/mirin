//! Where each node of the retained tree is (by id), how to reach it, and
//! when it last changed.

use std::collections::{HashMap, HashSet};

use super::error::{error, PatchError};
use crate::tree::NodeSpec;

/// Where a node is (its parent's id; none for the root, or under a node with
/// no id) and when it changed.
#[derive(Debug, Clone)]
pub(super) struct Entry {
    pub(super) parent: Option<String>,
    /// The update its own props, text, or list of children last changed in.
    pub(super) own: u64,
    /// The update anything in its subtree (itself included) last changed in.
    pub(super) subtree: u64,
}

pub(super) type Index = HashMap<String, Entry>;

/// Every node with an id, where it is. Ids must be unique, and the root must
/// have one, or nothing can be addressed.
pub(super) fn build_index(root: &NodeSpec, generation: u64) -> Result<Index, PatchError> {
    if root.key().is_none() {
        return Err(error("the root has no id"));
    }
    let mut index = Index::new();
    add_subtree(&mut index, root, None, generation)?;
    Ok(index)
}

/// Index `node` and its subtree under `parent`, as changed in `generation`;
/// an id already indexed is an error (nothing is added then).
pub(super) fn add_subtree(
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

pub(super) fn remove_entries(index: &mut Index, node: &NodeSpec) {
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
pub(super) fn path(index: &Index, id: &str) -> Result<Vec<String>, PatchError> {
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

/// Where the node `id` is: the index of each node on the way down from the
/// root, found along its parents.
pub(super) fn slot(root: &NodeSpec, index: &Index, id: &str) -> Result<Vec<usize>, PatchError> {
    let path = path(index, id)?;
    if path.is_empty() && root.key() != Some(id) {
        return Err(error(format!("node {id:?} is not under the root")));
    }
    let mut slot = Vec::with_capacity(path.len());
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
        slot.push(at);
        node = &children[at];
    }
    Ok(slot)
}

/// The node at `slot`, if the tree still has one there.
pub(super) fn at_slot<'a>(root: &'a mut NodeSpec, slot: &[usize]) -> Option<&'a mut NodeSpec> {
    let mut node = root;
    for &at in slot {
        let NodeSpec::View { children, .. } = node else {
            return None;
        };
        node = children.get_mut(at)?;
    }
    Some(node)
}

/// The node `id`, found from the root along its parents.
fn locate<'a>(
    root: &'a mut NodeSpec,
    index: &Index,
    id: &str,
) -> Result<&'a mut NodeSpec, PatchError> {
    let slot = slot(root, index, id)?;
    at_slot(root, &slot).ok_or_else(|| error(format!("node {id:?} is not where the index has it")))
}

pub(super) fn children_of<'a>(
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
pub(super) fn position(
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

/// The node's own props or children changed in `generation`.
pub(super) fn touch(index: &mut Index, id: &str, generation: u64) {
    if let Some(entry) = index.get_mut(id) {
        entry.own = generation;
    }
}

/// Mark `id` and its ancestors as having changed below in `generation`,
/// stopping at the first ancestor already marked (its own are too).
pub(super) fn propagate(index: &mut Index, id: String, generation: u64) {
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
