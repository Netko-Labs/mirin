//! A pulsing view drawn through the host's own `RootView` on GPUI's test
//! platform: it asks for its next step with one timer, never for the next
//! frame, and stands still under Reduce Motion. The only test that turns
//! Reduce Motion on and off (it is the host's, shared by every test).

use std::sync::mpsc;
use std::time::Duration;

use sumi::{px, size, TestAppContext};

use super::{reduced, set_reduce_motion};
use crate::events::EventSender;
use crate::patch::Document;
use crate::sim::LayoutMap;
use crate::tree::parse_tree;
use crate::window::RootView;

/// A "Now" tag breathing at 2 steps a second.
const TAG: &str = r##"{"type":"view","props":{"id":"1"},"children":[
  {"type":"view","props":{"id":"now","width":30,"height":12,"background":"#6e56cf",
    "pulse":{"from":0.4,"to":1,"periodMs":2000,"fps":2}}}]}"##;

/// The tag's fill's alpha in the last frame drawn.
fn tag_alpha(drawn: &[String]) -> f32 {
    let quad = drawn
        .iter()
        .find(|line| line.starts_with("Quad"))
        .expect("the tag is drawn");
    let alpha = quad
        .split("background: Solid(Hsla {")
        .nth(1)
        .and_then(|rest| rest.split("a: ").nth(1))
        .and_then(|rest| rest.split([' ', '}']).next())
        .expect("a solid fill");
    alpha.parse().expect("a number")
}

#[sumi::test]
fn a_pulse_asks_for_its_next_step_and_stands_still_under_reduce_motion(cx: &mut TestAppContext) {
    let tree = parse_tree(TAG).expect("the tag parses");
    let (tx, _rx) = mpsc::channel();
    let layout = LayoutMap::default();
    let events = EventSender::new(tx, layout.clone());
    let (view, cx) =
        cx.add_window_view(|_, cx| RootView::new(Document::new(tree), false, events, layout, cx));
    cx.simulate_resize(size(px(100.0), px(40.0)));
    assert!(set_reduce_motion(false) || !reduced());
    let draw = |cx: &mut sumi::VisualTestContext| {
        cx.update(|window, cx| {
            let _ = window.draw(cx);
            window.last_scene_drawn()
        })
    };
    let timers =
        |cx: &mut sumi::VisualTestContext| view.read_with(cx, |view, _| view.pulses.timers());
    draw(cx);
    let (waiting, armed) = timers(cx);
    assert!(waiting, "a timer waits for the next step");
    // Another frame before the step (a hover, a tree) starts no second timer.
    cx.update(|window, _| window.refresh());
    draw(cx);
    assert_eq!(timers(cx), (true, armed));
    // Its step comes: the timer has the window rendered again, and that frame waits for the next.
    cx.executor().advance_clock(Duration::from_millis(600));
    cx.run_until_parked();
    let drawn = draw(cx);
    assert_eq!(timers(cx), (true, armed + 1));
    let alpha = tag_alpha(&drawn);
    assert!((0.4..=1.0).contains(&alpha), "{alpha}");

    // Reduce Motion: the tag stands at full and asks for nothing.
    assert!(set_reduce_motion(true), "turning it on draws again");
    assert!(!set_reduce_motion(true), "the same again changes nothing");
    cx.executor().advance_clock(Duration::from_millis(600));
    cx.run_until_parked();
    let drawn = draw(cx);
    assert_eq!(tag_alpha(&drawn), 1.0);
    let (_, still) = timers(cx);
    cx.executor().advance_clock(Duration::from_secs(5));
    cx.run_until_parked();
    draw(cx);
    assert_eq!(timers(cx), (false, still), "no step is asked for");
    assert!(set_reduce_motion(false));
}
