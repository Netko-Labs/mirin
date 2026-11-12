//! mirin: a window resized, so each row is too, everything in it laid out
//! as it was: the rows nothing of which shows are left out
//! (`Plan::SkipResized`), and drawn when they show; rows that draw nothing
//! from their own size (`Retained::stretchable`) keep their drawings.

use std::collections::HashMap;

use super::{assert_same, draw, drawn, open, scrolled};
use crate::{self as gpui, RetainedDraw, TestAppContext, point, px, size};

enum Step {
    Width(f32),
    Scroll(f32),
}

const STEPS: &[Step] = &[
    Step::Width(260.0),
    Step::Width(300.0),
    // Rows that were resized out of view come in.
    Step::Scroll(150.0),
    Step::Width(240.0),
    Step::Scroll(0.0),
    Step::Width(320.0),
    Step::Scroll(300.0),
    Step::Width(300.0),
    Step::Scroll(0.0),
];

/// As `STEPS`, wide enough that the cells' text (which runs past them) stays
/// in the scroll view: a row it clips is drawn again, its cells moved each
/// on its own (`RetainedState::plan`).
const WIDE_STEPS: &[Step] = &[
    Step::Width(420.0),
    Step::Width(460.0),
    Step::Scroll(150.0),
    Step::Width(400.0),
    Step::Scroll(0.0),
    Step::Width(480.0),
    Step::Scroll(300.0),
    Step::Width(460.0),
    Step::Scroll(0.0),
];

/// Every frame drawn, and how each step drew the rows and cells.
type Run = (
    Vec<(Vec<String>, String)>,
    Vec<HashMap<RetainedDraw, usize>>,
);

fn run(cx: &mut TestAppContext, retain: bool, bare: bool, steps_run: &[Step]) -> Run {
    let mut scene = scrolled(30, 3);
    scene.bare = bare;
    let opened = open(cx, scene, retain);
    // Once more, so the rows out of view are left out.
    draw(opened.cx);
    let mut frames = Vec::new();
    let mut steps = Vec::new();
    for step in steps_run {
        let before = opened.draws.borrow().clone();
        match step {
            Step::Width(width) => {
                opened.cx.simulate_resize(size(px(*width), px(400.0)));
                opened.cx.run_until_parked();
            }
            Step::Scroll(to) => opened.scroll.set_offset(point(px(0.0), px(-to))),
        }
        draw(opened.cx);
        frames.push(drawn(opened.cx));
        let after = opened.draws.borrow();
        steps.push(
            after
                .iter()
                .map(|(draw, count)| (*draw, count - before.get(draw).copied().unwrap_or(0)))
                .collect(),
        );
    }
    (frames, steps)
}

#[gpui::test]
fn rows_resized_out_of_view_are_left_out_and_drawn_when_they_show(cx: &mut TestAppContext) {
    let (kept, steps) = run(cx, true, false, STEPS);
    let (whole, _) = run(cx, false, false, STEPS);
    for (index, (kept, whole)) in kept.iter().zip(&whole).enumerate() {
        assert_same(kept, whole, &format!("step {index}"));
    }
    // A resize draws the rows in view (each about 24 px of the 120 the
    // view shows) and some of the cells in them, not all 30 rows.
    for (index, step) in STEPS.iter().enumerate() {
        if let Step::Width(_) = step {
            let drew = steps[index]
                .get(&RetainedDraw::Redrawn)
                .copied()
                .unwrap_or(0);
            assert!(
                drew < 20,
                "step {index} drew {drew} rows: {:?}",
                steps[index]
            );
            assert!(
                steps[index][&RetainedDraw::Skipped] >= 20,
                "step {index}: {:?}",
                steps[index]
            );
        }
    }
}

#[gpui::test]
fn rows_that_draw_nothing_of_their_size_keep_their_drawings_when_resized(cx: &mut TestAppContext) {
    let (kept, steps) = run(cx, true, true, WIDE_STEPS);
    let (whole, _) = run(cx, false, true, WIDE_STEPS);
    for (index, (kept, whole)) in kept.iter().zip(&whole).enumerate() {
        assert_same(kept, whole, &format!("step {index}"));
    }
    // The rows in view are copied under the scroll view's new mask
    // (`Moved`, by nothing), the rest left out; only a row the view clips
    // (at most one at each end) is drawn again.
    for (index, step) in WIDE_STEPS.iter().enumerate() {
        let count = |draw| steps[index].get(&draw).copied().unwrap_or(0);
        if let Step::Width(_) = step {
            let what = format!("step {index}: {:?}", steps[index]);
            assert!(count(RetainedDraw::Redrawn) <= 2, "{what}");
            assert!(count(RetainedDraw::Moved) >= 3, "{what}");
            assert!(count(RetainedDraw::Skipped) >= 20, "{what}");
        }
    }
}
