//! mirin: the drawing of a retained subtree left undrawn, kept for when it
//! shows again.
//!
//! A subtree nothing shows of is not drawn (`RetainedState::skip`), so its
//! last drawing leaves the frame with it; when it came back into view (a
//! row scrolled out and back) its elements were built and drawn again,
//! though it draws what it did. Its drawing is now taken out of the frame
//! it was last in ([`Parked`]) and, when it shows again, put back at the
//! end of last frame's lists, from where it is copied like any drawing
//! that moved. Nothing is done for it in the frames between.
//!
//! What is kept is bounded ([`BUDGET`]): past it, the drawings parked
//! longest ago are dropped, and those subtrees are drawn anew, as before.

use std::{
    any::TypeId,
    cell::Cell,
    collections::VecDeque,
    ops::Range,
    rc::{Rc, Weak},
};

use crate::{
    AnyMouseListener, GlobalElementId, Hitbox, PaintIndex, Pixels, Point, PrepaintStateIndex,
    Window, key_dispatch::DispatchNode, scene::PaintOperation, text_system::ParkedLayouts,
    window::CursorStyleRequest,
};

use super::{
    RetainedRecord,
    masks::MaskNode,
    moved::{moved_paint, moved_prepaint},
    state::Ranges,
};

/// How much may be parked in a window: primitives, hitboxes and listeners
/// (about 3 MB of them at their largest).
const BUDGET: usize = 24_000;

/// A retained subtree's drawing, out of any frame.
pub(crate) struct Parked {
    /// Where it was in the frame it was taken from: what the mask ids in
    /// it, and the ranges of the subtrees inside it, count from.
    ranges: Ranges,
    /// Where it was drawn.
    pub(super) origin: Point<Pixels>,
    /// The drawings of the retained subtrees inside it, in the same frame
    /// (in the order of `RetainedState::nested`).
    nested: Vec<Option<Ranges>>,
    hitboxes: Vec<Hitbox>,
    hitbox_masks: Vec<u32>,
    dispatch: Vec<DispatchNode>,
    operations: Vec<PaintOperation>,
    operation_masks: Vec<u32>,
    mouse_listeners: Vec<Option<AnyMouseListener>>,
    cursor_styles: Vec<CursorStyleRequest>,
    /// Per phase (prepaint, paint): the content masks pushed, the element
    /// states used and the text laid out.
    masks: [Vec<MaskNode>; 2],
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

/// The drawings parked in a window, oldest first.
pub(crate) struct Parking {
    held: Rc<Cell<usize>>,
    queue: VecDeque<(Weak<RetainedRecord>, u64)>,
    next: u64,
    /// `BUDGET`, unless a test set another.
    budget: usize,
}

impl Default for Parking {
    fn default() -> Self {
        Self {
            held: Rc::default(),
            queue: VecDeque::new(),
            next: 0,
            budget: BUDGET,
        }
    }
}

impl Parking {
    /// How much is parked (`BUDGET`'s unit), for tests.
    #[cfg(test)]
    pub(crate) fn held(&self) -> usize {
        self.held.get()
    }

    /// Park at most this much, for tests.
    #[cfg(test)]
    pub(crate) fn set_budget(&mut self, budget: usize) {
        self.budget = budget;
        self.evict();
    }

