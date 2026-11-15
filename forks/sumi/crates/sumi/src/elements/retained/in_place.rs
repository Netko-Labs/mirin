//! mirin: a retained subtree drawn again where it is, in the frame it was
//! last drawn in (`window/partial.rs`; `docs/metal/engine.md`, section 3).
//!
//! A full frame reaches a retained subtree through the elements around it,
//! which set what it is drawn under and where. A partial frame makes none
//! of them, so the subtree is drawn from what its state and its record
//! kept: how it is built, the text styles, rem size and opacity around it,
//! where it was laid out and drawn (bounds, content mask, element offset),
//! and its ranges in the frame's lists, which say what its dispatch nodes
//! and masks are under. It is found through the retained subtrees around
//! it (`Window::retained_chain`): each keeps the states of the ones inside
//! it and tells their records where their drawings are now.
//!
//! It can be drawn so when its last drawing is in the frame (it was not
//! left out), takes no keys or focus, defers nothing, and its elements
//! built now ask exactly for the layout it kept. Its drawing must then be
//! of the shape of the one before, and be found to be no more than that
//! one was (`Recorded::covers`): the records around it hold what they took
//! in of it. Whatever fails, nothing is put back: a full frame follows, which
//! draws it anew.

use std::ops::Range;

use super::{RetainedDraw, RetainedState, tell_inside, with_states};
use crate::{
    App, Bounds, EntityId, GlobalElementId, PaintIndex, Pixels, PrepaintStateIndex, Window, point,
    px, window::InPlace,
};

/// Draw the retained subtree notified by `view` again where it is; whether
/// it was.
pub(crate) fn draw_in_place(view: EntityId, window: &mut Window, cx: &mut App) -> bool {
    let Some(chain) = window.retained_chain(view) else {
        return false;
    };
    let version = window.retained_version(view);
    // Element states are looked up as in a prepaint; what looking them up
    // notes is in no range, and is taken back.
    window.set_in_place_phase();
    let marks = window.in_place_marks();
    let drew = draw_at(&chain, version, window, cx);
    window.truncate_to_marks(&marks);
    drew
}

/// Go down `chain` to the state of its last, through the states of the
/// retained subtrees around it, and draw that one in place.
fn draw_at(
    chain: &[GlobalElementId],
    version: Option<u64>,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let Some((id, inside)) = chain.split_first() else {
        return false;
    };
    if !window.has_element_state::<RetainedState>(id) {
        return false;
    }
    window.with_element_state::<RetainedState, _>(id, |state, window| {
        let Some(mut state) = state else {
            unreachable!("the state was found");
        };
        let drew = if inside.is_empty() {
            let drew = state.try_in_place(id, version, window, cx);
            window.leave_in_place();
            drew
        } else {
            state.settle_states();
            // The records right inside hear where their drawings are now.
            tell_inside(&mut state.drawn.borrow_mut());
            let prev = std::mem::take(&mut state.states);
            let (drew, scope) =
                with_states(prev, window, |window| draw_at(inside, version, window, cx));
            state.states = scope.prev;
            state.states.extend(scope.next);
            // Its drawing now holds one made with the pointer where it is:
            // what its hover styles are known to hold for (`plan`). Nothing
            // else in it changed with the pointer, or it would be dirty too.
            if drew {
                state.drawn.borrow_mut().pointer = window.mouse_position();
            }
            drew
        };
        (drew, state)
    })
}

/// A drawing's ranges in the frame, where it was drawn and what it was
/// found to be.
struct Last {
    prepaint: Range<PrepaintStateIndex>,
    paint: Range<PaintIndex>,
    bounds: Bounds<Pixels>,
    mask: crate::ContentMask<Pixels>,
    place: super::Place,
    recorded: super::Recorded,
}

impl RetainedState {
    /// What a partial frame draws over, when its last drawing is one a
    /// partial frame can draw over.
    fn last_drawing(&self, window: &mut Window) -> Option<Last> {
        let drawn = self.drawn.borrow();
        let last = Last {
            prepaint: drawn.prepaint.clone()?,
            paint: drawn.paint.clone()?,
            bounds: drawn.bounds,
            mask: drawn.mask.clone()?,
            place: drawn.place?,
            recorded: drawn.recorded?,
        };
        let (prepaint, paint) = (&last.prepaint, &last.paint);
        let drawable = drawn.inert
            && !self.remake
            && !self.image_cached
            && self.drawing.is_none()
            && self.statics.scale_factor == window.scale_factor()
            && window.prepaint_range_valid(prepaint)
            && window.paint_range_valid(paint)
            && prepaint.start.deferred_draws_index == prepaint.end.deferred_draws_index
            && paint.start.tab_handle_index == paint.end.tab_handle_index
            && paint.start.input_handlers_index == paint.end.input_handlers_index;
        drop(drawn);
        let engine = window.layout_engine_mut();
        (drawable && engine.contains(self.root) && !engine.any_asked_since(&self.owned, self.made))
            .then_some(last)
    }

