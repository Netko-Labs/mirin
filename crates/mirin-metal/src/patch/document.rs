//! The retained tree a window shows, changed in place by patches, and when
//! each node last changed.

use std::rc::Rc;

use super::apply::{apply_op, Changes};
use super::error::PatchError;
use super::index::{build_index, path, propagate, Entry, Index};
use super::{PatchOp, Touched};
use crate::tree::NodeSpec;

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
    /// (Nothing does now: the accessibility tree, which looked under a view
    /// whose own props changed, hears what left from the layout.)
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
    /// state they may concern. A patch applies whole or not at all: on an
    /// error the ops before it are undone, so the tree is the one before the
    /// patch (never half of it), and every node counts as changed.
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
            undo: Vec::new(),
        };
        for op in ops {
            if let Err(error) = apply_op(root, &mut index, op, &mut changes) {
                for step in changes.undo.into_iter().rev() {
                    step.revert(root);
                }
                // The index followed the ops; it is built again when next needed.
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
        self.find_in(&self.tree, id)
    }

    /// `find` in `root`, a share of this tree held apart from the document
    /// (a retained subtree built while the view is borrowed, retain.rs).
    pub(crate) fn find_in<'t>(&self, root: &'t NodeSpec, id: &str) -> Option<&'t NodeSpec> {
        let path = path(self.index.as_ref()?, id).ok()?;
        let mut node: &NodeSpec = root;
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
