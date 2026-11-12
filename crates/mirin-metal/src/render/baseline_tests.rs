//! Texts of two sizes in one row, laid out by GPUI on its test platform.

use std::cell::Cell;
use std::rc::Rc;

use gpui::{div, point, prelude::*, px, size, AvailableSpace, Pixels, StyledText, TestAppContext};

use crate::tree::{parse_tree, Align, NodeSpec};

/// Where the baselines of an 11 px text and a 13 px text are on screen, side
/// by side in a 40 px tall row: (small, large), from the row's top.
fn baselines(cx: &mut TestAppContext, on_baseline: bool) -> (Pixels, Pixels) {
    let small = StyledText::new("Edited today");
    let large = StyledText::new("Notes");
    let (small_layout, large_layout) = (small.layout().clone(), large.layout().clone());
    let offsets = Rc::new(Cell::new((px(0.0), px(0.0))));
    let seen = Rc::clone(&offsets);
    let cx = cx.add_empty_window();
    cx.draw(
        point(px(0.0), px(0.0)),
        size(
            AvailableSpace::Definite(px(400.0)),
            AvailableSpace::Definite(px(40.0)),
        ),
        move |window, _| {
            // Where GPUI paints each first line's baseline under its text's top.
            let style = window.text_style();
            let font = window.text_system().resolve_font(&style.font());
            let under = |font_size: f32| {
                let height = style
                    .line_height
                    .to_pixels(px(font_size).into(), window.rem_size());
                window
                    .text_system()
                    .baseline_offset(font, px(font_size), height)
            };
            seen.set((under(11.0), under(13.0)));
            let row = div().flex().flex_row().w(px(400.0)).h(px(40.0));
            let row = if on_baseline {
                row.items_baseline()
            } else {
                row.items_center()
            };
            row.child(div().text_size(px(13.0)).child(large))
                .child(div().text_size(px(11.0)).child(small))
        },
    );
    let (small_under, large_under) = offsets.get();
    (
        small_layout.bounds().origin.y + small_under,
        large_layout.bounds().origin.y + large_under,
    )
}

#[gpui::test]
fn a_row_that_aligns_baselines_puts_small_text_on_the_larger_text_s_baseline(
    cx: &mut TestAppContext,
) {
    let (small, large) = baselines(cx, true);
    assert!(
        (small - large).abs() <= px(0.5),
        "{small:?} beside {large:?}"
    );
}

#[gpui::test]
fn a_centered_row_leaves_the_small_text_high(cx: &mut TestAppContext) {
    // What Dashi's rows did: the boxes are centered, so the smaller text's
    // baseline is above the larger one's.
    let (small, large) = baselines(cx, false);
    assert!(small < large, "{small:?} beside {large:?}");
}

#[test]
fn a_view_can_ask_for_baseline_alignment() {
    let tree = parse_tree(
        r#"{"type":"view","props":{"id":"1","direction":"row","align":"baseline"},"children":[]}"#,
    )
    .expect("valid tree must parse");
    let NodeSpec::View { props, .. } = tree else {
        panic!("a view");
    };
    assert_eq!(props.align, Some(Align::Baseline));
}
