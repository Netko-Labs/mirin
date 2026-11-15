//! What a partial frame does to the frame's lists (`super`): each writes
//! over the range a retained subtree filled the last time it was drawn,
//! steps over the drawings kept inside it, and says whether the range was
//! filled exactly.

use std::ops::Range;

use crate::{
    Window,
    window::{DrawPhase, MaskId, PaintIndex, PrepaintStateIndex},
};

impl Window {
    /// The content masks a drawing in these ranges of the frame being
    /// drawn was made under, in prepaint and in paint: the mask around it,
    /// as the frame numbers it (`MaskNode`). Anything in it drawn under a
    /// mask that is not one of its own says so; where nothing does, nothing
    /// in it needs to know.
    pub(crate) fn masks_around(
        &self,
        prepaint: &Range<PrepaintStateIndex>,
        paint: &Range<PaintIndex>,
    ) -> [MaskId; 2] {
        let frame = &self.next_frame;
        let outside = |id: MaskId, own: &Range<usize>| {
            (id as usize)
                .checked_sub(1)
                .is_none_or(|index| !own.contains(&index))
        };
        let own = prepaint.start.content_masks_index..prepaint.end.content_masks_index;
        let of_prepaint = frame
            .hitbox_masks
            .get(prepaint.start.hitboxes_index..prepaint.end.hitboxes_index)
            .into_iter()
            .flatten()
            .copied()
            .chain(
                frame
                    .content_masks
                    .get(own.clone())
                    .into_iter()
                    .flatten()
                    .map(|node| node.parent),
            )
            .find(|id| outside(*id, &own))
            .unwrap_or(0);
        let own = paint.start.content_masks_index..paint.end.content_masks_index;
        let operations = frame
            .scene
            .paint_operations
            .get(paint.start.scene_index..paint.end.scene_index)
            .into_iter()
            .flatten()
            .filter_map(|operation| operation.mask_id());
        let of_paint = operations
            .chain(
                frame
                    .content_masks
                    .get(own.clone())
                    .into_iter()
                    .flatten()
                    .map(|node| node.parent),
            )
            .find(|id| outside(*id, &own))
            .unwrap_or(0);
        [of_prepaint, of_paint]
    }

    /// The mask around the subtree being drawn in place is the frame's
    /// `around` in this phase.
    fn set_mask_around(&mut self, around: MaskId) {
        self.mask_ids.clear();
        self.mask_free.clear();
        self.mask_ids.push(around);
        self.mask_free.push(None);
        self.next_frame.scene.mask_id = around;
    }

    /// From here on, what prepaint pushes goes over `range` of the frame's
    /// lists, under the mask `around`. `false`: it can't.
    pub(crate) fn begin_prepaint_patch(
        &mut self,
        range: &Range<PrepaintStateIndex>,
        around: MaskId,
    ) -> bool {
        self.invalidator.set_phase(DrawPhase::Prepaint);
        self.set_mask_around(around);
        let (start, end) = (&range.start, &range.end);
        let frame = &mut self.next_frame;
        // A deferred draw is drawn after everything else: not in place.
        start.deferred_draws_index == end.deferred_draws_index
            && frame
                .hitboxes
                .begin_patch(start.hitboxes_index..end.hitboxes_index)
            && frame
                .hitbox_masks
                .begin_patch(start.hitboxes_index..end.hitboxes_index)
            && frame
                .content_masks
                .begin_patch(start.content_masks_index..end.content_masks_index)
            && frame
                .tooltip_requests
                .begin_patch(start.tooltips_index..end.tooltips_index)
            && frame
                .accessed_element_states
                .begin_patch(start.accessed_element_states_index..end.accessed_element_states_index)
            && frame
                .dispatch_tree
                .begin_patch(start.dispatch_tree_index..end.dispatch_tree_index)
            && self
                .text_system
                .begin_layouts_patch(start.line_layout_index.clone()..end.line_layout_index.clone())
    }

