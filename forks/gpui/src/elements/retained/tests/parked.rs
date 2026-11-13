//! mirin: a row scrolled out of view keeps its drawing (`parked`).

use super::{assert_same, draw, drawn, open, scrolled};
use crate::{self as gpui, TestAppContext, point, px};

/// Scroll to each of `stops` in turn, with retained rows; what each frame
/// drew, and how many rows and cells had been built by then.
fn scroll_through(
    cx: &mut TestAppContext,
    cells: usize,
    budget: Option<usize>,
    stops: &[f32],
) -> Vec<((Vec<String>, String), (usize, usize), usize)> {
    let scene = scrolled(30, cells);
    let builds = scene.builds.clone();
    let opened = open(cx, scene, true);
    if let Some(budget) = budget {
        opened
            .cx
            .update(|window, _| window.parking.set_budget(budget));
    }
    stops
        .iter()
        .map(|to| {
            opened.scroll.set_offset(point(px(0.0), px(-to)));
            draw(opened.cx);
            let held = opened.cx.update(|window, _| window.parking.held());
            (drawn(opened.cx), builds.get(), held)
        })
        .collect()
}

/// What drawing everything gives at each of `stops`.
fn whole_at(cx: &mut TestAppContext, cells: usize, stops: &[f32]) -> Vec<(Vec<String>, String)> {
    let opened = open(cx, scrolled(30, cells), false);
    stops
        .iter()
        .map(|to| {
            opened.scroll.set_offset(point(px(0.0), px(-to)));
            draw(opened.cx);
            drawn(opened.cx)
        })
        .collect()
}

/// Down until the first rows are well out of view and back, three times.
const THERE_AND_BACK: &[f32] = &[
    0., 70., 140., 210., 140., 70., 0., 70., 140., 210., 140., 70., 0., 210., 0.,
];

#[gpui::test]
fn rows_scrolled_out_and_back_are_copied_not_built_again(cx: &mut TestAppContext) {
    for cells in [0, 3] {
        let kept = scroll_through(cx, cells, None, THERE_AND_BACK);
        let whole = whole_at(cx, cells, THERE_AND_BACK);
        for (index, ((kept, _, _), whole)) in kept.iter().zip(&whole).enumerate() {
            assert_same(kept, whole, &format!("stop {index} with {cells} cells"));
        }
        // Once every row that shows on the way has been drawn where it
        // shows whole (the first way down and back), nothing is built for
        // coming back into view. A row with cells is itself built again
        // (it comes in clipped, and its cells are copied one by one).
        let (rows_before, cells_before) = kept[6].1;
        let (rows_after, cells_after) = kept[kept.len() - 1].1;
        assert_eq!(cells_after, cells_before, "cells, with {cells} cells");
        if cells == 0 {
            assert_eq!(rows_after, rows_before);
        }
        // Something was put aside on the way.
        assert!(kept.iter().any(|(_, _, held)| *held > 0));
    }
}

#[gpui::test]
fn drawings_put_aside_past_the_budget_are_dropped_and_built_again(cx: &mut TestAppContext) {
    for cells in [0, 3] {
        let roomy = scroll_through(cx, cells, None, THERE_AND_BACK);
        let most = roomy.iter().map(|(_, _, held)| *held).max().unwrap_or(0);
        // Room for about a third of what the way puts aside.
        let budget = most / 3;
        let tight = scroll_through(cx, cells, Some(budget), THERE_AND_BACK);
        let whole = whole_at(cx, cells, THERE_AND_BACK);
        for (index, ((tight, _, held), whole)) in tight.iter().zip(&whole).enumerate() {
            assert_same(tight, whole, &format!("stop {index} with {cells} cells"));
            assert!(*held <= budget, "{held} parked of {budget}");
        }
        // What was dropped is built again when it shows.
        let built = |frames: &[((Vec<String>, String), (usize, usize), usize)]| {
            let (rows, cells) = frames[frames.len() - 1].1;
            rows + cells
        };
        assert!(built(&tight) > built(&roomy), "with {cells} cells");
        // With no room at all nothing is put aside, as before.
        let none = scroll_through(cx, cells, Some(0), THERE_AND_BACK);
        for (index, ((none, _, held), whole)) in none.iter().zip(&whole).enumerate() {
            assert_same(none, whole, &format!("stop {index} with {cells} cells"));
            assert_eq!(*held, 0);
        }
        assert!(built(&none) > built(&tight), "with {cells} cells");
    }
}

#[gpui::test]
fn a_row_under_the_pointer_when_it_leaves_the_view_is_not_kept_hovered(cx: &mut TestAppContext) {
    // A row is hovered, scrolled out of view under a pointer that stays
    // (no move tells it), the pointer moves far below, over where another
    // row was, and both come back where they were: drawing them there shows
    // the hover on the other one.
    let run = |cx: &mut TestAppContext, retain: bool| {
        let mut scene = scrolled(60, 0);
        scene.viewport = 300.0;
        let opened = open(cx, scene, retain);
        let pointer = |cx: &mut gpui::VisualTestContext, y: f32| {
            cx.simulate_mouse_move(point(px(80.0), px(y)), None, crate::Modifiers::default());
        };
        pointer(opened.cx, 60.0);
        let mut frames = Vec::new();
        for (to, at) in [
            (0.0, None),
            (900.0, None),
            (900.0, Some(250.0)),
            (0.0, None),
        ] {
            if let Some(at) = at {
                pointer(opened.cx, at);
            }
            opened.scroll.set_offset(point(px(0.0), px(-to)));
            draw(opened.cx);
            frames.push(drawn(opened.cx));
        }
        frames
    };
    let kept = run(cx, true);
    let whole = run(cx, false);
    for (index, (kept, whole)) in kept.iter().zip(&whole).enumerate() {
        assert_same(kept, whole, &format!("frame {index}"));
    }
}
