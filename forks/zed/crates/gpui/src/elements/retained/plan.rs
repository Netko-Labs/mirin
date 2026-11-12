//! mirin: what a retained subtree keeps of its last drawing ([`Drawn`]),
//! and how a frame that finds it clean draws it ([`plan`]): copied where it
//! was, copied moved by whole device pixels, or drawn again.

use std::ops::Range;

use crate::{
    Bounds, ContentMask, LayoutId, PaintIndex, Pixels, Point, PrepaintStateIndex, Window, point,
    px, util::round_to_device_pixel,
};

use super::recording::Recorded;

/// A retained subtree's last drawing: where it is in last frame's lists,
/// where it was drawn, and what its recording found. Shared with the
/// subtrees around it, which move it along when they copy their own.
#[derive(Default)]
pub(crate) struct Drawn {
    pub(super) prepaint: Option<Range<PrepaintStateIndex>>,
    pub(super) paint: Option<Range<PaintIndex>>,
    pub(super) bounds: Bounds<Pixels>,
    pub(super) mask: Option<ContentMask<Pixels>>,
    /// Where it was laid out and drawn from ([`Place`]).
    pub(super) place: Option<Place>,
    /// What drawing it found; `None` until it is drawn whole.
    pub(super) recorded: Option<Recorded>,
    /// Nothing in it takes keys, actions, focus or tab stops.
    pub(super) inert: bool,
    /// The layout its drawing was made for (`TaffyLayoutEngine::epoch`).
    pub(super) epoch: u64,
    /// Left out, its last drawing, kept until it shows again or what a
    /// window keeps so is too much (`parked`).
    pub(crate) parked: Option<Box<super::parked::Parked>>,
    /// Where the pointer was for its hover styles and listeners: when it
    /// was drawn, or copied where they were what they had been.
    pub(super) pointer: Point<Pixels>,
}

/// Where a retained subtree's root is laid out (its unrounded origin in
/// taffy's space, which the edges inside round from) and the element offset
/// it is drawn under (snapped to the device pixel, as `layout_bounds` adds
/// it), in device pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Place {
    pub(super) layout: Point<f32>,
    pub(super) offset: Point<f32>,
    /// Its root's unrounded size, border and padding: what lays out what
    /// is inside (a clean subtree whose root's box is the same is laid out
    /// inside as it was).
    pub(super) node: [f32; 10],
}

impl Place {
    /// Where `root` is this frame (`None` before `layout_bounds` found it).
    pub(super) fn of(root: LayoutId, window: &mut Window) -> Option<Self> {
        let scale = window.scale_factor();
        let offset = window.element_offset();
        let engine = window.layout_engine_mut();
        let layout = engine.unrounded_origin(root)?;
        let node = engine.node_box(root)?;
        Some(Self {
            layout,
            node,
            offset: point(
                round_to_device_pixel(offset.x.0, scale),
                round_to_device_pixel(offset.y.0, scale),
            ),
        })
    }
}

/// How a clean subtree is drawn this frame.
pub(super) enum Plan {
    /// Nothing of it shows: not drawn.
    Skip,
    /// Last frame's drawing, where it was.
    Reuse,
    /// Last frame's drawing, `by` device pixels on (`by_layout` of them
    /// laid out elsewhere, the rest scrolled).
    Move {
        by: Point<f32>,
        by_layout: Point<f32>,
    },
    /// Built again and drawn.
    Redraw,
}

impl Drawn {
    /// Left out at `bounds`, laid out at `place`: where it would be drawn,
    /// and how far it would reach, which the subtrees around it record. Its
    /// drawing is no longer in the frame, nor those of the ones inside.
    pub(super) fn skip(&mut self, bounds: Bounds<Pixels>, place: Option<Place>) {
        let offset = bounds.origin - self.bounds.origin;
        let reach = self
            .recorded
            .and_then(|recorded| self.reach(recorded.extent, bounds.size));
        if let Some(recorded) = &mut self.recorded {
            recorded.extent = reach.map(|extent| extent + offset);
        }
        self.bounds = bounds;
        self.place = place;
        self.prepaint = None;
        self.paint = None;
    }