    /// Prepaint is over; whether it filled its ranges exactly.
    pub(crate) fn end_prepaint_patch(&mut self) -> bool {
        let frame = &mut self.next_frame;
        let held = [
            frame.hitboxes.end_patch(),
            frame.hitbox_masks.end_patch(),
            frame.content_masks.end_patch(),
            frame.tooltip_requests.end_patch(),
            frame.accessed_element_states.end_patch(),
            frame.dispatch_tree.end_patch(),
            self.text_system.end_layouts_patch(),
        ];
        held.iter().all(|held| *held) && !self.partial_failed()
    }

    /// From here on, what paint pushes goes over `range` of the frame's
    /// lists, under the mask `around`; `first_node`: the first dispatch
    /// node of the subtree. `false`: it can't.
    pub(crate) fn begin_paint_patch(
        &mut self,
        range: &Range<PaintIndex>,
        around: MaskId,
        first_node: usize,
    ) -> bool {
        self.invalidator.set_phase(DrawPhase::Paint);
        self.set_mask_around(around);
        let (start, end) = (&range.start, &range.end);
        let frame = &mut self.next_frame;
        frame.dispatch_tree.activate_parent_of(first_node);
        #[cfg(any(test, feature = "test-support"))]
        if !frame
            .debug_bounds_records
            .begin_patch(start.debug_bounds_index..end.debug_bounds_index)
        {
            return false;
        }
        // Tab stops are a map of the whole frame: not in place.
        start.tab_handle_index == end.tab_handle_index
            && frame
                .content_masks
                .begin_patch(start.content_masks_index..end.content_masks_index)
            && frame
                .mouse_listeners
                .begin_patch(start.mouse_listeners_index..end.mouse_listeners_index)
            && frame
                .input_handlers
                .begin_patch(start.input_handlers_index..end.input_handlers_index)
            && frame
                .cursor_styles
                .begin_patch(start.cursor_styles_index..end.cursor_styles_index)
            && frame
                .accessed_element_states
                .begin_patch(start.accessed_element_states_index..end.accessed_element_states_index)
            && frame.scene.begin_patch(start.scene_index..end.scene_index)
            && self
                .text_system
                .begin_layouts_patch(start.line_layout_index.clone()..end.line_layout_index.clone())
    }

    /// Paint is over. `keep` what it painted when all else held; whether it
    /// filled its ranges exactly, shape for shape, and is kept.
    pub(crate) fn end_paint_patch(&mut self, keep: bool) -> bool {
        let tab_stops = self.next_frame.tab_stops.paint_index();
        let frame = &mut self.next_frame;
        #[cfg(any(test, feature = "test-support"))]
        let debug_bounds = frame.debug_bounds_records.end_patch();
        #[cfg(not(any(test, feature = "test-support")))]
        let debug_bounds = true;
        let held = [
            debug_bounds,
            frame.content_masks.end_patch(),
            frame.mouse_listeners.end_patch(),
            frame.input_handlers.end_patch(),
            frame.cursor_styles.end_patch(),
            frame.accessed_element_states.end_patch(),
            self.text_system.end_layouts_patch(),
        ];
        let keep = keep && held.iter().all(|held| *held) && !self.partial_failed();
        let _ = tab_stops;
        self.next_frame.scene.end_patch(keep)
    }

    /// In a partial frame, a drawing of the frame being drawn that is kept
    /// where it is (a clean retained subtree inside the one drawn again):
    /// every list steps over its prepaint.
    pub(crate) fn step_over_prepaint(&mut self, range: &Range<PrepaintStateIndex>) {
        let (start, end) = (&range.start, &range.end);
        if start.deferred_draws_index != end.deferred_draws_index {
            self.fail_partial();
        }
        let frame = &mut self.next_frame;
        frame
            .hitboxes
            .step_over(start.hitboxes_index..end.hitboxes_index);
        frame
            .hitbox_masks
            .step_over(start.hitboxes_index..end.hitboxes_index);
        frame
            .content_masks
            .step_over(start.content_masks_index..end.content_masks_index);
        frame
            .tooltip_requests
            .step_over(start.tooltips_index..end.tooltips_index);
        frame
            .accessed_element_states
            .step_over(start.accessed_element_states_index..end.accessed_element_states_index);
        frame.dispatch_tree.reuse_subtree(
            start.dispatch_tree_index..end.dispatch_tree_index,
            &mut self.rendered_frame.dispatch_tree,
            None,
        );
        self.text_system
            .reuse_layouts(start.line_layout_index.clone()..end.line_layout_index.clone());
    }