    /// Drop the oldest drawings until what is parked fits the budget.
    fn evict(&mut self) {
        while self.held.get() > self.budget {
            let Some((record, ticket)) = self.queue.pop_front() else {
                break;
            };
            let Some(record) = record.upgrade() else {
                continue;
            };
            // One that is being drawn now is not parked.
            let Ok(mut drawn) = record.drawn.try_borrow_mut() else {
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
                    record.drawn.try_borrow().is_ok_and(|drawn| {
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

/// A mask id of a parked drawing (its place in the frame's list, from 1)
/// where the masks pushed inside the drawing, once at `was`, are at `now`.
/// A mask around the drawing is none (0): whatever is around it then.
fn rebased(id: u32, was: &Range<usize>, now: usize) -> u32 {
    match (id as usize).checked_sub(1) {
        Some(index) if was.contains(&index) => (index - was.start + now + 1) as u32,
        _ => 0,
    }
}

impl Window {
    /// Take the drawing at `ranges` of last frame out of it: the subtree
    /// `record` drew it at `origin` and is left undrawn. `nested` are the
    /// drawings of the subtrees inside it. `None` when it is more than may
    /// be parked at all.
    pub(crate) fn park(
        &mut self,
        record: &Rc<RetainedRecord>,
        ranges: Ranges,
        origin: Point<Pixels>,
        nested: Vec<Option<Ranges>>,
    ) -> Option<Box<Parked>> {
        let (prepaint, paint) = (&ranges.prepaint, &ranges.paint);
        if !self.prepaint_range_valid(prepaint) || !self.paint_range_valid(paint) {
            return None;
        }
        let hitboxes = prepaint.start.hitboxes_index..prepaint.end.hitboxes_index;
        let operations = paint.start.scene_index..paint.end.scene_index;
        let listeners = paint.start.mouse_listeners_index..paint.end.mouse_listeners_index;
        let cost = hitboxes.len() + operations.len() + listeners.len();
        if cost > self.parking.budget / 2 {
            return None;
        }
        let masks = [
            prepaint.start.content_masks_index..prepaint.end.content_masks_index,
            paint.start.content_masks_index..paint.end.content_masks_index,
        ];
        let states = [
            prepaint.start.accessed_element_states_index
                ..prepaint.end.accessed_element_states_index,
            paint.start.accessed_element_states_index..paint.end.accessed_element_states_index,
        ];
        let layouts = [
            prepaint.start.line_layout_index.clone()..prepaint.end.line_layout_index.clone(),
            paint.start.line_layout_index.clone()..paint.end.line_layout_index.clone(),
        ];
        let text_system = self.text_system().clone();
        let frame = &mut self.rendered_frame;
        let states = states.map(|range| {
            frame.accessed_element_states[range]
                .iter()
                .map(|(id, type_id)| (GlobalElementId(id.0.clone()), *type_id))
                .collect()
        });
        let parking = &mut self.parking;
        parking.next += 1;
        parking.held.set(parking.held.get() + cost);
        parking
            .queue
            .push_back((Rc::downgrade(record), parking.next));
        let parked = Box::new(Parked {
            origin,
            nested,
            hitboxes: frame.hitboxes[hitboxes.clone()].to_vec(),
            hitbox_masks: frame.hitbox_masks[hitboxes].to_vec(),
            dispatch: frame
                .dispatch_tree
                .park_nodes(prepaint.start.dispatch_tree_index..prepaint.end.dispatch_tree_index),
            operations: frame.scene.paint_operations[operations.clone()].to_vec(),
            operation_masks: frame.scene.operation_masks[operations].to_vec(),
            mouse_listeners: frame.mouse_listeners[listeners]
                .iter_mut()
                .map(|listener| listener.take())
                .collect(),
            cursor_styles: frame.cursor_styles
                [paint.start.cursor_styles_index..paint.end.cursor_styles_index]
                .to_vec(),
            masks: masks.map(|range| frame.content_masks[range].to_vec()),
            states,
            layouts: layouts.map(|range| text_system.park_layouts(range)),
            cost,
            held: parking.held.clone(),
            ticket: parking.next,
            ranges,
        });
        // Its own cost is counted: the oldest go first.
        self.parking.evict();
        Some(parked)
    }

    /// Put a parked drawing back at the end of last frame's lists, from
    /// where it is copied like any drawing of last frame. The answer is
    /// where it is there, and where the drawings inside it are.
    pub(crate) fn unpark(&mut self, parked: Box<Parked>) -> (Ranges, Vec<Option<Ranges>>) {
        let mut parked = parked;
        let was = parked.ranges.clone();
        let was_masks = [
            was.prepaint.start.content_masks_index..was.prepaint.end.content_masks_index,
            was.paint.start.content_masks_index..was.paint.end.content_masks_index,
        ];
        let [prepaint_masks, paint_masks] = std::mem::take(&mut parked.masks);
        let [prepaint_states, paint_states] = std::mem::take(&mut parked.states);
        let [prepaint_layouts, paint_layouts] = std::mem::take(&mut parked.layouts);
        let text_system = self.text_system().clone();
        let frame = &mut self.rendered_frame;

        // What prepaint made.
        let mut prepaint = PrepaintStateIndex {
            hitboxes_index: frame.hitboxes.len(),
            tooltips_index: frame.tooltip_requests.len(),
            deferred_draws_index: frame.deferred_draws.len(),
            dispatch_tree_index: frame.dispatch_tree.len(),
            accessed_element_states_index: frame.accessed_element_states.len(),
            line_layout_index: Default::default(),
            content_masks_index: frame.content_masks.len(),
        };
        let now = prepaint.content_masks_index;
        frame
            .content_masks
            .extend(prepaint_masks.into_iter().map(|node| MaskNode {
                bounds: node.bounds,
                parent: rebased(node.parent, &was_masks[0], now),
            }));
        frame.hitboxes.append(&mut parked.hitboxes);
        frame.hitbox_masks.extend(
            parked
                .hitbox_masks
                .drain(..)
                .map(|id| rebased(id, &was_masks[0], now)),
        );
        frame.dispatch_tree.unpark_nodes(
            std::mem::take(&mut parked.dispatch),
            was.prepaint.start.dispatch_tree_index,
        );
        frame.accessed_element_states.extend(prepaint_states);
        let layouts = text_system.unpark_layouts(prepaint_layouts);
        prepaint.line_layout_index = layouts.start;
        let prepaint_end = PrepaintStateIndex {
            hitboxes_index: frame.hitboxes.len(),
            dispatch_tree_index: frame.dispatch_tree.len(),
            accessed_element_states_index: frame.accessed_element_states.len(),
            line_layout_index: layouts.end,
            content_masks_index: frame.content_masks.len(),
            ..prepaint.clone()
        };

        // What paint made.
        let mut paint = PaintIndex {
            scene_index: frame.scene.len(),
            mouse_listeners_index: frame.mouse_listeners.len(),
            input_handlers_index: frame.input_handlers.len(),
            cursor_styles_index: frame.cursor_styles.len(),
            accessed_element_states_index: frame.accessed_element_states.len(),
            tab_handle_index: frame.tab_stops.paint_index(),
            line_layout_index: Default::default(),
            content_masks_index: frame.content_masks.len(),
        };
        let now = paint.content_masks_index;
        frame
            .content_masks
            .extend(paint_masks.into_iter().map(|node| MaskNode {
                bounds: node.bounds,
                parent: rebased(node.parent, &was_masks[1], now),
            }));
        frame.scene.paint_operations.append(&mut parked.operations);
        frame.scene.operation_masks.extend(
            parked
                .operation_masks
                .drain(..)
                .map(|id| rebased(id, &was_masks[1], now)),
        );
        frame.mouse_listeners.append(&mut parked.mouse_listeners);
        frame.cursor_styles.append(&mut parked.cursor_styles);
        frame.accessed_element_states.extend(paint_states);
        let layouts = text_system.unpark_layouts(paint_layouts);
        paint.line_layout_index = layouts.start;
        let paint_end = PaintIndex {
            scene_index: frame.scene.len(),
            mouse_listeners_index: frame.mouse_listeners.len(),
            cursor_styles_index: frame.cursor_styles.len(),
            accessed_element_states_index: frame.accessed_element_states.len(),
            line_layout_index: layouts.end,
            content_masks_index: frame.content_masks.len(),
            ..paint.clone()
        };

        // The drawings inside it are where they were in it.
        let nested = std::mem::take(&mut parked.nested)
            .into_iter()
            .map(|ranges| {
                let ranges = ranges?;
                Some(Ranges {
                    prepaint: moved_prepaint(&ranges.prepaint, &was.prepaint, &prepaint)?,
                    paint: moved_paint(&ranges.paint, &was.paint, &paint)?,
                })
            })
            .collect();
        let ranges = Ranges {
            prepaint: prepaint..prepaint_end,
            paint: paint..paint_end,
        };
        (ranges, nested)
    }
}
