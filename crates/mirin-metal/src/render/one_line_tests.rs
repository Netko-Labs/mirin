//! Elements as GPUI lays them out, on its test platform (every char one em
//! wide).

use gpui::{div, point, prelude::*, px, size, AvailableSpace, StyledText, TestAppContext};

use super::one_line;

const NAME: &str = "Quarterly planning notes for the design review with Alex Kim";

/// Lay `text` out, one line, in a box at most 120 px wide that is sized by
/// its content (as a window's title is in its toolbar), in a 400 px row.
fn cut_in_content_sized_box(cx: &mut TestAppContext, text: StyledText) {
    let cx = cx.add_empty_window();
    cx.draw(
        point(px(0.0), px(0.0)),
        size(
            AvailableSpace::Definite(px(400.0)),
            AvailableSpace::Definite(px(40.0)),
        ),
        |_, _| {
            div().flex().flex_row().w(px(400.0)).child(
                div()
                    .flex_shrink_0()
                    .max_w(px(120.0))
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
