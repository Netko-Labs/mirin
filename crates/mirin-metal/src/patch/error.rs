//! Why a patch didn't apply.

use std::fmt;

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

pub(super) fn error(message: impl Into<String>) -> PatchError {
    PatchError(message.into())
}
