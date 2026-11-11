//! mirin: the content masks of a frame as they were pushed, so a retained
//! subtree's drawing copied elsewhere gets the masks it would have there.
//! A primitive or hitbox keeps the mask it was drawn under, already
//! intersected with every mask around it; moved, the masks pushed inside
//! the subtree move along and the ones around it don't.

use std::ops::Range;

use crate::{Bounds, Pixels, Point};

/// A content mask as it was pushed (not yet intersected with the ones
/// around it), and the one around it: its place in the frame's list, from
/// 1; 0 for none.
#[derive(Clone, Copy)]
pub(crate) struct MaskNode {
    pub(crate) bounds: Bounds<Pixels>,
    pub(crate) parent: u32,
}

/// Where the content masks pushed inside a reused drawing landed in this
/// frame's list, and (for a moved drawing) what each now clips to.
pub(crate) struct MaskMap {
    old: Range<usize>,
    new_start: usize,
    /// The mask around the drawing in this frame.
    outer_id: u32,
    outer: Bounds<Pixels>,
    /// Per mask of `old`, moved and intersected with the ones around it.
    clips: Vec<Bounds<Pixels>>,
}

impl MaskMap {
    pub(crate) fn new(
        old: Range<usize>,
        new_start: usize,
        outer_id: u32,
        outer: Bounds<Pixels>,
    ) -> Self {
        Self {
            old,
            new_start,
            outer_id,
            outer,
            clips: Vec::new(),
        }
    }

    /// A mask pushed inside the drawing, by its old place; `None` for one
    /// around the drawing.
    fn inner(&self, id: u32) -> Option<usize> {
        let index = (id as usize).checked_sub(1)?;
        self.old.contains(&index).then(|| index - self.old.start)
    }

    /// The place in this frame's list of the mask at `id` in last frame's.
    pub(crate) fn id(&self, id: u32) -> u32 {
        match self.inner(id) {
            Some(index) => (self.new_start + index + 1) as u32,
            None => self.outer_id,
        }
    }

    /// What the mask at `id` in last frame's list clips to in this frame
    /// (for a moved drawing).
    pub(crate) fn mask(&self, id: u32) -> Bounds<Pixels> {
        self.inner(id)
            .and_then(|index| self.clips.get(index).copied())
            .unwrap_or(self.outer)
    }

    /// The next mask of the old range as it goes into this frame's list.
    pub(crate) fn push(&mut self, node: &MaskNode, moved: Option<Point<Pixels>>) -> MaskNode {
        let mut bounds = node.bounds;
        if let Some(moved) = moved {
            bounds.origin += moved;
            // Masks are listed in the order they were pushed: the one
            // around this one is already in.
            let clip = bounds.intersect(&self.mask(node.parent));
            self.clips.push(clip);
        }
        MaskNode {
            bounds,
            parent: self.id(node.parent),
        }
    }
}
