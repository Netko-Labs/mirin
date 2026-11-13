//! One patch op applied to the tree and its index, with what it changed and
//! how to take it back.

use super::document::Applied;
use super::error::{error, PatchError};
use super::index::{
    add_subtree, at_slot, children_of, path, position, remove_entries, slot, touch, Index,
};
use super::undo::Undo;
use super::{PatchOp, Touched};
use crate::tree::NodeSpec;

/// What one patch's ops changed so far.
pub(super) struct Changes {
    pub(super) generation: u64,
    /// Nodes whose own props or children changed, for `propagate`.
    pub(super) changed: Vec<String>,
    pub(super) applied: Applied,
    /// How to take back each op applied, should a later one fail.
    pub(super) undo: Vec<Undo>,
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

pub(super) fn apply_op(
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
            let parent_slot = slot(root, index, &parent)?;
            let children = children_of(root, index, &parent)?;
            let at = position(children, index, &parent, before.as_deref())?;
            add_subtree(index, &node, Some(&parent), generation)?;
            children.insert(at, *node);
            changes.undo.push(Undo::Take {
                parent: parent_slot,
                at,
            });
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
            let parent_slot = slot(root, index, &parent)?;
            let children = children_of(root, index, &parent)?;
            let at = position(children, index, &parent, Some(&id))?;
            let removed = children.remove(at);
            changes.applied.touched |= Touched::of_subtree(&removed);
            remove_entries(index, &removed);
            changes.undo.push(Undo::Put {
                parent: parent_slot,
                at,
                node: removed,
            });
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
            // Checked before anything changes: the new parent is a view.
            children_of(root, index, &parent)?;
            let from_slot = slot(root, index, &from)?;
            let children = children_of(root, index, &from)?;
            let at = position(children, index, &from, Some(&id))?;
            let node = children.remove(at);
            changes.applied.touched |= Touched::of_subtree(&node);
            let into = slot(root, index, &parent)?;
            let children = children_of(root, index, &parent)?;
            let to = position(children, index, &parent, before.as_deref())?;
            children.insert(to, node);
            changes.undo.push(Undo::Move {
                from: from_slot,
                at,
                into,
                to,
            });
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
            let target_slot = slot(root, index, &id)?;
            let target = at_slot(root, &target_slot)
                .ok_or_else(|| error(format!("node {id:?} is not where the index has it")))?;
            if std::mem::discriminant(target) != std::mem::discriminant(&*node) {
                return Err(error(format!("set {id:?}: the node must keep its type")));
            }
            // A field that stays where it was keeps its place in the Tab order.
            if matches!(&*node, NodeSpec::Input { .. }) {
                changes.applied.fields.push(id.clone());
            } else {
                changes.applied.touched |= Touched::of_node(target) | Touched::of_node(&node);
            }
            let old = match (target, *node) {
                (NodeSpec::View { props, .. }, NodeSpec::View { props: new, .. }) => {
                    NodeSpec::View {
                        props: std::mem::replace(props, new),
                        children: Vec::new(),
                    }
                }
                (target, new) => std::mem::replace(target, new),
            };
            changes.undo.push(Undo::Set {
                node: target_slot,
                old,
            });
            touch(index, &id, generation);
            changed.push(id);
        }
    }
    Ok(())
}
