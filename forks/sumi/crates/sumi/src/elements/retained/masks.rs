//! mirin: the content masks of a frame as they were pushed, so a retained
//! subtree's drawing copied elsewhere gets the masks it would have there
//! (`docs/metal/gpui-next.md`, "Round 6"; the fork's
//! `../gpui/src/elements/retained/masks.rs`).
//!
//! A primitive or hitbox carries the mask it was drawn under, already
//! intersected with every mask around it. So a mask pushed inside a retained
//! subtree and clipped by the one around it (a row half out of its scroll
//! view, with a box in it that clips its text) could not be moved: the
//! clipped part was lost. The frame now keeps every mask as given, with the
//! one around it ([`MaskNode`]), and each primitive, border strip, layer and
//! hitbox says which it was drawn under. A copied drawing pushes the masks
//! pushed inside it again, moved, under the mask around it where it is
//! copied ([`MaskMap`]): each one, intersected with the one around it, is
//! what pushing it there gives, so the copy is clipped as drawing it there
//! would clip it, clipped before or not.
//!
//! While a subtree is drawn anew, what the masks pushed inside it let
//! through without the one around it (`Window::own_mask`) is how far it
//! reaches, and what of it that mask hides is kept unshown near it or left
//! out, as for anything else it draws.

use std::ops::Range;

use crate::{
    Bounds, ContentMask, Pixels, Point, ScaledPixels, Window,
    window::{MaskId, MaskNode, cover_device},
};

use super::grid::Grid;

/// Where the masks of a copied drawing land in this frame's list, and (for
/// a drawing moved) what each clips to here.
pub(crate) struct MaskMap {
    /// The drawing's masks in last frame's list (by index, from 0).
    old: Range<usize>,
    /// Where they start in this frame's.
    new_start: usize,
    /// The mask around the drawing in this frame.
    outer: MaskId,
    /// For a drawing moved: per mask of `old`, what it clips to here and
    /// what that covers in device pixels, and the same of the mask around
    /// the drawing.
    clips: Vec<ContentMask<Pixels>>,
    covers: Vec<ContentMask<ScaledPixels>>,
    outer_clip: ContentMask<Pixels>,
    outer_cover: ContentMask<ScaledPixels>,
}

impl MaskMap {
    fn inner(&self, id: MaskId) -> Option<usize> {
        let index = (id as usize).checked_sub(1)?;
        self.old.contains(&index).then(|| index - self.old.start)
    }

    /// The place in this frame's list of the mask at `id` in last frame's:
    /// one pushed inside the drawing, copied, or the one around it here.
    pub(crate) fn id(&self, id: MaskId) -> MaskId {
        match self.inner(id) {
            Some(index) => (self.new_start + index + 1) as MaskId,
            None => self.outer,
        }
    }

    /// For a drawing moved: what the mask at `id` in last frame's list
    /// covers here.
    pub(crate) fn cover(&self, id: MaskId) -> &ContentMask<ScaledPixels> {
        self.inner(id)
            .and_then(|index| self.covers.get(index))
            .unwrap_or(&self.outer_cover)
    }

    /// For a drawing moved: what the mask at `id` in last frame's list clips
    /// to here (a hitbox's content mask).
    pub(crate) fn clip(&self, id: MaskId) -> &ContentMask<Pixels> {
        self.inner(id)
            .and_then(|index| self.clips.get(index))
            .unwrap_or(&self.outer_clip)
    }
}

impl Window {
    /// The mask the frame is drawing under (`MaskNode`).
    pub(crate) fn mask_id(&self) -> MaskId {
        self.mask_ids.last().copied().unwrap_or(0)
    }

    /// A content mask was pushed as `given` (`with_content_mask`).
    pub(crate) fn push_mask_node(&mut self, given: Bounds<Pixels>) {
        let parent = self.mask_id();
        self.next_frame
            .content_masks
            .push(MaskNode { given, parent });
        let id = self.next_frame.content_masks.len() as MaskId;
        // What the masks pushed inside the retained subtree being drawn
        // anew let through, without the one around it.
        let free = self
            .retained_recordings
            .last()
            .map(|recording| match self.mask_free.last() {
                Some(Some(free)) if self.mask_ids.len() > recording.mask_depth => {
                    given.intersect(free)
                }
                _ => given,
            });
        self.mask_ids.push(id);
        self.mask_free.push(free);
        self.next_frame.scene.mask_id = id;
        self.sync_own_mask();
    }

    /// The mask pushed last was popped.
    pub(crate) fn pop_mask_node(&mut self) {
        self.mask_ids.pop();
        self.mask_free.pop();
        self.next_frame.scene.mask_id = self.mask_id();
        self.sync_own_mask();
    }

    /// While a retained subtree is drawn anew: what the masks pushed inside
    /// it let through, without the one around it; `None` under that one.
    pub(crate) fn own_mask(&self) -> Option<Bounds<Pixels>> {
        let recording = self.retained_recordings.last()?;
        if self.mask_ids.len() > recording.mask_depth {
            self.mask_free.last().copied().flatten()
        } else {
            None
        }
    }

    /// Tell the scene's record of the subtree being drawn anew what the
    /// masks pushed inside it let through (`SceneReach`).
    pub(crate) fn sync_own_mask(&mut self) {
        let scale = self.scale_factor();
        let own = self.own_mask().map(|own| cover_device(own, scale));
        if let Some(reach) = &mut self.next_frame.scene.reach {
            reach.own = own;
        }
    }

    /// Push the masks of last frame's `range` again (pushed inside a drawing
    /// being copied), under the mask the frame is drawing under, `by` device
    /// pixels (whole ones) on when it moved.
    pub(crate) fn copy_masks(&mut self, range: Range<usize>, by: Option<Point<f32>>) -> MaskMap {
        let scale = self.scale_factor();
        let outer_mask = self.content_mask();
        let mut map = MaskMap {
            old: range.clone(),
            new_start: self.next_frame.content_masks.len(),
            outer: self.mask_id(),
            clips: Vec::new(),
            covers: Vec::new(),
            outer_cover: ContentMask {
                bounds: cover_device(outer_mask.bounds, scale),
            },
            outer_clip: outer_mask,
        };
        let grid = Grid::new(scale);
        // In the order they were pushed: the one around each is in already.
        for index in range {
            let Some(node) = self.rendered_frame.content_masks.get(index).copied() else {
                break;
            };
            let parent = map.id(node.parent);
            let given = match by {
                Some(by) => grid.moved_bounds(node.given, by),
                None => node.given,
            };
            self.next_frame
                .content_masks
                .push(MaskNode { given, parent });
            if by.is_some() {
                // As `with_content_mask` intersects it there.
                let clip = ContentMask { bounds: given }.intersect(map.clip(node.parent));
                map.covers.push(ContentMask {
                    bounds: cover_device(clip.bounds, scale),
                });
                map.clips.push(clip);
            }
        }
        map
    }
}
