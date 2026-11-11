//! mirin: what a retained subtree keeps from frame to frame, and the ways
//! it is drawn: built, built again onto its kept layout, copied (where it
//! was or moved), or left out.

use std::{cell::RefCell, mem, ops::Range, rc::Rc};

use crate::{
    AnyElement, App, Bounds, EntityId, LayoutId, PaintIndex, Pixels, Point, PrepaintStateIndex,
    TextStyle, Window, window::ElementStateScope,
};

use super::{
    Build, RetainedDraw, RetainedRecord, States,
    moved::{moved_paint, moved_prepaint},
    recording::{Recording, Region},
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
    prepaint: Range<PrepaintStateIndex>,
    paint: Range<PaintIndex>,
}

/// A retained subtree's last drawing: where it is, and what a later frame
/// needs to know to copy it, move it, or leave it out.
pub(crate) struct Drawn {
    /// Its place in last frame's lists; `None` when it is not there (not
    /// drawn yet, left out, or dropped with a subtree around it).
    pub(crate) ranges: Option<Ranges>,
    /// Where it was drawn (or would have been, left out).
    bounds: Bounds<Pixels>,
    /// The content mask around it; `None` once a subtree around it moved it.
    mask: Option<Bounds<Pixels>>,
    /// Where the drawing is whole (`Recording::valid`).
    pub(crate) valid: Region,
    /// Everything it draws, shown or not.
    pub(crate) extent: Option<Bounds<Pixels>>,
    /// It was drawn whole, as it is laid out: the rest is known.
    pub(super) known: bool,
    pub(crate) pinned: bool,
    pub(crate) glyphs: bool,
    pub(crate) uneven: bool,
    /// Nothing in it takes keys, actions, focus or text.
    pub(crate) inert: bool,
    pub(crate) prunable: bool,
}

impl Drawn {
    fn new() -> Self {
        Self {
            ranges: None,
            bounds: Bounds::default(),
            mask: None,
            valid: Region::everywhere(),
            extent: None,
            known: false,
            pinned: false,
            glyphs: false,
            uneven: false,
            inert: false,
            prunable: false,
        }
    }

    /// The drawing moved as one, with a subtree around it or on its own.
    fn shift(&mut self, by: Point<Pixels>) {
        self.bounds.origin += by;
        self.valid = self.valid.moved(by);
        if let Some(extent) = &mut self.extent {
            extent.origin += by;
        }
    }

    /// Whether nothing of it shows under `mask`, `offset` from where it was.
    fn unseen(&self, offset: Point<Pixels>, mask: &Bounds<Pixels>) -> bool {
        self.extent
            .is_none_or(|extent| !(extent + offset).intersects(mask))
    }

    /// Whether the drawing copied `offset` away, with its top left at
    /// `origin` under `mask`, is what drawing it there would give.
    fn moves(
        &self,
        offset: Point<Pixels>,
        origin: Point<Pixels>,
        mask: &Bounds<Pixels>,
        scale_factor: f32,
    ) -> bool {
        // Positions are exact only where device pixels are a power of two
        // of logical ones and it sits on whole pixels before and after:
        // then every rounding inside lands as it did.
        let exact = matches!(scale_factor, 1. | 2. | 4.);
        let on_pixels = |point: Point<Pixels>| {
            (point.x.0 * scale_factor).fract() == 0. && (point.y.0 * scale_factor).fract() == 0.
        };
        exact
            && !self.pinned
            && on_pixels(self.bounds.origin)
            && on_pixels(origin)
            && (!self.glyphs || offset.x.0 == 0.)
            && (!self.uneven || offset.y.0 == 0.)
            && self.valid.moved(offset).covers(mask)
    }
}

/// How a clean subtree is drawn this frame.
pub(super) enum Plan {
    /// Built this frame.
    Draw(AnyElement),
    /// Built again for its kept layout.
    Redraw,
    /// Last frame's drawing, this far from where it was (`None`: as it is).
    Reuse(Option<Point<Pixels>>),
    Skip,
}

