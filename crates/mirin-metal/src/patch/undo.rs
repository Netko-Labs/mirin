//! Taking back the ops of a patch that failed part way, so the tree is never
//! half a commit.

use super::index::at_slot;
use crate::tree::NodeSpec;

/// How to take back one applied op, by where it changed the tree (each
/// slot is right in the tree as it was just after the op, so the steps
/// undo in reverse order).
pub(super) enum Undo {
    /// Take the child at `at` out of the view at `parent` (an insert).
    Take { parent: Vec<usize>, at: usize },
    /// Put `node` back at `at` in the view at `parent` (a remove).
    Put {
        parent: Vec<usize>,
        at: usize,
        node: NodeSpec,
    },
    /// Move the child at `to` in `into` back to `at` in `from` (a move).
    Move {
        from: Vec<usize>,
        at: usize,
        into: Vec<usize>,
        to: usize,
    },
    /// Give the node at `node` its old props back (a set; a view's
    /// children are not in `old`).
    Set { node: Vec<usize>, old: NodeSpec },
}

impl Undo {
    pub(super) fn revert(self, root: &mut NodeSpec) {
        match self {
            Undo::Take { parent, at } => {
                take(root, &parent, at);
            }
            Undo::Put { parent, at, node } => put(root, &parent, at, node),
            Undo::Move { from, at, into, to } => {
                if let Some(node) = take(root, &into, to) {
                    put(root, &from, at, node);
                }
            }
            Undo::Set { node, old } => match (at_slot(root, &node), old) {
                (Some(NodeSpec::View { props, .. }), NodeSpec::View { props: old, .. }) => {
                    *props = old;
                }
                (Some(target), old) => *target = old,
                (None, _) => {}
            },
        }
    }
}

fn take(root: &mut NodeSpec, parent: &[usize], at: usize) -> Option<NodeSpec> {
    match at_slot(root, parent)? {
        NodeSpec::View { children, .. } if at < children.len() => Some(children.remove(at)),
        _ => None,
    }
}

fn put(root: &mut NodeSpec, parent: &[usize], at: usize, node: NodeSpec) {
    if let Some(NodeSpec::View { children, .. }) = at_slot(root, parent) {
        children.insert(at.min(children.len()), node);
    }
}
