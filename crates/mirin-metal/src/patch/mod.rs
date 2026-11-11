//! Tree patches: after its first whole tree, a patching driver sends only
//! what changed (a node inserted, moved, removed, or given new props or
//! text), addressed by the ids it gives every node, and the host changes its
//! retained tree in place (`Document`). Parse and apply cost what the change
//! does, not what the tree does. The document also tells the renderer which
//! nodes and subtrees changed in which update (`Document::subtree_generation`).
//!
//! The host announces the protocol on stdout when it starts (`protocol`
//! event, `patches: PATCH_PROTOCOL`), so a driver never patches a host that
//! can't apply them; a patch the host can't apply makes it ask for the whole
//! tree again (`resync`) and drop patches until that tree arrives. The wire
//! format is described in docs/metal.md ("Patches").

mod document;
mod ops;
#[cfg(test)]
mod tests;
mod touched;

pub(crate) use document::{Applied, Document, PatchError};
pub use ops::{parse_patch, PatchOp};
pub(crate) use touched::Touched;

/// The patch protocol's version, announced as `{"type":"protocol",
/// "nodeId":"root","patches":1}`. A driver patches only a host announcing a
/// version it speaks.
pub const PATCH_PROTOCOL: u32 = 1;

/// Named by a host binary that applies patches (for a driver checking the
/// binary rather than waiting for the announcement).
pub const PATCH_MARKER: &str = "MIRIN_METAL_PATCHES";