impl Plan {
    pub(super) fn draw(&self) -> RetainedDraw {
        match self {
            Plan::Draw(_) => RetainedDraw::Built,
            Plan::Redraw => RetainedDraw::Redrawn,
            Plan::Reuse(None) => RetainedDraw::Reused,
            Plan::Reuse(Some(_)) => RetainedDraw::Moved,
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
    owned: Vec<LayoutId>,
    released: Rc<RefCell<Vec<LayoutId>>>,
    pub(super) statics: Option<Statics>,
    pub(super) record: Rc<RetainedRecord>,
    /// Every retained subtree inside, at any depth.
    pub(super) nested: Vec<Rc<RetainedRecord>>,
    /// Its elements' states as last drawn.
    states: States,
    /// While it is drawn anew this frame: its elements' states, and what it
    /// records of its drawing, between phases.
    drawing: Option<ElementStateScope>,
    recording: Option<Recording>,
    /// The layout its drawing is of (`TaffyLayoutEngine::epoch`).
    epoch: u32,
}

impl Drop for RetainedState {
    fn drop(&mut self) {
        // No longer drawn: its nodes go at the end of the frame.
        self.released.borrow_mut().append(&mut self.owned);
    }
}

impl RetainedState {
    fn new(
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
        let drawn = self.record.drawn.borrow();
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
        let offset = bounds.origin - drawn.bounds.origin;
        let still = offset == Point::default();
        let mask = window.content_mask().bounds;
        if skippable && drawn.inert && (movable || still) && drawn.unseen(offset, &mask) {
            return Plan::Skip;
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
            return Plan::Reuse(None);
        }
        // A hover style is painted from what is under the pointer: where
        // the pointer is over the drawing, or would be once it is moved,
        // what is hovered may change though the pointer did not move.
        let pointer = window.mouse_position();
        let hovers = drawn.extent.is_some_and(|extent| {
            extent.contains(&pointer) || (extent + offset).contains(&pointer)
        });
        if movable && !hovers && drawn.moves(offset, bounds.origin, &mask, window.scale_factor()) {
            return Plan::Reuse(Some(offset));
        }
        Plan::Redraw
    }

    /// Leave it undrawn at `bounds`: nothing of it shows.
    pub(super) fn skip(&mut self, bounds: Bounds<Pixels>, window: &mut Window) {
        let mut drawn = self.record.drawn.borrow_mut();
        if drawn.ranges.take().is_some() {
            // What is inside goes with it (once: nothing is there after).
            for record in &self.nested {
                record.drawn.borrow_mut().ranges = None;
            }
        }
        let offset = bounds.origin - drawn.bounds.origin;
        drawn.shift(offset);
        drawn.bounds.origin = bounds.origin;
        drawn.mask = Some(window.content_mask().bounds);
        drawn.prunable = false;
    }

    /// Copy last frame's prepaint, `moved` away when given.
    pub(super) fn reuse_prepaint(
        &mut self,
        bounds: Bounds<Pixels>,
        moved: Option<Point<Pixels>>,
        window: &mut Window,
    ) {
        let mut drawn = self.record.drawn.borrow_mut();
        let Some(ranges) = &mut drawn.ranges else {
            return;
        };
        let old = ranges.prepaint.clone();
        let start = window.prepaint_index();
        window.reuse_prepaint_moved(old.clone(), moved);
        ranges.prepaint = start.clone()..window.prepaint_index();
        for record in &self.nested {
            let mut nested = record.drawn.borrow_mut();
            let kept = nested.ranges.as_mut().is_some_and(|ranges| {
                match moved_prepaint(&ranges.prepaint, &old, &start) {
                    Some(range) => {
                        ranges.prepaint = range;
                        true
                    }
                    None => false,
                }
            });
            if !kept {
                nested.ranges = None;
            }
            if let Some(moved) = moved {
                nested.shift(moved);
                nested.mask = None;
            }
        }
        if let Some(moved) = moved {
            drawn.shift(moved);
        }
        drawn.bounds.origin = bounds.origin;
        drawn.mask = Some(window.content_mask().bounds);
    }

    /// Copy last frame's paint, `moved` away when given.
    pub(super) fn reuse_paint(&mut self, moved: Option<Point<Pixels>>, window: &mut Window) {
        let mut drawn = self.record.drawn.borrow_mut();
        let Some(ranges) = &mut drawn.ranges else {
            return;
        };
        let old = ranges.paint.clone();
        let start = window.paint_index();
        window.reuse_paint_moved(old.clone(), moved);
        ranges.paint = start.clone()..window.paint_index();
        for record in &self.nested {
            let mut nested = record.drawn.borrow_mut();
            let kept = nested.ranges.as_mut().is_some_and(|ranges| {
                match moved_paint(&ranges.paint, &old, &start) {
                    Some(range) => {
                        ranges.paint = range;
                        true
                    }
                    None => false,
                }
            });
            if !kept {
                nested.ranges = None;
            }
        }
    }

    /// Build its elements again for the layout it kept: each asks for the
    /// node it made last time (`TaffyLayoutEngine::begin_bind`), so nothing
    /// is laid out, and the retained subtrees inside keep theirs. When they
    /// ask for anything else, it is built apart instead and laid out as its
    /// kept nodes sit (`compute_detached_layout`); the answer then carries
    /// how far that copy is from `bounds`.
    pub(super) fn rebuild(
        &mut self,
        build: &Build,
        bounds: Bounds<Pixels>,
        view: EntityId,
        window: &mut Window,
        cx: &mut App,
    ) -> (AnyElement, Option<Point<Pixels>>) {
        let mut element = build(window, cx);
        window.element_state_scopes.push(ElementStateScope {
            prev: mem::take(&mut self.states),
            next: States::default(),
        });
        window.retained_binding = true;
        window.layout_engine().begin_bind(self.owned.clone());
        let root = window.with_rendered_view(view, |window| element.request_layout(window, cx));
        let bound = window.end_bind(cx).is_some() && root == self.root;
        window.retained_binding = false;
        if bound {
            self.drawing = window.element_state_scopes.pop();
            return (element, None);
        }
        APART.with(|apart| apart.set(apart.get() + 1));
        // What it kept from its last drawing, whichever half the try took.
        let mut scope = window.element_state_scopes.pop().unwrap_or_default();
        scope.prev.extend(scope.next.drain());
        drop(element);
        let mut element = build(window, cx);
        window.element_state_scopes.push(ElementStateScope {
            prev: scope.prev,
            next: States::default(),
        });
        window.retained_detached += 1;
        let copy = window.with_rendered_view(view, |window| element.request_layout(window, cx));
        window.compute_detached_layout(copy, self.root, cx);
        let placed = window.layout_bounds(copy);
        window.retained_detached -= 1;
        self.drawing = window.element_state_scopes.pop();
        (element, Some(bounds.origin - placed.origin))
    }

    /// Prepaint its element, recording what it draws. `apart`: it was laid
    /// out apart, that far from where it belongs.
    pub(super) fn draw_prepaint(
        &mut self,
        element: &mut AnyElement,
        bounds: Bounds<Pixels>,
        apart: Option<Point<Pixels>>,
        view: EntityId,
        window: &mut Window,
        cx: &mut App,
    ) {
        let start = window.prepaint_index();
        window.begin_recording(None);
        let scope = self.drawing.take().unwrap_or_default();
        window.element_state_scopes.push(scope);
        match apart {
            None => {
                window.with_rendered_view(view, |window| element.prepaint(window, cx));
            }
            Some(offset) => {
                window.retained_detached += 1;
                window.with_element_offset(offset, |window| {
                    window.with_rendered_view(view, |window| element.prepaint(window, cx))
                });
                window.retained_detached -= 1;
            }
        }
        self.drawing = window.element_state_scopes.pop();
        self.recording = Some(window.end_recording());
        self.statics = Some(Statics::of(window));
        let mut drawn = self.record.drawn.borrow_mut();
        // Not whole until it is painted.
        drawn.known = false;
        drawn.ranges = Some(Ranges {
            prepaint: start..window.prepaint_index(),
            paint: Default::default(),
        });
        drawn.bounds = bounds;
        drawn.mask = Some(window.content_mask().bounds);
    }

    /// Paint its element, and keep what its drawing turned out to be.
    pub(super) fn draw_paint(
        &mut self,
        element: &mut AnyElement,
        skippable: bool,
        view: EntityId,
        window: &mut Window,
        cx: &mut App,
    ) {
        let start = window.paint_index();
        window.begin_recording(self.recording.take());
        let scope = self.drawing.take().unwrap_or_default();
        window.element_state_scopes.push(scope);
        window.with_rendered_view(view, |window| element.paint(window, cx));
        if let Some(scope) = window.element_state_scopes.pop() {
            // What it no longer has goes (`scope.prev`, dropped).
            self.states = scope.next;
        }
        let recording = window.end_recording();
        let paint = start..window.paint_index();
        let mut drawn = self.record.drawn.borrow_mut();
        let prepaint = match &mut drawn.ranges {
            Some(ranges) => {
                ranges.paint = paint.clone();
                ranges.prepaint.clone()
            }
            None => return,
        };
        // What lives outside its drawing: it is then neither moved nor left out.
        let frame = &window.next_frame;
        let placed = prepaint.start.deferred_draws_index != prepaint.end.deferred_draws_index
            || prepaint.start.tooltips_index != prepaint.end.tooltips_index
            || paint.start.input_handlers_index != paint.end.input_handlers_index;
        let takes_keys = paint.start.tab_handle_index != paint.end.tab_handle_index
            || !frame.dispatch_tree.range_is_inert(
                prepaint.start.dispatch_tree_index..prepaint.end.dispatch_tree_index,
            );
        drawn.valid = recording.valid;
        drawn.extent = recording.extent;
        drawn.pinned = recording.pinned || placed;
        drawn.glyphs = recording.glyphs;
        drawn.uneven = recording.uneven;
        drawn.inert = !(recording.stays || placed || takes_keys);
        drawn.prunable = recording.prunable;
        drawn.known = true;
        self.nested = recording.nested;
        self.epoch = window.layout_engine().epoch();
        // Drawn though nothing of it shows: the subtree around it can leave
        // it out the next time it is drawn.
        let unseen = skippable
            && drawn.inert
            && drawn
                .mask
                .is_some_and(|mask| drawn.unseen(Point::default(), &mask));
        drop(drawn);
        window.absorb_retained(&self.record, &self.nested, unseen);
    }
}

thread_local! {
    /// Subtrees built apart since `take_built_apart`.
    static APART: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How many retained subtrees could not be built onto their kept layout
/// (`RetainedState::rebuild`) since the last call, and were laid out again
/// apart: for a host's trace. Each is a subtree whose elements differ from
/// one build to the next with the same content.
pub fn take_built_apart() -> usize {
    APART.with(|apart| apart.replace(0))
}

/// Build a retained subtree's element and lay it out: its own nodes, kept
/// for later frames, or (inside a subtree drawn apart, `detached`) this
/// frame's only, leaving the nodes it keeps as they are.
pub(super) fn build_layout(
    state: Option<RetainedState>,
    view: EntityId,
    version: u64,
    build: &Build,
    detached: bool,
    window: &mut Window,
    cx: &mut App,
) -> (LayoutId, AnyElement, RetainedState) {
    let mut element = build(window, cx);
    let mut state = state;
    let prev = state
        .as_mut()
        .map(|state| mem::take(&mut state.states))
        .unwrap_or_default();
    window.element_state_scopes.push(ElementStateScope {
        prev,
        next: States::default(),
    });
    let (root, owned) = if detached {
        let root = window.with_rendered_view(view, |window| element.request_layout(window, cx));
        (root, None)
    } else {
        if let Some(state) = &mut state {
            // Its old nodes go before the new ones adopt the clean subtrees inside.
            let owned = mem::take(&mut state.owned);
            window.layout_engine().remove_nodes(owned);
        }
        window.layout_engine().begin_owned();
        let root = window.with_rendered_view(view, |window| element.request_layout(window, cx));
        (root, Some(window.layout_engine().end_owned()))
    };
    let drawing = window.element_state_scopes.pop();
    let mut state = match (state, owned) {
        (Some(mut state), Some(owned)) => {
            state.version = version;
            state.root = root;
            state.owned = owned;
            state.record.drawn.borrow_mut().known = false;
            state
        }
        (Some(state), None) => {
            if state.version != version {
                // Not expected (the subtree around it is clean); build it
                // properly next frame.
                state.record.drawn.borrow_mut().known = false;
            }
            state
        }
        // A detached first build keeps no nodes; the next frame builds it properly.
        (None, owned) => RetainedState::new(view, version, root, owned.unwrap_or_default(), window),
    };
    state.drawing = drawing;
    (root, element, state)
}
