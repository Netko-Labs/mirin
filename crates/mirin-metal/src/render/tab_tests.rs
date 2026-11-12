//! Tab stops (docs/metal.md, "Tab stops"): what follows a tab starts at the
//! next stop, and the caret, the selection, a click and the wrap follow. On
//! GPUI's test platform every char is as wide as the font's `0`.

use gpui::{
    apply_tab_stops, div, point, prelude::*, px, size, AvailableSpace, FontId, GlyphId, LineLayout,
    Pixels, ShapedGlyph, ShapedRun, StyledText, TestAppContext, TextLayout, TextStyle,
};

use crate::caret::{caret_bar, selection_rects, Laid};

/// `text` laid out in a box `width` wide, with its tab size if given.
fn laid(
    cx: &mut TestAppContext,
    text: &'static str,
    tab_size: Option<u32>,
    width: f32,
) -> TextLayout {
    let mut text = StyledText::new(text);
    if let Some(tab_size) = tab_size {
        text = text.with_tab_size(tab_size);
    }
    let layout = text.layout().clone();
    let cx = cx.add_empty_window();
    cx.draw(
        point(px(0.0), px(0.0)),
        size(
            AvailableSpace::Definite(px(width)),
            AvailableSpace::Definite(px(400.0)),
        ),
        move |_, _| div().w(px(width)).child(text),
    );
    layout
}

fn x(layout: &TextLayout, index: usize) -> f32 {
    f32::from(layout.position(index).expect("the byte is in the text").x)
}

/// Any glyph's id: only GPUI makes one.
fn glyph(cx: &mut TestAppContext) -> GlyphId {
    let run = TextStyle::default().to_run(1);
    let cx = cx.add_empty_window();
    let line = cx.update(|window, _| {
        window
            .text_system()
            .layout_line("a", px(10.0), &[run], None)
    });
    line.runs[0].glyphs[0].id
}

/// A shaped line of one font, a glyph per byte at `places`.
fn shaped(id: GlyphId, text: &str, places: &[f32], width: f32) -> LineLayout {
    LineLayout {
        font_size: px(10.0),
        width: px(width),
        ascent: px(8.0),
        descent: px(2.0),
        runs: vec![ShapedRun {
            font_id: FontId(0),
            glyphs: places
                .iter()
                .enumerate()
                .map(|(index, &place)| ShapedGlyph {
                    id,
                    position: point(px(place), px(0.0)),
                    index,
                    is_emoji: false,
                })
                .collect(),
        }],
        len: text.len(),
    }
}

fn places(layout: &LineLayout) -> Vec<f32> {
    layout.runs[0]
        .glyphs
        .iter()
        .map(|glyph| f32::from(glyph.position.x))
        .collect()
}

#[gpui::test]
fn what_follows_a_tab_starts_at_the_next_stop_and_keeps_its_own_advances(cx: &mut TestAppContext) {
    let id = glyph(cx);
    // "ab\tc\td", every glyph 10 wide as shaped; stops every 40.
    let text = "ab\tc\td";
    let mut layout = shaped(id, text, &[0.0, 10.0, 20.0, 30.0, 40.0, 50.0], 60.0);
    apply_tab_stops(&mut layout, text, |_| px(40.0));
    assert_eq!(places(&layout), [0.0, 10.0, 20.0, 40.0, 50.0, 80.0]);
    assert_eq!(layout.width, px(90.0));
}

#[gpui::test]
fn a_tab_on_a_stop_goes_to_the_next_one_and_a_hair_short_of_a_stop_is_on_it(
    cx: &mut TestAppContext,
) {
    let id = glyph(cx);
    let text = "abcd\te";
    let mut layout = shaped(id, text, &[0.0, 10.0, 20.0, 30.0, 40.0, 50.0], 60.0);
    apply_tab_stops(&mut layout, text, |_| px(40.0));
    assert_eq!(places(&layout)[5], 80.0);
    // Advances that sum to 39.995: the tab is not a 0.005 px sliver.
    let mut layout = shaped(id, text, &[0.0, 10.0, 20.0, 30.0, 39.995, 50.0], 60.0);
    apply_tab_stops(&mut layout, text, |_| px(40.0));
    assert_eq!(places(&layout)[5], 80.0);
}

