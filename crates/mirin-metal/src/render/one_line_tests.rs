//! Elements as GPUI lays them out, on its test platform (every char one em
//! wide).

use gpui::{div, point, prelude::*, px, size, AvailableSpace, StyledText, TestAppContext};

use super::one_line;

const NAME: &str = "Quarterly planning notes for the design review with Alex Kim";

/// Lay `text` out, one line, in a box at most 120 px wide that is sized by
/// its content (as a window's title is in its toolbar), in a 400 px row.
fn cut_in_content_sized_box(cx: &mut TestAppContext, text: StyledText) {
    cut_in_box_at_most(cx, text, 120.0);
}

/// The same, in a box at most `max` px wide.
fn cut_in_box_at_most(cx: &mut TestAppContext, text: StyledText, max: f32) {
    let cx = cx.add_empty_window();
    cx.draw(
        point(px(0.0), px(0.0)),
        size(
            AvailableSpace::Definite(px(400.0)),
            AvailableSpace::Definite(px(40.0)),
        ),
        move |_, _| {
            div().flex().flex_row().w(px(400.0)).child(
                div()
                    .flex_shrink_0()
                    .max_w(px(max))
                    .child(one_line(div()).child(text)),
            )
        },
    );
}

#[gpui::test]
fn a_one_line_text_its_box_cuts_ends_in_an_ellipsis(cx: &mut TestAppContext) {
    // Measured first at its full width (the box is sized by its content),
    // then given the box's 120 px: the line drawn is the cut one, not the
    // whole name clipped mid-word.
    let text = StyledText::new(NAME);
    let layout = text.layout().clone();
    cut_in_content_sized_box(cx, text);
    let drawn = layout.text();
    assert!(drawn.ends_with('…'), "drawn {drawn:?}");
    assert!(drawn.len() < NAME.len());
    assert!(layout.bounds().size.width <= px(120.0));
}

#[gpui::test]
fn a_one_line_text_that_fits_is_drawn_whole(cx: &mut TestAppContext) {
    let text = StyledText::new("notes.txt");
    let layout = text.layout().clone();
    cut_in_content_sized_box(cx, text);
    assert_eq!(layout.text(), "notes.txt");
}

/// The width a box centered in a 448 px column takes for `text` (as Dashi's
/// notice is over a window's content): `max` its widest, if any.
fn centered_width(cx: &mut TestAppContext, text: String, max: Option<f32>) -> gpui::Pixels {
    use std::cell::Cell;
    use std::rc::Rc;
    let seen = Rc::new(Cell::new(None));
    let drawn = Rc::clone(&seen);
    let cx = cx.add_empty_window();
    cx.draw(
        point(px(0.0), px(0.0)),
        size(
            AvailableSpace::Definite(px(448.0)),
            AvailableSpace::Definite(px(200.0)),
        ),
        move |_, _| {
            let mut boxed = div().flex().flex_col().min_w(px(120.0));
            if let Some(max) = max {
                boxed = boxed.max_w(px(max));
            }
            let row = div()
                .flex()
                .flex_row()
                .child(crate::render::flex_from_zero(div(), 1.0).child(StyledText::new(text)));
            div().flex().flex_col().items_center().w(px(448.0)).child(
                boxed.child(row).child(
                    gpui::canvas(
                        |_, _, _| {},
                        move |bounds, (), _, _| drawn.set(Some(bounds)),
                    )
                    .absolute()
                    .size_full(),
                ),
            )
        },
    );
    seen.get().expect("drawn").size.width
}

#[gpui::test]
fn a_centered_box_is_never_wider_than_its_column(cx: &mut TestAppContext) {
    // Its text is longer than the column: it takes the column's width and wraps (fit-content).
    assert_eq!(centered_width(cx, NAME.repeat(2), Some(560.0)), px(448.0));
    assert_eq!(centered_width(cx, NAME.repeat(2), None), px(448.0));
}

#[gpui::test]
fn a_short_centered_box_keeps_its_content_width(cx: &mut TestAppContext) {
    let width = centered_width(cx, "Saved.".into(), Some(560.0));
    assert!(width < px(448.0) && width >= px(120.0), "{width:?}");
}

#[gpui::test]
fn a_box_narrower_than_the_ellipsis_shows_nothing(cx: &mut TestAppContext) {
    // Not a sliver of "…" clipped at its edge (a title's detail with a few px left).
    let text = StyledText::new(NAME);
    let layout = text.layout().clone();
    cut_in_box_at_most(cx, text, 3.0);
    assert_eq!(layout.text(), "");
}
