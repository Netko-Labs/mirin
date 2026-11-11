//! A one-line field longer than its box scrolls sideways to keep the caret
//! in view, as a text field does: typing at the end shows the end, Home the
//! start. The text is drawn shifted by the field's `scroll` (px, from where
//! its layout puts it); after each paint the shift is checked against where
//! the caret landed, and a change draws again. A text that fits is never
//! shifted: where it sits (the left, or the right with `textAlign: "right"`)
//! is the layout's.

use std::cell::Cell;
use std::rc::Rc;

use gpui::{Bounds, Pixels, TextLayout, Window};

use crate::caret::caret_point;

/// Room kept after the text for the caret (it is drawn 1.5 px wide, right of
/// its glyph boundary): a right-aligned text ends this far in, and a scrolled
/// one never puts the caret under the field's edge.
pub(crate) const CARET_ROOM: f32 = 2.0;

/// Where a laid-out line sits and where the field shows it, in window px, as
/// drawn with the shift `scroll`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Line {
    /// The text's first and last x.
    pub left: f32,
    pub right: f32,
    /// The caret's x, when the field has the keyboard.
    pub caret: Option<f32>,
    /// What the field shows: its content box, less the caret's room at the right.
    pub shown_left: f32,
    pub shown_right: f32,
}

/// The shift that keeps `line`'s caret in view, from the shift it was drawn
/// with: none while the text fits; else the least move that shows the caret,
/// never leaving empty room past either end of the text.
pub(crate) fn follow(scroll: f32, line: Line) -> f32 {
    // Where each would be unshifted.
    let left = line.left + scroll;
    let right = line.right + scroll;
    if right - left <= line.shown_right - line.shown_left {
        return 0.0;
    }
    let mut next = scroll;
    if let Some(caret) = line.caret.map(|x| x + scroll) {
        if caret - next > line.shown_right {
            next = caret - line.shown_right;
        }
        if caret - next < line.shown_left {
            next = caret - line.shown_left;
        }
    }
    next.clamp(left - line.shown_left, right - line.shown_right)
}

/// After a paint: take the shift that keeps the caret (before byte `caret`
/// of `text`) in view in the field's padding box `field` less `padding`, and
/// draw again when it moved.
pub(crate) fn follow_after_paint(
    scroll: &Rc<Cell<f32>>,
    layout: &TextLayout,
    text: &str,
    caret: Option<usize>,
    field: Bounds<Pixels>,
    padding: f32,
    window: &mut Window,
) {
    let (Some(start), Some(end)) = (
        layout.position_for_index(0),
        layout.position_for_index(text.len()),
    ) else {
        return;
    };
    let laid: &dyn crate::caret::Laid = layout;
    let line = Line {
        left: f32::from(start.x),
        right: f32::from(end.x),
        caret: caret.and_then(|index| caret_point(laid, text, index).map(|at| f32::from(at.x))),
        shown_left: f32::from(field.left()) + padding,
        shown_right: f32::from(field.right()) - padding - CARET_ROOM,
    };
    let next = follow(scroll.get(), line);
    if (next - scroll.get()).abs() >= 0.5 {
        scroll.set(next);
        window.request_animation_frame();
    }
}

#[cfg(test)]
mod tests {
    use super::{follow, Line};

    /// A 100 px field showing 0..98, and a 300 px text drawn from `left`.
    fn line(left: f32, caret_from_start: Option<f32>) -> Line {
        Line {
            left,
            right: left + 300.0,
            caret: caret_from_start.map(|x| left + x),
            shown_left: 0.0,
            shown_right: 98.0,
        }
    }

    #[test]
    fn a_text_that_fits_is_never_shifted() {
        let fits = Line {
            left: 40.0,
            right: 90.0,
            caret: Some(90.0),
            shown_left: 0.0,
            shown_right: 98.0,
        };
        assert_eq!(follow(0.0, fits), 0.0);
        // It was shifted while longer; now it fits again.
        assert_eq!(
            follow(
                120.0,
                Line {
                    left: -80.0,
                    right: -30.0,
                    caret: Some(-30.0),
                    ..fits
                }
            ),
            0.0
        );
    }

    #[test]
    fn typing_at_the_end_shows_the_end() {
        // The caret after the last digit: the text's end meets the shown edge.
        let scroll = follow(0.0, line(0.0, Some(300.0)));
        assert_eq!(scroll, 202.0);
        // Drawn with it, nothing moves again.
        assert_eq!(follow(scroll, line(-scroll, Some(300.0))), scroll);
    }

    #[test]
    fn home_shows_the_start() {
        let scroll = follow(202.0, line(-202.0, Some(0.0)));
        assert_eq!(scroll, 0.0);
    }

    #[test]
    fn a_caret_in_view_moves_nothing() {
        // Scrolled to show 150..248; the caret at 200 is in view.
        assert_eq!(follow(150.0, line(-150.0, Some(200.0))), 150.0);
        // Past the shown right edge by 20: the least move.
        assert_eq!(follow(150.0, line(-150.0, Some(268.0))), 170.0);
    }

    #[test]
    fn no_empty_room_past_the_end() {
        // Shifted further than the text needs (it got shorter): back to its end.
        assert_eq!(follow(260.0, line(-260.0, None)), 202.0);
    }

    #[test]
    fn a_right_aligned_overflow_keeps_its_start_reachable() {
        // Laid out from the right edge (its start 202 px left of the field): Home brings it in.
        assert_eq!(follow(0.0, line(-202.0, Some(0.0))), -202.0);
    }
}
