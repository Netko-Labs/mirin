//! mirin: what a retained subtree drawn anew records about its drawing, so
//! a later frame can tell whether that drawing, copied a whole number of
//! device pixels away, is what drawing it there would give
//! (`docs/metal/gpui-next.md`, "Retained subtrees on upstream GPUI").
//!
//! - How far it reaches ([`Recorded::extent`]): every content mask pushed
//!   inside it as given, and of every primitive, hitbox and glyph a line
//!   decides to cull, what the masks pushed inside let through without the
//!   one around it (`Window::own_mask`), shown or not: for the pointer and
//!   for leaving it out.
//! - What the mask around it hid and the drawing left out
//!   ([`Recorded::left_out`]: past [`KEEP_MARGIN`], where what it hides is
//!   kept unshown): a copy is whole where that stays hidden. Each primitive,
//!   border strip, layer and hitbox of a copy is clipped by the mask it was
//!   drawn under as that clips where it is copied (the mask map, `masks`),
//!   whether the one around it clipped it before or not.
//! - What it rounds ([`Steadiness`]): the edges `layout_bounds` rounds and
//!   the positions `Window::paint_*` round, through the layout engine's and
//!   the window's accumulators while it records.
//! - What knows where it is (`pinned`): a deferred draw, an input handler,
//!   a window control area, a path (its vertices are not moved), a rotated
//!   sprite, or a `div` whose drag, drop, tooltip or group style keeps a
//!   hitbox's bounds; tooltips are found from its ranges.
//!
//! A subtree drawn anew inside another records its own; the one around it
//! takes it in when it is painted (`absorb_retained`), as it takes in a
//! subtree inside that was copied.

use crate::{
    Bounds, ContentMask, Pixels, ScaledPixels, Window, point, px, scene::SceneReach, size,
};

use super::steady::Steadiness;

/// What a retained subtree's drawing was found to be when it was drawn.
#[derive(Clone, Copy, Debug, Default)]
#[doc(hidden)]
pub struct Recorded {
    /// Everything it draws or pushes, shown or not; `None`: nothing.
    pub(crate) extent: Option<Bounds<Pixels>>,
    /// What the mask around it hid and the drawing left out (past
    /// [`KEEP_MARGIN`]): it must stay hidden where a copy is moved.
    pub(crate) left_out: Option<Bounds<Pixels>>,
    /// Something in it knows where it is: never moved.
    pub(crate) pinned: bool,
    /// A content mask was pushed inside it: where scaling is not exact,
    /// such a mask copied elsewhere is not what pushing it there gives in
    /// its last bits (its size is summed and taken apart in logical pixels
    /// by whoever pushes it), so it is not moved there.
    pub(crate) masks: bool,
    /// The edges its layout rounds (taffy's space: moved as its root is
    /// laid out elsewhere).
    pub(crate) layout: Steadiness,
    /// The positions its painting rounds (the window's space).
    pub(crate) paint: Steadiness,
}

/// How far past the mask around a retained subtree drawn anew what it hides
/// is kept in its drawing (unshown), so a copy moved that far into view is
/// whole.
pub(crate) const KEEP_MARGIN: Pixels = px(256.);

fn union(into: &mut Option<Bounds<Pixels>>, bounds: Bounds<Pixels>) {
    *into = Some(match *into {
        Some(extent) => extent.union(&bounds),
        None => bounds,
    });
}

impl Recorded {
    fn reach(&mut self, bounds: Bounds<Pixels>) {
        union(&mut self.extent, bounds);
    }

    /// Take in a retained subtree inside this one.
    pub(crate) fn absorb(&mut self, inner: &Recorded) {
        if let Some(extent) = inner.extent {
            self.reach(extent);
        }
        if let Some(left_out) = inner.left_out {
            union(&mut self.left_out, left_out);
        }
        self.pinned |= inner.pinned;
        self.masks |= inner.masks;
        self.layout.merge(&inner.layout);
        self.paint.merge(&inner.paint);
    }
}

