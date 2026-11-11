//! mirin: a drawing moves by whole device pixels, at any scale factor, and
//! a scroll view paints its content on them.

use std::collections::HashMap;

use super::{Scene, assert_same, compare_at, draw, drawn, open_at, scrolled};
use crate::{self as gpui, RetainedDraw, TestAppContext, point, px};

fn count(draws: &HashMap<RetainedDraw, usize>, draw: RetainedDraw) -> usize {
    draws.get(&draw).copied().unwrap_or(0)
}

/// Scrolls that land between pixels, a row growing, and a way back.
const UNEVEN_STEPS: &[&dyn Fn(&mut Scene) -> Option<f32>] = &[
    &|_| None,
    &|_| Some(8.0),
    &|_| Some(17.3),
    &|_| Some(21.9),
    &|_| Some(260.4),
    &|_| Some(231.0),
    &|scene| {
        scene.rows[3].height = 41.0;
        scene.rows[3].version += 1;
        None
    },
    &|_| Some(0.0),
    &|_| Some(40.5),
    &|_| Some(41.5),
    &|_| Some(42.0),
    &|_| Some(60.9),
    &|_| Some(13.3),
];

#[gpui::test]
fn rows_move_by_whole_device_pixels_at_any_scale_factor(cx: &mut TestAppContext) {
    // A scroll view that paints at whole device pixels moves its rows by
    // whole device pixels whatever a logical pixel is: 2 is exact, the rest
    // lose a little at every position, and 1.1 is not even a fraction a
    // float holds.
    for scale in [1.0, 2.0, 1.25, 1.5, 1.75, 3.0, 1.1] {
        let draws = compare_at(cx, scrolled(30, 3), scale, true, UNEVEN_STEPS);
        // At 1.1 a row's shadow, a logical pixel below its box, is snapped
        // to the grid (`Grid::snap_distance`): the rows move there too.
        assert!(
            count(&draws, RetainedDraw::Moved) > 60,
            "{scale}: {draws:?}"
        );
        assert!(
            count(&draws, RetainedDraw::Skipped) > 100,
            "{scale}: {draws:?}"
        );
        // Without cells, a row is one drawing.
        let draws = compare_at(cx, scrolled(30, 0), scale, true, UNEVEN_STEPS);
        assert!(
            count(&draws, RetainedDraw::Moved) >= 30,
            "{scale}: {draws:?}"
        );
    }
}

#[gpui::test]
fn rows_scrolled_between_device_pixels_are_drawn_where_they_land(cx: &mut TestAppContext) {
    // Painted at the offset itself (no snapping): what does not land a
    // whole number of device pixels away is drawn again, at any scale.
    for scale in [1.0, 1.25, 1.5, 1.75, 3.0] {
        let draws = compare_at(cx, scrolled(30, 3), scale, false, UNEVEN_STEPS);
        assert!(
            count(&draws, RetainedDraw::Redrawn) > 20,
            "{scale}: {draws:?}"
        );
    }
}

#[gpui::test]
fn small_wheel_steps_add_up_to_whole_pixel_moves(cx: &mut TestAppContext) {
    use crate::{Modifiers, ScrollDelta, ScrollWheelEvent, TouchPhase};
    // A touchpad's steps of a fraction of a pixel: the offset keeps them
    // all, and the rows are painted at the nearest device pixel.
    const STEP: f32 = 0.3;
    const STEPS: usize = 40;
    for scale in [1.0, 1.5, 2.0] {
        let wheeled = |cx: &mut TestAppContext, retain: bool| {
            let opened = open_at(cx, scrolled(30, 3), retain, scale, true);
            // The pointer rests where the wheel turns, over a row.
            opened
                .cx
                .simulate_mouse_move(point(px(100.0), px(60.0)), None, Modifiers::default());
            let mut frames = Vec::new();
            for _ in 0..STEPS {
                opened.cx.simulate_event(ScrollWheelEvent {
                    position: point(px(100.0), px(60.0)),
                    delta: ScrollDelta::Pixels(point(px(0.0), px(-STEP))),
                    modifiers: Modifiers::default(),
                    touch_phase: TouchPhase::Moved,
                });
                draw(opened.cx);
                frames.push((drawn(opened.cx), opened.scroll.offset().y.0));
            }
            (frames, opened.draws.borrow().clone())
        };
        let (kept, draws) = wheeled(cx, true);
        // Nothing lost: forty steps of 0.3 are twelve pixels.
        let offset = kept.last().map_or(0.0, |(_, offset)| *offset);
        assert!((offset + STEP * STEPS as f32).abs() < 1e-3, "{offset}");
        // What a view scrolled to each rounded offset paints, drawn whole
        // and without snapping.
        let expected = open_at(cx, scrolled(30, 3), false, scale, false);
        expected
            .cx
            .simulate_mouse_move(point(px(100.0), px(60.0)), None, Modifiers::default());
        let mut device = 0.0f32;
        let mut moves = 0;
        for (index, (frame, offset)) in kept.iter().enumerate() {
            let rounded = (offset * scale).round();
            moves += usize::from(rounded != device);
            device = rounded;
            expected
                .scroll
                .set_offset(point(px(0.0), px(rounded / scale)));
            draw(expected.cx);
            assert_same(
                frame,
                &drawn(expected.cx),
                &format!("step {index} at {scale}"),
            );
        }
        assert!(moves.abs_diff((STEP * STEPS as f32 * scale).round() as usize) <= 1);
        // Every row in view moved once per pixel, and stayed otherwise.
        assert!(
            count(&draws, RetainedDraw::Moved) >= moves,
            "{scale}: {draws:?}"
        );
        assert!(
            count(&draws, RetainedDraw::Reused) > STEPS - moves,
            "{scale}: {draws:?}"
        );
    }
}

// mirin: text moves across too (`Window::paint_line_glyph`).
#[gpui::test]
fn rows_with_text_move_across_by_whole_device_pixels(cx: &mut TestAppContext) {
    // The rows side by side, each with its text and cells of text, in a
    // view that scrolls across: a glyph lands on the same subpixel position
    // a whole number of device pixels away, so they are copied there.
    for scale in [1.0, 2.0, 1.25, 1.5, 3.0, 1.1] {
        let mut scene = scrolled(30, 3);
        scene.across = true;
        scene.viewport = 200.0;
        let draws = compare_at(cx, scene.clone(), scale, true, UNEVEN_STEPS);
        assert!(
            count(&draws, RetainedDraw::Moved) > 60,
            "{scale}: {draws:?}"
        );
        scene.cells = 0;
        let draws = compare_at(cx, scene, scale, true, UNEVEN_STEPS);
        assert!(
            count(&draws, RetainedDraw::Moved) > 30,
            "{scale}: {draws:?}"
        );
    }
}