#[gpui::test]
fn a_line_without_a_tab_or_set_right_to_left_is_left_as_shaped(cx: &mut TestAppContext) {
    let id = glyph(cx);
    let mut plain = shaped(id, "abc", &[0.0, 7.0, 19.0], 30.0);
    apply_tab_stops(&mut plain, "abc", |_| px(40.0));
    assert_eq!(places(&plain), [0.0, 7.0, 19.0]);
    assert_eq!(plain.width, px(30.0));
    let mut rtl = shaped(id, "a\tb", &[20.0, 10.0, 0.0], 30.0);
    apply_tab_stops(&mut rtl, "a\tb", |_| px(40.0));
    assert_eq!(places(&rtl), [20.0, 10.0, 0.0]);
}

#[gpui::test]
fn columns_line_up_after_a_tab_every_four_chars_by_default(cx: &mut TestAppContext) {
    // Two lines whose first words differ in length: their second words start at one x.
    let layout = laid(cx, "ab\tAlex\nabc\tLisbon", None, 600.0);
    let char = x(&layout, 1);
    assert!(char > 0.0);
    assert_eq!(x(&layout, 3), 4.0 * char);
    assert_eq!(x(&layout, 12), 4.0 * char);
}

#[gpui::test]
fn a_field_can_set_its_own_tab_size(cx: &mut TestAppContext) {
    let layout = laid(cx, "ab\tc", Some(8), 600.0);
    let char = x(&layout, 1);
    assert_eq!(x(&layout, 3), 8.0 * char);
    let layout = laid(cx, "ab\tc", Some(2), 600.0);
    // "ab" ends on a stop of 2: the tab goes to the next.
    assert_eq!(x(&layout, 3), 4.0 * char);
}

#[gpui::test]
fn the_caret_the_selection_and_a_click_follow_the_tab(cx: &mut TestAppContext) {
    let text = "ab\tc";
    let layout = laid(cx, text, None, 600.0);
    let char = x(&layout, 1);
    let line = Laid::line_height(&layout);
    // The caret after the tab is at the stop, where "c" starts.
    let caret = caret_bar(&layout, text, 3, px(1.5)).expect("a caret");
    assert_eq!(f32::from(caret.origin.x), 4.0 * char);
    // A selected tab is washed as wide as it is drawn: from "b"'s end to the stop.
    let rects = selection_rects(&layout, text, 2..3, px(0.0));
    assert_eq!(rects.len(), 1);
    assert_eq!(f32::from(rects[0].origin.x), 2.0 * char);
    assert_eq!(f32::from(rects[0].size.width), 2.0 * char);
    // A click anywhere in the tab's room is on the tab; past the stop, on "c".
    let at = |x: f32| -> Pixels { px(x * char) };
    assert_eq!(layout.hit(point(at(2.5), line / 2.0)), 2);
    assert_eq!(layout.hit(point(at(3.5), line / 2.0)), 2);
    assert_eq!(layout.hit(point(at(4.5), line / 2.0)), 3);
}

#[gpui::test]
fn a_line_breaks_after_a_tab_as_after_a_space(cx: &mut TestAppContext) {
    // "abcde", a tab to the stop at 8, then a word that no longer fits in 9 chars.
    let probe = laid(cx, "ab", None, 600.0);
    let char = x(&probe, 1);
    let layout = laid(cx, "abcde\tfghij", None, 9.0 * char);
    let lines: Vec<String> = layout.wrapped_text().lines().map(str::to_owned).collect();
    assert_eq!(lines, ["abcde\t", "fghij"]);
}