    /// How far its drawing reaches (`extent`, where it was drawn) once its
    /// root is `size`, everything below laid out as it was: what the root
    /// draws of itself (its background, border, shadow) is as far from its
    /// edges as before, so it reaches that much further right and down when
    /// it grew, and no further when it shrank.
    pub(super) fn reach(
        &self,
        extent: Option<Bounds<Pixels>>,
        size: crate::Size<Pixels>,
    ) -> Option<Bounds<Pixels>> {
        let grown = size - self.bounds.size;
        extent.map(|extent| Bounds {
            origin: extent.origin,
            size: extent.size + grown.max(&crate::Size::default()),
        })
    }

    /// The drawing moved as one, `by` device pixels (`by_layout` of them in
    /// its layout), with a subtree around it that was under the mask
    /// `masks.0` and is now under `masks.1`.
    pub(super) fn shift(
        &mut self,
        by: Point<f32>,
        by_layout: Point<f32>,
        scale: f32,
        masks: (&ContentMask<Pixels>, &ContentMask<Pixels>),
    ) {
        let offset = point(px(by.x / scale), px(by.y / scale));
        // On the device grid, as laying it out there does (`Grid`).
        let grid = super::grid::Grid::new(scale);
        self.bounds.origin = grid.moved_point(self.bounds.origin, by);
        if let Some(place) = &mut self.place {
            place.layout = place.layout + by_layout;
            place.offset = place.offset + (by - by_layout);
        }
        if let Some(mask) = &mut self.mask {
            *mask = if mask == masks.0 {
                masks.1.clone()
            } else {
                ContentMask {
                    bounds: grid.moved_bounds(mask.bounds, by),
                }
            };
        }
        if let Some(recorded) = &mut self.recorded {
            for bounds in [&mut recorded.extent, &mut recorded.left_out]
                .into_iter()
                .flatten()
            {
                bounds.origin += offset;
            }
            recorded.layout.moved(by_layout);
            recorded.paint.moved(by);
        }
    }
}

/// What a retained subtree may be drawn as, besides drawn anew.
#[derive(Clone, Copy)]
pub(super) struct Allowed {
    pub(super) movable: bool,
    /// Left out while nothing of it shows, and nothing inside was notified.
    pub(super) skippable: bool,
    /// Nothing below its root was laid out anew since its drawing was made
    /// (its root may have been resized).
    pub(super) below_same: bool,
}

/// How to draw a clean subtree at `bounds`, under `mask`, laid out at
/// `place`, from what it drew last (`drawn`).
pub(super) fn plan(
    drawn: &Drawn,
    bounds: Bounds<Pixels>,
    mask: &ContentMask<Pixels>,
    place: Option<Place>,
    allowed: Allowed,
    window: &Window,
) -> Plan {
    let movable = allowed.movable;
    // Laid out inside as it was drawn, or only its root resized: what it
    // reaches is known (`Drawn::reach`).
    let same_inside =
        matches!((drawn.place, place), (Some(before), Some(now)) if before.node == now.node);
    let offset = bounds.origin - drawn.bounds.origin;
    // One whose layout is watched is left out only where it was.
    let still = movable || offset == Point::default();
    if allowed.skippable && drawn.inert && still && (same_inside || allowed.below_same) {
        let unseen = drawn.recorded.is_some_and(|recorded| {
            drawn
                .reach(recorded.extent, bounds.size)
                .is_none_or(|extent| !(extent + offset).intersects(&mask.bounds))
        });
        if unseen {
            return Plan::Skip;
        }
    }
    let copies = drawn.prepaint.as_ref().is_some_and(|range| {
        window.prepaint_range_valid(range)
            && drawn
                .paint
                .as_ref()
                .is_some_and(|range| window.paint_range_valid(range))
    });
    if !copies {
        return Plan::Redraw;
    }
    // Where it was, laid out as it was: edges inside round as they did.
    let laid_out_same = match (drawn.place, place) {
        (Some(before), Some(now)) => before.layout == now.layout && before.node == now.node,
        (None, None) => true,
        _ => false,
    };
    // A hover style or listener is decided at paint from what the pointer
    // is over: a drawing it was over, or is over now, is copied only while
    // it has not moved (it may have jumped, as when the window is resized).
    let (before, now) = (drawn.pointer, window.mouse_position());
    let hovers = |extent: Option<Bounds<Pixels>>, pointer: Point<Pixels>| {
        extent.is_some_and(|extent| extent.contains(&pointer))
    };
    let extent = drawn.recorded.and_then(|recorded| recorded.extent);
    let pointer_same = before == now || (!hovers(extent, before) && !hovers(extent, now));
    if drawn.bounds == bounds && drawn.mask.as_ref() == Some(mask) && laid_out_same {
        return if pointer_same {
            Plan::Reuse
        } else {
            Plan::Redraw
        };
    }
    match moved_by(drawn, bounds, mask, place, movable, window) {
        Some((by, by_layout)) => Plan::Move { by, by_layout },
        None => Plan::Redraw,
    }
}