/// A retained subtree being drawn anew, in the phase being drawn.
pub(crate) struct Recording {
    recorded: Recorded,
    /// The content mask around it.
    outer: ContentMask<Pixels>,
    /// The element offset at its root: one that differs inside it (a
    /// scroll view in it) is snapped on its own.
    offset: crate::Point<Pixels>,
    /// How many content masks were pushed when it began: the ones pushed
    /// after are its own (`Window::own_mask`).
    pub(crate) mask_depth: usize,
    /// The accumulators of the recording around it, put back when it ends.
    saved_layout: Option<Steadiness>,
    saved_paint: Option<Steadiness>,
    saved_scene: Option<SceneReach>,
}

impl Window {
    /// Start (prepaint) or carry on (paint, with what prepaint recorded)
    /// recording the retained subtree about to be drawn anew.
    pub(crate) fn begin_recording(&mut self, carried: Option<Recorded>) {
        let saved_layout = self
            .layout_engine_mut()
            .steadiness
            .replace(Steadiness::default());
        let saved_paint = self
            .retained_paint_steadiness
            .replace(Some(Steadiness::default()));
        let outer = self.content_mask();
        let scale = self.scale_factor();
        let keep = cover(
            &ContentMask {
                bounds: outer.bounds.dilate(KEEP_MARGIN),
            },
            scale,
        );
        let saved_scene = self
            .next_frame
            .scene
            .reach
            .replace(SceneReach::new(cover(&outer, scale), keep.bounds));
        self.retained_recordings.push(Recording {
            recorded: carried.unwrap_or_default(),
            outer,
            // Read in either phase (`element_offset` asserts prepaint).
            offset: self
                .element_offset_stack
                .last()
                .copied()
                .unwrap_or_default(),
            mask_depth: self.mask_ids.len(),
            saved_layout,
            saved_paint,
            saved_scene,
        });
    }

    /// End the recording begun last; its findings so far.
    pub(crate) fn end_recording(&mut self) -> Recorded {
        let recording = self
            .retained_recordings
            .pop()
            .expect("a recording ends where it began");
        let mut recorded = recording.recorded;
        let scale = self.scale_factor();
        let engine = self.layout_engine_mut();
        let layout = std::mem::replace(&mut engine.steadiness, recording.saved_layout);
        if let Some(layout) = layout {
            recorded.layout.merge(&layout);
        }
        if let Some(paint) = self
            .retained_paint_steadiness
            .replace(recording.saved_paint)
        {
            recorded.paint.merge(&paint);
        }
        let scene = std::mem::replace(&mut self.next_frame.scene.reach, recording.saved_scene);
        if let Some(scene) = scene {
            recorded.pinned |= scene.pinned;
            if let Some(extent) = scene.extent {
                recorded.reach(logical(extent, scale));
            }
            if let Some(left_out) = scene.left_out {
                union(&mut recorded.left_out, logical(left_out, scale));
            }
        }
        recorded
    }

    /// Take a retained subtree inside the one being recorded (if one is)
    /// into its recording.
    pub(crate) fn absorb_retained(&mut self, inner: &Recorded) {
        if let Some(recording) = self.retained_recordings.last_mut() {
            recording.recorded.absorb(inner);
        }
    }

    /// Something in the retained subtree being drawn anew knows where it is
    /// in the window: its drawing is never moved.
    pub(crate) fn pin_recordings(&mut self) {
        if let Some(recording) = self.retained_recordings.last_mut() {
            recording.recorded.pinned = true;
        }
    }

    /// Whether a glyph whose largest box is `bounds` is painted: where it
    /// shows, or, while a retained subtree is drawn anew, where the mask
    /// around it hides it within [`KEEP_MARGIN`] (the scene keeps it
    /// unshown). Past that it is left out of the drawing.
    pub(crate) fn retained_glyph_shows(&mut self, bounds: Bounds<Pixels>) -> bool {
        let mask = self.content_mask();
        let shows = bounds.intersects(&mask.bounds);
        let own = self.own_mask();
        let Some(recording) = self.retained_recordings.last_mut() else {
            return shows;
        };
        // What the masks pushed inside let through: hidden by those, it
        // stays hidden wherever the subtree is copied.
        let reach = own.map_or(bounds, |own| bounds.intersect(&own));
        recording.reach_under(bounds, own);
        if shows || reach.is_empty() {
            return shows;
        }
        if reach.intersects(&recording.outer.bounds.dilate(KEEP_MARGIN)) {
            return true;
        }
        union(&mut recording.recorded.left_out, reach);
        false
    }

