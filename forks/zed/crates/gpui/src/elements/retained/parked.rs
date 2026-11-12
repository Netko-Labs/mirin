//! mirin: the drawing of a retained subtree left undrawn, kept for when it
//! shows again (`docs/metal/gpui-next.md`, step 3; the fork's
//! `../gpui/src/elements/retained/parked.rs`).
//!
//! A subtree nothing shows of is not drawn (`Plan::Skip`), so its last
//! drawing leaves the frame with it; when it came back into view (a row
//! scrolled out and back) it was built and drawn again, though it draws what
//! it did. Its drawing is now taken out of the frame it was last in
//! ([`Parked`]) and, when it shows again, put back at the end of last
//! frame's lists, from where it is copied like any drawing that moved.
//! Nothing is done for it in the frames between. A drawing on upstream
//! carries its content masks in its primitives and hitboxes, so (unlike the
//! fork's) nothing in it needs renumbering but its dispatch nodes.
//!
//! What is kept is bounded ([`BUDGET`]): past it, the drawings parked
//! longest ago are dropped, and those subtrees are drawn anew, as before.

use std::{
    any::TypeId,
    cell::{Cell, RefCell},
    collections::VecDeque,
    ops::Range,
    rc::{Rc, Weak},
};

use crate::{
    Bounds, ContentMask, GlobalElementId, Hitbox, PaintIndex, Pixels, PrepaintStateIndex, Window,
    key_dispatch::DispatchNode,
    scene::PaintOperation,
    text_system::ParkedLayouts,
    window::{AnyMouseListener, CursorStyleRequest},
};

use super::{
    plan::{Drawn, Place},
    recording::Recorded,
};

/// How much may be parked in a window: primitives, hitboxes and listeners.
const BUDGET: usize = 24_000;

/// Ranges of a drawing in a frame's lists.
pub(crate) type Ranges = (Range<PrepaintStateIndex>, Range<PaintIndex>);

/// A retained subtree's drawing, out of any frame, and what its record said
/// of it when it was drawn.
pub(crate) struct Parked {
    /// Where it was in the frame it was taken from: what the ranges of the
    /// subtrees inside it count from.
    ranges: Ranges,
    /// Its record as drawn (where, under which mask, what it found).
    pub(super) bounds: Bounds<Pixels>,
    pub(super) mask: Option<ContentMask<Pixels>>,
    pub(super) place: Option<Place>,
    pub(super) recorded: Option<Recorded>,
    pub(super) epoch: u64,
    pub(super) pointer: crate::Point<Pixels>,
    /// The drawings of the retained subtrees inside it, in the same frame
    /// (in the order of the state's `nested`).
    nested: Vec<Option<Ranges>>,
    hitboxes: Vec<Hitbox>,
    dispatch: Vec<DispatchNode>,
    operations: Vec<PaintOperation>,
    mouse_listeners: Vec<Option<AnyMouseListener>>,
    cursor_styles: Vec<CursorStyleRequest>,
    #[cfg(any(test, feature = "test-support"))]
    debug_bounds: Vec<(String, Bounds<Pixels>)>,
    /// Per phase (prepaint, paint): the element states used and the text
    /// laid out.
    states: [Vec<(GlobalElementId, TypeId)>; 2],
    layouts: [ParkedLayouts; 2],
    /// What it counts toward `BUDGET`, and the window's count it is in.
    cost: usize,
    held: Rc<Cell<usize>>,
    ticket: u64,
}

impl Drop for Parked {
    fn drop(&mut self) {
        self.held.set(self.held.get().saturating_sub(self.cost));
    }
}

type Record = Rc<RefCell<Drawn>>;

/// The drawings parked in a window, oldest first.
#[derive(Default)]
pub(crate) struct Parking {
    held: Rc<Cell<usize>>,
    queue: VecDeque<(Weak<RefCell<Drawn>>, u64)>,
    next: u64,
}