/// How far (device pixels) a drawing moved, when copying it there is what
/// drawing it there gives (`docs/metal/gpui-next.md`, step 2's first cut).
fn moved_by(
    drawn: &Drawn,
    bounds: Bounds<Pixels>,
    mask: &ContentMask<Pixels>,
    place: Option<Place>,
    movable: bool,
    window: &Window,
) -> Option<(Point<f32>, Point<f32>)> {
    let scale = window.scale_factor();
    let grid = super::grid::Grid::new(scale);
    let (Some(recorded), Some(before), Some(now), Some(_)) =
        (&drawn.recorded, drawn.place, place, &drawn.mask)
    else {
        return None;
    };
    if !movable || recorded.pinned || drawn.bounds.size != bounds.size || before.node != now.node {
        return None;
    }
    let by_layout = now.layout - before.layout;
    if by_layout.x.fract() != 0. || by_layout.y.fract() != 0. {
        return None;
    }
    let by = by_layout + (now.offset - before.offset);
    let offset = point(px(by.x / scale), px(by.y / scale));
    // Where scaling is not exact, its root moves on the device grid
    // (`Grid`), as everything in it that moves does.
    let on_grid = grid.is_exact()
        || ((by.x == 0. || grid.is_on(drawn.bounds.origin.x))
            && (by.y == 0. || grid.is_on(drawn.bounds.origin.y)));
    if !on_grid
        || (!grid.is_exact() && recorded.masks)
        || grid.moved_point(drawn.bounds.origin, by) != bounds.origin
        || !recorded.layout.holds(by_layout)
        || !recorded.paint.holds(by)
    {
        return None;
    }
    // What the drawing left out stays hidden.
    let whole = recorded.left_out.is_none_or(|left_out| {
        let [left, top, right, bottom] = cover(&(left_out + offset), scale);
        let [mask_left, mask_top, mask_right, mask_bottom] = cover(&mask.bounds, scale);
        right <= mask_left || mask_right <= left || bottom <= mask_top || mask_bottom <= top
    });
    if !whole {
        return None;
    }
    if let Some(extent) = recorded.extent {
        // A hover style is painted from what is under the pointer: it was
        // over neither where it was, nor is where it is now.
        let (before, now) = (drawn.pointer, window.mouse_position());
        if extent.contains(&before) || (extent + offset).contains(&now) {
            return None;
        }
    }
    Some((by, by_layout))
}

/// The device pixels `bounds` covers (as `Window::cover_bounds`).
fn cover(bounds: &Bounds<Pixels>, scale: f32) -> [f32; 4] {
    let cover = crate::window::cover_device(*bounds, scale);
    [
        cover.left().0,
        cover.top().0,
        cover.right().0,
        cover.bottom().0,
    ]
}
