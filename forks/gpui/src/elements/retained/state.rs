//! mirin: what a retained subtree keeps from frame to frame, and how it
//! is to be drawn in a frame that finds it clean (`RetainedState::plan`).
//! The drawing itself is in `draw`.

use std::{cell::RefCell, ops::Range, rc::Rc};

use crate::{
    AnyElement, Bounds, EntityId, LayoutId, PaintIndex, Pixels, Point, PrepaintStateIndex,
    TextStyle, Window, window::ElementStateScope,
};

use super::{
    RetainedDraw, RetainedRecord, States, grid::Grid, parked::Parked, recording::Recording,
    region::Region,
};

/// What a subtree is laid out and drawn under, apart from where: a change
/// builds it again.
#[derive(PartialEq)]
pub(super) struct Statics {
    text_style: TextStyle,
    scale_factor: f32,
    rem_size: Pixels,
}

impl Statics {
    pub(super) fn of(window: &Window) -> Self {
        Self {
            text_style: window.text_style(),
            scale_factor: window.scale_factor(),
            rem_size: window.rem_size(),
        }
    }
}

/// Where a subtree's drawing sits in last frame's lists.
#[derive(Clone, Default)]
pub(crate) struct Ranges {
    pub(super) prepaint: Range<PrepaintStateIndex>,
    pub(super) paint: Range<PaintIndex>,
}

/// A retained subtree's last drawing: where it is, and what a later frame
/// needs to know to copy it, move it, or leave it out.
pub(crate) struct Drawn {
    /// Its place in last frame's lists; `None` when it is not there (not
    /// drawn yet, left out, or dropped with a subtree around it).
    pub(crate) ranges: Option<Ranges>,
    /// Left out, its last drawing: kept until it shows again, or until
    /// what a window keeps so is too much (`parked`).
    pub(crate) parked: Option<Box<Parked>>,
    /// Where it was drawn (or would have been, left out).
    pub(super) bounds: Bounds<Pixels>,
    /// The content mask around it when it was last drawn or copied; `None`
    /// once a subtree around it moved it.
    pub(super) mask: Option<Bounds<Pixels>>,
    /// Where the drawing is whole (`Recording::valid`).
    pub(crate) valid: Region,
    /// Everything it draws, shown or not.
    pub(crate) extent: Option<Bounds<Pixels>>,
    /// It was drawn whole, as it is laid out: the rest is known.
    pub(super) known: bool,
    pub(crate) pinned: bool,
    /// Not moved across, or down (`Recording::fixed`).
    pub(crate) fixed: [bool; 2],
    /// Nothing in it takes keys, actions, focus or text.
    pub(crate) inert: bool,
    pub(crate) prunable: bool,
}

impl Drawn {
    fn new() -> Self {
        Self {
            ranges: None,
            parked: None,
            bounds: Bounds::default(),
            mask: None,
            valid: Region::everywhere(),
            extent: None,
            known: false,
            pinned: false,
            fixed: [false; 2],
            inert: false,
            prunable: false,
        }
    }

    /// The drawing moved as one, with a subtree around it or on its own.
    pub(super) fn shift(&mut self, by: Point<Pixels>) {
        self.bounds.origin += by;
        self.valid = self.valid.moved(by);
        if let Some(extent) = &mut self.extent {
            extent.origin += by;
        }
    }

    /// `shift`, by whole device pixels: where it was drawn stays on the
    /// grid, however often it is moved.
    pub(super) fn shift_device(&mut self, by: Point<f32>, grid: &Grid) {
        let origin = grid.moved_point(self.bounds.origin, by);
        self.shift(grid.logical(by));
        self.bounds.origin = origin;
    }

    /// Whether nothing of it shows under `mask`, `offset` from where it was.
    pub(super) fn unseen(&self, offset: Point<Pixels>, mask: &Bounds<Pixels>) -> bool {
        self.extent
            .is_none_or(|extent| !(extent + offset).intersects(mask))
    }

    /// Whether the drawing copied `by` device pixels away (whole ones, from
    /// the grid to the grid: `Grid::whole_move`), under `mask`, is what
    /// drawing it there would give. Then every position inside lands as it
    /// did: what is laid out is on the grid, a glyph or an icon rounds to
    /// the same pixel a whole number of them away, and what would not is
    /// `fixed` or `pinned`.
    fn moves(&self, by: Point<f32>, grid: &Grid, mask: &Bounds<Pixels>) -> bool {
        !self.pinned
            && (!self.fixed[0] || by.x == 0.)
            && (!self.fixed[1] || by.y == 0.)
            && self.valid.moved(grid.logical(by)).covers(mask)
    }
}

/// How a clean subtree is drawn this frame.
pub(super) enum Plan {
    /// Built this frame.
    Draw(AnyElement),
    /// Built again for its kept layout.
    Redraw,
    /// Last frame's drawing, this many device pixels from where it was
    /// (`None`: as it is). `whole`: what shows of it is what did
    /// (`Scene::replay_moved`).
    Reuse {
        moved: Option<Point<f32>>,
        whole: bool,
    },
    Skip,
}

impl Plan {
    pub(super) fn draw(&self) -> RetainedDraw {
        match self {
            Plan::Draw(_) => RetainedDraw::Built,
            Plan::Redraw => RetainedDraw::Redrawn,
            Plan::Reuse { moved: None, .. } => RetainedDraw::Reused,
            Plan::Reuse { moved: Some(_), .. } => RetainedDraw::Moved,
            Plan::Skip => RetainedDraw::Skipped,
        }
    }
}