impl Parking {
    /// Drop the oldest drawings until what is parked fits the budget.
    fn evict(&mut self) {
        while self.held.get() > BUDGET {
            let Some((record, ticket)) = self.queue.pop_front() else {
                break;
            };
            let Some(record) = record.upgrade() else {
                continue;
            };
            // One that is being drawn now is not parked.
            let Ok(mut drawn) = record.try_borrow_mut() else {
                continue;
            };
            if drawn
                .parked
                .as_ref()
                .is_some_and(|parked| parked.ticket == ticket)
            {
                drawn.parked = None;
            }
        }
        // Tickets of drawings since taken back or dropped.
        if self.queue.len() > 4 * 1024 {
            self.queue.retain(|(record, ticket)| {
                record.upgrade().is_some_and(|record| {
                    record.try_borrow().is_ok_and(|drawn| {
                        drawn
                            .parked
                            .as_ref()
                            .is_some_and(|parked| parked.ticket == *ticket)
                    })
                })
            });
        }
    }
}

impl Window {
    /// Take the drawing `drawn` (of `record`) made in last frame out of it,
    /// with those of `nested` inside it. `None` when it is more than may be
    /// parked at all.
    pub(crate) fn park(
        &mut self,
        record: &Record,
        drawn: &Drawn,
        nested: &[Record],
    ) -> Option<Box<Parked>> {
        let (prepaint, paint) = (drawn.prepaint.clone()?, drawn.paint.clone()?);
        if !self.prepaint_range_valid(&prepaint) || !self.paint_range_valid(&paint) {
            return None;
        }
        let hitboxes = prepaint.start.hitboxes_index..prepaint.end.hitboxes_index;
        let operations = paint.start.scene_index..paint.end.scene_index;
        let listeners = paint.start.mouse_listeners_index..paint.end.mouse_listeners_index;
        let cost = hitboxes.len() + operations.len() + listeners.len();
        if cost > BUDGET / 2 {
            return None;
        }
        let states = [
            prepaint.start.accessed_element_states_index
                ..prepaint.end.accessed_element_states_index,
            paint.start.accessed_element_states_index..paint.end.accessed_element_states_index,
        ];
        let layouts = [
            prepaint.start.line_layout_index.clone()..prepaint.end.line_layout_index.clone(),
            paint.start.line_layout_index.clone()..paint.end.line_layout_index.clone(),
        ];
        let nested = nested
            .iter()
            .map(|nested| {
                let nested = nested.borrow();
                Some((nested.prepaint.clone()?, nested.paint.clone()?))
            })
            .collect();
        let layouts = layouts.map(|range| self.text_system().park_layouts(range));
        let frame = &mut self.rendered_frame;
        let states = states.map(|range| frame.accessed_element_states[range].to_vec());
        let parking = &mut self.retained_parking;
        parking.next += 1;
        parking.held.set(parking.held.get() + cost);
        parking
            .queue
            .push_back((Rc::downgrade(record), parking.next));
        let parked = Box::new(Parked {
            bounds: drawn.bounds,
            mask: drawn.mask.clone(),
            place: drawn.place,
            recorded: drawn.recorded,
            epoch: drawn.epoch,
            pointer: drawn.pointer,
            nested,
            hitboxes: frame.hitboxes[hitboxes].to_vec(),
            dispatch: frame
                .dispatch_tree
                .park_nodes(prepaint.start.dispatch_tree_index..prepaint.end.dispatch_tree_index),
            operations: frame.scene.paint_operations[operations]
                .iter()
                .map(PaintOperation::clone)
                .collect(),
            mouse_listeners: frame.mouse_listeners[listeners]
                .iter_mut()
                .map(Option::take)
                .collect(),
            cursor_styles: frame.cursor_styles
                [paint.start.cursor_styles_index..paint.end.cursor_styles_index]
                .to_vec(),
            #[cfg(any(test, feature = "test-support"))]
            debug_bounds: frame.debug_bounds_records
                [paint.start.debug_bounds_index..paint.end.debug_bounds_index]
                .to_vec(),
            states,
            layouts,
            cost,
            held: parking.held.clone(),
            ticket: parking.next,
            ranges: (prepaint, paint),
        });
        // Its own cost is counted: the oldest go first.
        self.retained_parking.evict();
        Some(parked)
    }

