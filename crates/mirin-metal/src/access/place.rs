//! Where a node is, as the adapter hears it: not in the window but in the
//! frame around it, so what moves as one (a scroll view's content, a
//! retained subtree: the layout's groups) is one node's transform.
//!
//! A node that stands for such a group is a *frame*: it carries how far the
//! group's top left is from that of the frame around it, and everything
//! under it has its bounds from there. AccessKit adds the transforms up
//! when a screen reader asks where a node is, so a scroll changes the
//! content's frame and nothing under it.
//!
//! The frames are the tree's (`walk.rs`), the groups the last paint's
//! (`layout.rs`). Where the two agree a node's place is read off the layout
//! as it stands; where they don't (a frame not painted yet, a row of a
//! virtualized list, a tree newer than the paint) the node is *loose*: placed
//! by where things are in the window, and looked at again whenever anything
//! moved.

use std::collections::HashMap;

use accesskit::{Rect, Vec2};

use crate::layout::LayoutMap;

/// Where a node is in the frame around it.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub(super) struct Placement {
    /// Its bounds: from its own frame's top left when it is a frame, else
    /// from that of the frame around it. None when it is not painted (or
    /// stands for no element).
    pub(super) bounds: Option<Rect>,
    /// A frame's top left, from that of the frame around it.
    pub(super) offset: Option<Vec2>,
    /// Placed by where things are in the window (see the module).
    pub(super) loose: bool,
}

/// The layout, and the frame around each frame of the tree.
pub(super) struct Spaces<'a> {
    pub(super) layout: &'a LayoutMap,
    pub(super) around: &'a HashMap<u64, Option<u64>>,
}

impl Spaces<'_> {
    /// Where frame `space` has its top left in the window: a frame the
    /// layout does not know (it is not painted) is where the one around it is.
    fn origin(&self, mut space: Option<u64>) -> (f64, f64) {
        // Frames nest as the tree does; the bound only guards a stale map.
        for _ in 0..256 {
            let Some(group) = space else {
                break;
            };
            if let Some(origin) = self.layout.origin(group) {
                return origin;
            }
            space = self.around.get(&group).copied().flatten();
        }
        (0.0, 0.0)
    }

    /// Where the node for `element` is in frame `space`, itself the frame
    /// of group `frame` when that is given.
    pub(super) fn place(
        &self,
        element: Option<&str>,
        space: Option<u64>,
        frame: Option<u64>,
    ) -> Placement {
        let mut loose = false;
        let mut around = None;
        let mut origin = || *around.get_or_insert_with(|| self.origin(space));
        let offset = frame
            .and_then(|group| Some((group, self.layout.frame(group)?)))
            .map(|(group, frame)| {
                if frame.parent == space {
                    return frame.offset;
                }
                loose = true;
                let (x, y) = self.layout.origin(group).unwrap_or_default();
                let (left, top) = origin();
                (x - left, y - top)
            });
        let bounds = element
            .and_then(|element| self.layout.placed(element))
            .map(|placed| {
                let [x0, y0, x1, y1] = placed.rect;
                let (x, y) = if placed.group == space {
                    (0.0, 0.0)
                } else {
                    loose = true;
                    let group = placed.group.and_then(|group| self.layout.origin(group));
                    let (x, y) = group.unwrap_or_default();
                    let (left, top) = origin();
                    (x - left, y - top)
                };
                // In its own frame, when it is one.
                let (x, y) = match offset {
                    Some((left, top)) => (x - left, y - top),
                    None => (x, y),
                };
                Rect::new(x0 + x, y0 + y, x1 + x, y1 + y)
            });
        Placement {
            bounds,
            offset: offset.map(|(x, y)| Vec2::new(x, y)),
            loose,
        }
    }
}