    /// A hitbox or a content mask (as given) is put down at `bounds`: it
    /// reaches that far, and a copy moves it as it is, so it moves exactly
    /// only where it is exact.
    pub(crate) fn retained_place(&mut self, bounds: Bounds<Pixels>, is_mask: bool) {
        let scale = self.scale_factor();
        let own = self.own_mask();
        let Some(recording) = self.retained_recordings.last_mut() else {
            return;
        };
        if is_mask {
            recording.recorded.reach(bounds);
            recording.recorded.masks = true;
        } else {
            recording.reach_under(bounds, own);
        }
        let paint = &mut recording.recorded.paint;
        let values = [
            (0, bounds.origin.x.0 * scale),
            (1, bounds.origin.y.0 * scale),
            (0, bounds.size.width.0 * scale),
            (1, bounds.size.height.0 * scale),
        ];
        for (axis, value) in values {
            if super::grid::is_exact_scale(scale) {
                paint.exact(axis, value);
            } else {
                paint.on_grid(axis, value);
            }
        }
    }

    /// An element inside the retained subtree being drawn anew is laid out
    /// (`layout_bounds`) under an element offset other than its root's: a
    /// scroll view in it, snapped on its own. Not moved.
    pub(crate) fn retained_offset_check(&mut self) {
        let offset = self.element_offset();
        if let Some(recording) = self.retained_recordings.last_mut()
            && recording.offset != offset
        {
            recording.recorded.paint.fixed = [true; 2];
        }
    }

    /// A position is rounded to the device pixel nearest (halves toward
    /// zero) while painting; `axis` 0 is across. For `&self` painting.
    pub(crate) fn retained_round_half(&self, axis: usize, device: f32, units: f32) {
        if let Some(mut steady) = self.retained_paint_steadiness.get() {
            // Exactly on a half by exact arithmetic only where scaling is.
            let exact = super::grid::is_exact_scale(self.scale_factor());
            steady.round_half(axis, device, units, exact);
            self.retained_paint_steadiness.set(Some(steady));
        }
    }

    /// A position is floored or ceiled to a device pixel while painting
    /// (settled first where scaling is not exact: `Window::cover_bounds`).
    pub(crate) fn retained_floor(&self, axis: usize, device: f32) {
        if let Some(mut steady) = self.retained_paint_steadiness.get() {
            if super::grid::is_exact_scale(self.scale_factor()) {
                steady.floor(axis, device, true);
            } else {
                steady.settled_floor(axis, device);
            }
            self.retained_paint_steadiness.set(Some(steady));
        }
    }
}

impl Recording {
    /// `bounds` is drawn under the masks pushed inside the subtree that let
    /// through `own` (`Window::own_mask`; `None` under the one around it):
    /// that much of it reaches (those masks move with it).
    fn reach_under(&mut self, bounds: Bounds<Pixels>, own: Option<Bounds<Pixels>>) {
        let reach = own.map_or(bounds, |own| bounds.intersect(&own));
        if !reach.is_empty() {
            self.recorded.reach(reach);
        }
    }
}

/// The device pixels a logical mask covers, as `Window::cover_bounds` gives
/// a primitive's.
pub(crate) fn cover(mask: &ContentMask<Pixels>, scale: f32) -> ContentMask<ScaledPixels> {
    ContentMask {
        bounds: crate::window::cover_device(mask.bounds, scale),
    }
}

/// Device bounds in logical pixels.
fn logical(bounds: Bounds<ScaledPixels>, scale: f32) -> Bounds<Pixels> {
    Bounds {
        origin: point(px(bounds.origin.x.0 / scale), px(bounds.origin.y.0 / scale)),
        size: size(
            px(bounds.size.width.0 / scale),
            px(bounds.size.height.0 / scale),
        ),
    }
}
