//! mirin: the ways a retained subtree is drawn: built, built again onto
//! its kept layout, copied (where it was or moved), or left out.

use std::mem;

use crate::{
    AnyElement, App, Bounds, EntityId, LayoutId, Pixels, Point, Window, window::ElementStateScope,
};

use super::{
    Build, States,
    moved::{moved_paint, moved_prepaint},
    state::{Ranges, RetainedState, Statics},
};

impl RetainedState {
    /// Leave it undrawn at `bounds`: nothing of it shows. Its drawing, when
    /// last frame has it, is put aside for when it shows again (`parked`).
    /// `resized`: its root is another size than drawn (`Plan::SkipResized`),
    /// so that drawing is of no use and goes; it is drawn when it shows.
    pub(super) fn skip(&mut self, bounds: Bounds<Pixels>, resized: bool, window: &mut Window) {
        let (ranges, origin, whole) = {
            let mut drawn = self.record.drawn.borrow_mut();
            // Only a drawing with nothing left out (one made out of view
            // has little in it) that may be copied elsewhere is of use.
            let whole = drawn.valid.is_everywhere() && !drawn.pinned && !resized;
            (drawn.ranges.take(), drawn.bounds.origin, whole)
        };
        let parked = ranges.and_then(|ranges| {
            // What is inside goes with it (once: nothing is there after).
            let nested = self
                .nested
                .iter()
                .map(|record| record.drawn.borrow_mut().ranges.take())
                .collect();
            whole
                .then(|| window.park(&self.record, ranges, origin, nested))
                .flatten()
        });
        let mut drawn = self.record.drawn.borrow_mut();
        if parked.is_some() {
            drawn.parked = parked;
        }
        if resized {
            // How far it reaches at its new size, which the next frame
            // measures from (the layout says it changed until it is drawn
            // again, so its size is not taken for the drawing's).
            drawn.parked = None;
            drawn.extent = drawn.resized_extent(bounds.size);
            drawn.bounds.size = bounds.size;
        }
        // Where it would be drawn, and how far it would reach: what the
        // subtree around it records of it. The mask stays the one its
        // drawing was made under.
        let offset = bounds.origin - drawn.bounds.origin;
        drawn.shift(offset);
        drawn.bounds.origin = bounds.origin;
        drawn.prunable = false;
    }

    /// Copy last frame's prepaint, `moved` device pixels away when given.
    pub(super) fn reuse_prepaint(
        &mut self,
        bounds: Bounds<Pixels>,
        moved: Option<Point<f32>>,
        window: &mut Window,
    ) {
        let grid = window.grid();
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
                nested.shift_device(moved, &grid);
                nested.mask = None;
            }
        }
        if let Some(moved) = moved {
            drawn.shift_device(moved, &grid);
        }
        drawn.bounds.origin = bounds.origin;
        drawn.mask = Some(window.content_mask().bounds);
    }

    /// Copy last frame's paint, `moved` away when given (`whole`:
    /// `Scene::replay_moved`).
    pub(super) fn reuse_paint(
        &mut self,
        moved: Option<Point<f32>>,
        whole: bool,
        window: &mut Window,
    ) {
        let mut drawn = self.record.drawn.borrow_mut();
        let Some(ranges) = &mut drawn.ranges else {
            return;
        };
        let old = ranges.paint.clone();
        let start = window.paint_index();
        window.reuse_paint_moved(old.clone(), moved, whole);
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
        // A text holds what its last measure left it with. For the ones it
        // was made with, that is what a layout from nothing asks last; once
        // a later layout measured one again (finding some of its answers in
        // taffy's cache and not others), it may be another: then the subtree
        // is laid out anew, apart.
        let as_made = !window
            .layout_engine()
            .any_asked_since(&self.owned, self.made);
        if as_made {
            window.retained_binding = true;
            window.layout_engine().begin_bind(self.owned.clone());
            let root = window.with_rendered_view(view, |window| element.request_layout(window, cx));
            let bound = window.end_bind(cx).is_some() && root == self.root;
            window.retained_binding = false;
            if bound {
                self.drawing = window.element_state_scopes.pop();
                return (element, None);
            }
            // What it kept from its last drawing, whichever half the try took.
            let mut scope = window.element_state_scopes.pop().unwrap_or_default();
            scope.prev.extend(scope.next.drain());
            window.element_state_scopes.push(ElementStateScope {
                prev: scope.prev,
                next: States::default(),
            });
            drop(element);
            element = build(window, cx);
        }
        APART.with(|apart| apart.set(apart.get() + 1));
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
        // Not whole until it is painted; a drawing put aside is of what it
        // was.
        drawn.known = false;
        drawn.parked = None;
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
        drawn.fixed = recording.fixed;
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
    let made = window.layout_engine().epoch();
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
            state.made = made;
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