pub(super) struct RetainedState {
    pub(super) version: u64,
    /// Its taffy subtree's root, kept across frames.
    pub(super) root: LayoutId,
    /// The taffy nodes it made, in the order it made them (not those of the
    /// retained subtrees inside).
    pub(super) owned: Vec<LayoutId>,
    released: Rc<RefCell<Vec<LayoutId>>>,
    pub(super) statics: Option<Statics>,
    pub(super) record: Rc<RetainedRecord>,
    /// Every retained subtree inside, at any depth.
    pub(super) nested: Vec<Rc<RetainedRecord>>,
    /// Its elements' states as last drawn.
    pub(super) states: States,
    /// While it is drawn anew this frame: its elements' states, and what it
    /// records of its drawing, between phases.
    pub(super) drawing: Option<ElementStateScope>,
    pub(super) recording: Option<Recording>,
    /// The layout its drawing is of (`TaffyLayoutEngine::epoch`), and the
    /// last one before its nodes were made.
    pub(super) epoch: u32,
    pub(super) made: u32,
}

impl Drop for RetainedState {
    fn drop(&mut self) {
        // No longer drawn: its nodes go at the end of the frame.
        self.released.borrow_mut().append(&mut self.owned);
    }
}

impl RetainedState {
    pub(super) fn new(
        view: EntityId,
        version: u64,
        root: LayoutId,
        owned: Vec<LayoutId>,
        window: &mut Window,
    ) -> Self {
        Self {
            version,
            root,
            owned,
            released: window.layout_engine().released(),
            statics: None,
            record: Rc::new(RetainedRecord {
                view,
                drawn: RefCell::new(Drawn::new()),
            }),
            nested: Vec::new(),
            states: States::default(),
            drawing: None,
            recording: None,
            epoch: 0,
            made: window.layout_engine().epoch(),
        }
    }

    /// Whether it must be built again though its content is the same: it
    /// was notified, or a view inside it was while left undrawn (the window
    /// finds the views around one that is drawn, `Window::mark_view_dirty`;
    /// for one left out it only says there is one).
    pub(super) fn is_dirty(&self, view: EntityId, window: &Window) -> bool {
        window.dirty_views.contains(&view)
            || (window.dirty_unseen
                && self
                    .nested
                    .iter()
                    .any(|record| window.dirty_views.contains(&record.view)))
    }

    /// How to draw it at `bounds`, its content and layout nodes unchanged.
    pub(super) fn plan(
        &self,
        bounds: Bounds<Pixels>,
        movable: bool,
        skippable: bool,
        window: &mut Window,
    ) -> Plan {
        let mut drawn = self.record.drawn.borrow_mut();
        // Laid out inside as it was drawn: only then is the drawing, or how
        // far it reaches, still what it would draw.
        let same = drawn.known
            && drawn.bounds.size == bounds.size
            && !window
                .layout_engine()
                .inner_changed_since(self.root, self.epoch);
        if !same {
            return Plan::Redraw;
        }
        let grid = window.grid();
        let mask = window.content_mask().bounds;
        // How far it is from where it was: `by` in device pixels, when
        // that is a whole number of them between two places on the grid.
        let from = |drawn: &Drawn| {
            let offset = bounds.origin - drawn.bounds.origin;
            let by = grid.whole_move(drawn.bounds.origin, bounds.origin);
            let still = offset == Point::default() || by == Some(Point::default());
            (offset, by, still)
        };
        let (mut offset, mut by, mut still) = from(&drawn);
        if skippable && drawn.inert && (movable || still) && drawn.unseen(offset, &mask) {
            return Plan::Skip;
        }
        if drawn.ranges.is_none() {
            if let Some(parked) = drawn.parked.take() {
                // It shows again: its drawing goes back among last frame's,
                // where it was drawn, with the ones inside it.
                let back = parked.origin - drawn.bounds.origin;
                drawn.shift(back);
                drawn.bounds.origin = parked.origin;
                let (ranges, nested) = window.unpark(parked);
                drawn.ranges = Some(ranges);
                for (record, ranges) in self.nested.iter().zip(nested) {
                    record.drawn.borrow_mut().ranges = ranges;
                }
                (offset, by, still) = from(&drawn);
            }
        }
        let copies = drawn.ranges.as_ref().is_some_and(|ranges| {
            window.prepaint_range_valid(&ranges.prepaint) && window.paint_range_valid(&ranges.paint)
        });
        // A subtree inside that shows nothing was drawn: draw this one
        // again, which leaves it out.
        if !copies || drawn.prunable {
            return Plan::Redraw;
        }
        if still && drawn.mask == Some(mask) {
            return Plan::Reuse {
                moved: None,
                whole: true,
            };
        }
        // A hover style is painted from what is under the pointer: where
        // the pointer is over the drawing, or would be once it is moved,
        // what is hovered may change though the pointer did not move.
        let pointer = window.mouse_position();
        let hovers = drawn.extent.is_some_and(|extent| {
            extent.contains(&pointer) || (extent + offset).contains(&pointer)
        });
        let by = by.filter(|by| movable && !hovers && drawn.moves(*by, &grid, &mask));
        if let Some(by) = by {
            // Nothing around it clipped it, or does where it lands.
            let whole = drawn.extent.is_none_or(|extent| {
                drawn
                    .mask
                    .is_some_and(|before| Region::holds(&before, &extent))
                    && Region::holds(&mask, &(extent + offset))
            });
            // Clipped, with subtrees inside: drawn again, each of them is
            // moved on its own, most of them whole (far cheaper to copy),
            // and the ones that left the view not at all.
            if whole || self.nested.is_empty() {
                return Plan::Reuse {
                    moved: Some(by),
                    whole,
                };
            }
        }
        Plan::Redraw
    }
}