    /// Draw it again over its last drawing, unless that failed lately once
    /// it was built (its drawing had another shape): then it waits, twice
    /// as many frames each time, since a failure costs the frame it is
    /// then drawn in all that was done for nothing.
    fn try_in_place(
        &mut self,
        id: &GlobalElementId,
        version: Option<u64>,
        window: &mut Window,
        cx: &mut App,
    ) -> bool {
        /// The most partial frames a subtree sits out.
        const LONGEST_WAIT: u8 = 15;
        if self.in_place_wait > 0 {
            self.in_place_wait -= 1;
            return false;
        }
        let mut built = false;
        let drew = self.draw_in_place(id, version, &mut built, window, cx);
        if drew {
            self.in_place_waited = 0;
        } else if built {
            self.in_place_waited = (self.in_place_waited * 2 + 1).min(LONGEST_WAIT);
            self.in_place_wait = self.in_place_waited;
        }
        drew
    }

    /// Draw it again over its last drawing; whether that was done. `built`:
    /// its elements were built onto its layout, so what failed after that
    /// was its drawing.
    fn draw_in_place(
        &mut self,
        id: &GlobalElementId,
        version: Option<u64>,
        built: &mut bool,
        window: &mut Window,
        cx: &mut App,
    ) -> bool {
        self.settle_states();
        let Some(last) = self.last_drawing(window) else {
            return false;
        };
        let Last {
            prepaint,
            paint,
            bounds,
            mask,
            place,
            recorded: was,
        } = last;
        let scale = window.scale_factor();
        // Its root is where it was: the origin it is rounded to is what its
        // bounds are from, less the element offset (`Window::layout_bounds`).
        let rounded = point(
            (bounds.origin.x.0 * scale).round() - place.offset.x,
            (bounds.origin.y.0 * scale).round() - place.offset.y,
        );
        let laid_out = Bounds::new(
            point(px(rounded.x / scale), px(rounded.y / scale)),
            bounds.size,
        );
        window
            .layout_engine_mut()
            .seed_bounds(self.root, place.layout, rounded, laid_out);
        let text_styles = self.text_styles.clone();
        window.enter_in_place(&InPlace {
            id,
            view: self.view,
            text_styles: &text_styles,
            rem_size: self.statics.rem_size,
            opacity: f32::from_bits(self.opacity),
            offset: point(px(place.offset.x / scale), px(place.offset.y / scale)),
            mask: &mask,
        });

        // Its elements, onto the nodes it kept: they must ask for what the
        // nodes hold, so the layout is the one it has.
        let marks = window.in_place_marks();
        window
            .layout_engine_mut()
            .begin_bind(self.owned.clone(), true);
        window.retained_binding += 1;
        let build = self.build.clone();
        let prev = std::mem::take(&mut self.states);
        let ((mut element, root), drawing) = with_states(prev, window, |window| {
            cx.unattributed_accesses(|cx| {
                let mut element = build(window, cx);
                let root = element.request_layout(window, cx);
                (element, root)
            })
        });
        window.retained_binding -= 1;
        let bound = window.end_bind(cx) && root == self.root;
        window.truncate_to_marks(&marks);
        self.drawing = Some(drawing);
        if !bound {
            self.settle_states();
            return false;
        }
        *built = true;

        // Prepaint, over what it prepainted.
        let [around_prepaint, around_paint] = window.masks_around(&prepaint, &paint);
        if !window.begin_prepaint_patch(&prepaint, around_prepaint) {
            window.end_prepaint_patch();
            self.settle_states();
            return false;
        }
        if let Some(on_prepaint) = self.on_prepaint.clone() {
            on_prepaint(RetainedDraw::Built, bounds, window, cx);
        }
        tell_inside(&mut self.drawn.borrow_mut());
        let recorded = self.prepaint_anew(&mut element, bounds, mask, Some(place), window, cx);
        if !window.end_prepaint_patch() {
            self.settle_states();
            return false;
        }

        // Paint, over what it painted, hovered by what is under the pointer
        // now.
        window.hit_test_in_place();
        let first_node = prepaint.start.dispatch_tree_index;
        if !window.begin_paint_patch(&paint, around_paint, first_node) {
            window.end_paint_patch(false);
            self.settle_states();
            return false;
        }
        let start = window.paint_index();
        self.paint_anew(&mut element, recorded, window, cx);
        let end = window.paint_index();
        let now = self.drawn.borrow().recorded;
        let inert = window.drawing_is_inert(&prepaint, &(start.clone()..end.clone()));
        let same = inert && now.is_some_and(|now| was.covers(&now));
        if !window.end_paint_patch(same) {
            return false;
        }
        let mut drawn = self.drawn.borrow_mut();
        drawn.inert = inert;
        drawn.paint = Some(start..end);
        drawn.pointer = window.mouse_position();
        drop(drawn);
        if let Some(version) = version {
            self.version = version;
        }
        window.partial_accessed(
            self.accessed_entities
                .iter()
                .copied()
                .chain(std::iter::once(self.view)),
        );
        true
    }
}