    /// The same for its paint; `absorbed`: as `Placing::absorbed`.
    pub(crate) fn step_over_paint(&mut self, range: &Range<PaintIndex>, absorbed: bool) {
        let (start, end) = (&range.start, &range.end);
        if start.tab_handle_index != end.tab_handle_index {
            self.fail_partial();
        }
        let frame = &mut self.next_frame;
        #[cfg(any(test, feature = "test-support"))]
        frame
            .debug_bounds_records
            .step_over(start.debug_bounds_index..end.debug_bounds_index);
        frame
            .content_masks
            .step_over(start.content_masks_index..end.content_masks_index);
        frame
            .mouse_listeners
            .step_over(start.mouse_listeners_index..end.mouse_listeners_index);
        frame
            .input_handlers
            .step_over(start.input_handlers_index..end.input_handlers_index);
        frame
            .cursor_styles
            .step_over(start.cursor_styles_index..end.cursor_styles_index);
        frame
            .accessed_element_states
            .step_over(start.accessed_element_states_index..end.accessed_element_states_index);
        frame
            .scene
            .patch_step_over(start.scene_index..end.scene_index, absorbed);
        self.text_system
            .reuse_layouts(start.line_layout_index.clone()..end.line_layout_index.clone());
    }

    /// `Window::prepaint_range_valid`, of the frame being drawn.
    pub(crate) fn prepaint_range_valid_now(&self, range: &Range<PrepaintStateIndex>) -> bool {
        let (start, end, frame) = (&range.start, &range.end, &self.next_frame);
        start.hitboxes_index <= end.hitboxes_index
            && end.hitboxes_index <= frame.hitboxes.len()
            && end.hitboxes_index <= frame.hitbox_masks.len()
            && start.content_masks_index <= end.content_masks_index
            && end.content_masks_index <= frame.content_masks.len()
            && start.tooltips_index <= end.tooltips_index
            && end.tooltips_index <= frame.tooltip_requests.len()
            && start.deferred_draws_index <= end.deferred_draws_index
            && end.deferred_draws_index <= frame.deferred_draws.len()
            && start.dispatch_tree_index <= end.dispatch_tree_index
            && end.dispatch_tree_index <= frame.dispatch_tree.node_count()
            && start.accessed_element_states_index <= end.accessed_element_states_index
            && end.accessed_element_states_index <= frame.accessed_element_states.len()
            && self.text_system.layouts_range_valid_now(
                &(start.line_layout_index.clone()..end.line_layout_index.clone()),
            )
    }

    /// `Window::paint_range_valid`, of the frame being drawn.
    pub(crate) fn paint_range_valid_now(&self, range: &Range<PaintIndex>) -> bool {
        let (start, end, frame) = (&range.start, &range.end, &self.next_frame);
        start.scene_index <= end.scene_index
            && end.scene_index <= frame.scene.paint_operations.len()
            && start.content_masks_index <= end.content_masks_index
            && end.content_masks_index <= frame.content_masks.len()
            && start.mouse_listeners_index <= end.mouse_listeners_index
            && end.mouse_listeners_index <= frame.mouse_listeners.len()
            && start.input_handlers_index <= end.input_handlers_index
            && end.input_handlers_index <= frame.input_handlers.len()
            && start.cursor_styles_index <= end.cursor_styles_index
            && end.cursor_styles_index <= frame.cursor_styles.len()
            && start.accessed_element_states_index <= end.accessed_element_states_index
            && end.accessed_element_states_index <= frame.accessed_element_states.len()
            && start.tab_handle_index <= end.tab_handle_index
            && end.tab_handle_index <= frame.tab_stops.insertion_history.len()
            && self.text_system.layouts_range_valid_now(
                &(start.line_layout_index.clone()..end.line_layout_index.clone()),
            )
    }

    /// What is under the pointer in the frame being drawn, now that a
    /// subtree's hitboxes were replaced: what its paint is hovered by.
    pub(crate) fn hit_test_in_place(&mut self) {
        self.mouse_hit_test = self.next_frame.hit_test(self.mouse_position);
    }
}