    /// Put a parked drawing back at the end of last frame's lists, from
    /// where it is copied like any drawing of last frame. The answer is
    /// where it is there, and where the drawings inside it are.
    pub(crate) fn unpark(&mut self, parked: Box<Parked>) -> (Ranges, Vec<Option<Ranges>>) {
        let mut parked = parked;
        let (was_prepaint, was_paint) = parked.ranges.clone();
        let [prepaint_states, paint_states] = std::mem::take(&mut parked.states);
        let [prepaint_layouts, paint_layouts] = std::mem::take(&mut parked.layouts);
        let prepaint_lines = self.text_system().unpark_layouts(prepaint_layouts);
        let paint_lines = self.text_system().unpark_layouts(paint_layouts);
        let frame = &mut self.rendered_frame;

        // What prepaint made.
        let prepaint = PrepaintStateIndex {
            hitboxes_index: frame.hitboxes.len(),
            tooltips_index: frame.tooltip_requests.len(),
            deferred_draws_index: frame.deferred_draws.len(),
            dispatch_tree_index: frame.dispatch_tree.len(),
            accessed_element_states_index: frame.accessed_element_states.len(),
            line_layout_index: prepaint_lines.start,
        };
        frame.hitboxes.append(&mut parked.hitboxes);
        frame.dispatch_tree.unpark_nodes(
            std::mem::take(&mut parked.dispatch),
            was_prepaint.start.dispatch_tree_index,
        );
        frame.accessed_element_states.extend(prepaint_states);
        let prepaint_end = PrepaintStateIndex {
            hitboxes_index: frame.hitboxes.len(),
            dispatch_tree_index: frame.dispatch_tree.len(),
            accessed_element_states_index: frame.accessed_element_states.len(),
            line_layout_index: prepaint_lines.end,
            ..prepaint.clone()
        };

        // What paint made.
        let paint = PaintIndex {
            scene_index: frame.scene.len(),
            #[cfg(any(test, feature = "test-support"))]
            debug_bounds_index: frame.debug_bounds_records.len(),
            mouse_listeners_index: frame.mouse_listeners.len(),
            input_handlers_index: frame.input_handlers.len(),
            cursor_styles_index: frame.cursor_styles.len(),
            accessed_element_states_index: frame.accessed_element_states.len(),
            tab_handle_index: frame.tab_stops.paint_index(),
            line_layout_index: paint_lines.start,
        };
        frame.scene.paint_operations.append(&mut parked.operations);
        #[cfg(any(test, feature = "test-support"))]
        frame.debug_bounds_records.append(&mut parked.debug_bounds);
        frame.mouse_listeners.append(&mut parked.mouse_listeners);
        frame.cursor_styles.append(&mut parked.cursor_styles);
        frame.accessed_element_states.extend(paint_states);
        let paint_end = PaintIndex {
            scene_index: frame.scene.len(),
            #[cfg(any(test, feature = "test-support"))]
            debug_bounds_index: frame.debug_bounds_records.len(),
            mouse_listeners_index: frame.mouse_listeners.len(),
            cursor_styles_index: frame.cursor_styles.len(),
            accessed_element_states_index: frame.accessed_element_states.len(),
            line_layout_index: paint_lines.end,
            ..paint.clone()
        };

        // The drawings inside it are where they were in it, unless the
        // fonts changed (their text is then not where it was).
        let lines_moved = |range: &Range<PrepaintStateIndex>| {
            range.start.line_layout_index.font_generation
                == prepaint.line_layout_index.font_generation
        };
        let nested = std::mem::take(&mut parked.nested)
            .into_iter()
            .map(|ranges| {
                let (nested_prepaint, nested_paint) = ranges?;
                if !lines_moved(&nested_prepaint) {
                    return None;
                }
                Some((
                    nested_prepaint.start.rebase(&was_prepaint.start, &prepaint)
                        ..nested_prepaint.end.rebase(&was_prepaint.start, &prepaint),
                    nested_paint.start.rebase(&was_paint.start, &paint)
                        ..nested_paint.end.rebase(&was_paint.start, &paint),
                ))
            })
            .collect();
        ((prepaint..prepaint_end, paint..paint_end), nested)
    }
}
