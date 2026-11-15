//! A list of a frame that a partial frame can write into at a range
//! (`docs/metal/engine.md`, section 3; `partial.rs`).
//!
//! A frame's lists (its hitboxes, the masks pushed, the listeners) are
//! filled from their start as the frame is drawn, and a retained subtree
//! keeps the range it filled of each. A partial frame draws such a subtree
//! again into the frame it was last drawn in: what the subtree pushes then
//! goes over what it pushed before, one for one, from its range's start
//! ([`FrameVec::begin_patch`]). A drawing that is kept where it is inside
//! that range is stepped over ([`FrameVec::step_over`]).
//!
//! A patch holds when it filled its range exactly ([`FrameVec::end_patch`]).
//! One that does not leaves the range part old, part new, and never writes
//! outside it: the frame is then drawn in full, which draws that subtree
//! anew and copies from this frame only the ranges of subtrees that did
//! not change, which no patch writes into.

use std::ops::{Deref, DerefMut, Range};

/// A list of a frame; a `Vec`, but for `push` and `end`, which a patch
/// redirects.
pub(crate) struct FrameVec<T> {
    items: Vec<T>,
    patch: Option<Patch>,
}

struct Patch {
    end: usize,
    cursor: usize,
    failed: bool,
}

impl<T> Default for FrameVec<T> {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            patch: None,
        }
    }
}

impl<T> Deref for FrameVec<T> {
    type Target = Vec<T>;

    fn deref(&self) -> &Vec<T> {
        &self.items
    }
}

impl<T> DerefMut for FrameVec<T> {
    fn deref_mut(&mut self) -> &mut Vec<T> {
        &mut self.items
    }
}

impl<'a, T> IntoIterator for &'a FrameVec<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;

    fn into_iter(self) -> Self::IntoIter {
        self.items.iter()
    }
}

impl<'a, T> IntoIterator for &'a mut FrameVec<T> {
    type Item = &'a mut T;
    type IntoIter = std::slice::IterMut<'a, T>;

    fn into_iter(self) -> Self::IntoIter {
        self.items.iter_mut()
    }
}

impl<T> FrameVec<T> {
    /// Add `item`: at the end, or over the next item of the range being
    /// patched.
    #[inline]
    pub(crate) fn push(&mut self, item: T) {
        let Some(patch) = &mut self.patch else {
            self.items.push(item);
            return;
        };
        let at = patch.cursor;
        patch.cursor += 1;
        if patch.failed || at >= patch.end {
            patch.failed = true;
            return;
        }
        self.items[at] = item;
    }

    /// Where the next item pushed goes: what a range kept of this list
    /// starts or ends at.
    #[inline]
    pub(crate) fn end(&self) -> usize {
        match &self.patch {
            Some(patch) => patch.cursor,
            None => self.items.len(),
        }
    }

    /// Whether a patch is being written.
    pub(crate) fn patching(&self) -> bool {
        self.patch.is_some()
    }

    /// The patch can't be what it replaces.
    pub(crate) fn fail_patch(&mut self) {
        if let Some(patch) = &mut self.patch {
            patch.failed = true;
        }
    }

    /// Write over `range` from here on. `false`: it is not a range of this
    /// list.
    pub(crate) fn begin_patch(&mut self, range: Range<usize>) -> bool {
        if self.patch.is_some() || range.start > range.end || range.end > self.items.len() {
            return false;
        }
        self.patch = Some(Patch {
            end: range.end,
            cursor: range.start,
            failed: false,
        });
        true
    }

    /// The items of `range` are kept where they are in the range being
    /// patched: the patch goes on after them.
    pub(crate) fn step_over(&mut self, range: Range<usize>) {
        let Some(patch) = &mut self.patch else {
            return;
        };
        if patch.failed || range.start != patch.cursor || range.end > patch.end {
            patch.failed = true;
            return;
        }
        patch.cursor = range.end;
    }

    /// The patch is over; whether it wrote over exactly its range.
    pub(crate) fn end_patch(&mut self) -> bool {
        self.patch
            .take()
            .is_some_and(|patch| !patch.failed && patch.cursor == patch.end)
    }
}
