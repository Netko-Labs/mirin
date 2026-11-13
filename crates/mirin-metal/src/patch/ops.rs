//! The patch wire format: `{"patch":[op, …]}`, ops applied in order.

use serde::Deserialize;

use crate::tree::NodeSpec;

/// One change to the retained tree. Nodes are named by their id
/// (`NodeSpec::key`); `before` names the sibling a node goes in front of,
/// none for the end.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
pub enum PatchOp {
    /// A new subtree under the view `parent`. Every id in it must be new.
    Insert {
        parent: String,
        #[serde(default)]
        before: Option<String>,
        node: Box<NodeSpec>,
    },
    /// A node already in the tree goes under the view `parent` with its
    /// subtree (a keyed reorder; React never moves a node to another
    /// parent, but the host allows it).
    Move {
        id: String,
        parent: String,
        #[serde(default)]
        before: Option<String>,
    },
    /// A node and its subtree leave the tree.
    Remove { id: String },
    /// A node's own props (and a text node's text) change; a view keeps its
    /// children, so `node` has none. Its type and id stay what they were.
    Set { id: String, node: Box<NodeSpec> },
}

/// Parse a `{"patch":[…]}` line strictly: unknown ops and fields are refused.
pub fn parse_patch(line: &str) -> Result<Vec<PatchOp>, serde_json::Error> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct PatchLine {
        patch: Vec<PatchOp>,
    }
    serde_json::from_str::<PatchLine>(line).map(|line| line.patch)
}
