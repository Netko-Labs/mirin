//! mirin: the ranges a retained subtree keeps into last frame's lists,
//! moved along when a subtree around it is copied into this frame's.

use std::ops::Range;

use crate::{PaintIndex, PrepaintStateIndex};

/// `range` (start and end per list) moved along with the range `from` it
/// lies in, now copied to start at `to`; `None` when it doesn't lie in it.
fn moved<const N: usize>(
    range: ([usize; N], [usize; N]),
    from: ([usize; N], [usize; N]),
    to: [usize; N],
) -> Option<([usize; N], [usize; N])> {
    let mut out = range;
    for index in 0..N {
        let inside = from.0[index] <= range.0[index]
            && range.0[index] <= range.1[index]
            && range.1[index] <= from.1[index];
        if !inside {
            return None;
        }
        out.0[index] = range.0[index] - from.0[index] + to[index];
        out.1[index] = range.1[index] - from.0[index] + to[index];
    }
    Some(out)
}

fn prepaint_fields(index: &PrepaintStateIndex) -> [usize; 8] {
    [
        index.hitboxes_index,
        index.tooltips_index,
        index.deferred_draws_index,
        index.dispatch_tree_index,
        index.accessed_element_states_index,
        index.line_layout_index.lines_index,
        index.line_layout_index.wrapped_lines_index,
        index.content_masks_index,
    ]
}

fn prepaint_index(fields: [usize; 8]) -> PrepaintStateIndex {
    let mut index = PrepaintStateIndex::default();
    index.hitboxes_index = fields[0];
    index.tooltips_index = fields[1];
    index.deferred_draws_index = fields[2];
    index.dispatch_tree_index = fields[3];
    index.accessed_element_states_index = fields[4];
    index.line_layout_index.lines_index = fields[5];
    index.line_layout_index.wrapped_lines_index = fields[6];
    index.content_masks_index = fields[7];
    index
}

/// A nested subtree's prepaint range moved with the one around it; `None`
/// when it doesn't lie in it (it is then drawn anew).
pub(super) fn moved_prepaint(
    range: &Range<PrepaintStateIndex>,
    from: &Range<PrepaintStateIndex>,
    to: &PrepaintStateIndex,
) -> Option<Range<PrepaintStateIndex>> {
    let (start, end) = moved(
        (prepaint_fields(&range.start), prepaint_fields(&range.end)),
        (prepaint_fields(&from.start), prepaint_fields(&from.end)),
        prepaint_fields(to),
    )?;
    Some(prepaint_index(start)..prepaint_index(end))
}

fn paint_fields(index: &PaintIndex) -> [usize; 9] {
    [
        index.scene_index,
        index.mouse_listeners_index,
        index.input_handlers_index,
        index.cursor_styles_index,
        index.accessed_element_states_index,
        index.tab_handle_index,
        index.line_layout_index.lines_index,
        index.line_layout_index.wrapped_lines_index,
        index.content_masks_index,
    ]
}

fn paint_index(fields: [usize; 9]) -> PaintIndex {
    let mut index = PaintIndex::default();
    index.scene_index = fields[0];
    index.mouse_listeners_index = fields[1];
    index.input_handlers_index = fields[2];
    index.cursor_styles_index = fields[3];
    index.accessed_element_states_index = fields[4];
    index.tab_handle_index = fields[5];
    index.line_layout_index.lines_index = fields[6];
    index.line_layout_index.wrapped_lines_index = fields[7];
    index.content_masks_index = fields[8];
    index
}

/// A nested subtree's paint range moved with the one around it.
pub(super) fn moved_paint(
    range: &Range<PaintIndex>,
    from: &Range<PaintIndex>,
    to: &PaintIndex,
) -> Option<Range<PaintIndex>> {
    let (start, end) = moved(
        (paint_fields(&range.start), paint_fields(&range.end)),
        (paint_fields(&from.start), paint_fields(&from.end)),
        paint_fields(to),
    )?;
    Some(paint_index(start)..paint_index(end))
}
