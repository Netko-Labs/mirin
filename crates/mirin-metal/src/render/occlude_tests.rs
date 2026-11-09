//! An `occlude` view over a scrolling one, on GPUI's test platform: the wheel
//! over the overlay never reaches what it covers.

use gpui::{
    div, point, prelude::*, px, size, Context, ScrollDelta, ScrollHandle, ScrollWheelEvent,
    TestAppContext, VisualTestContext, Window,
};

use super::occluding;

/// A 200 px tall view whose 1000 px of content scroll, and over its top-left
/// 100 × 100 an overlay (occluding or not) with a list of its own that scrolls.
struct Scene {
    occlude: bool,
    behind: ScrollHandle,
    inner: ScrollHandle,
}

impl Render for Scene {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let list = div()
            .id("results")
            .overflow_y_scroll()
            .track_scroll(&self.inner)
            .size_full()
            .child(div().h(px(300.0)));
        let overlay = div()
            .absolute()
            .top_0()
            .left_0()
            .w(px(100.0))
            .h(px(100.0))
            .child(list);
        let overlay = if self.occlude {
            occluding(overlay)
        } else {
            overlay
        };
        div()
            .relative()
            .w(px(200.0))
            .h(px(200.0))
            .child(
                div()
                    .id("hours")
                    .overflow_y_scroll()
                    .track_scroll(&self.behind)
                    .size_full()
                    .child(div().h(px(1000.0))),
            )
            .child(overlay)
    }
}

fn draw(cx: &mut VisualTestContext, occlude: bool, behind: &ScrollHandle, inner: &ScrollHandle) {
    let (behind, inner) = (behind.clone(), inner.clone());
    cx.draw(
        point(px(0.0), px(0.0)),
        size(px(200.0), px(200.0)),
        move |_, cx| {
            cx.new(|_| Scene {
                occlude,
                behind,
                inner,
            })
        },
    );
}

fn wheel(cx: &mut VisualTestContext, x: f32, y: f32) {
    cx.simulate_event(ScrollWheelEvent {
        position: point(px(x), px(y)),
        delta: ScrollDelta::Pixels(point(px(0.0), px(-40.0))),
        ..Default::default()
    });
}

#[gpui::test]
fn the_wheel_over_an_overlay_scrolls_it_alone(cx: &mut TestAppContext) {
    let cx = cx.add_empty_window();
    let (behind, inner) = (ScrollHandle::new(), ScrollHandle::new());
    draw(cx, true, &behind, &inner);
    wheel(cx, 50.0, 50.0);
    assert_eq!(
        inner.offset().y,
        px(-40.0),
        "the overlay's own list scrolls"
    );
    assert_eq!(behind.offset().y, px(0.0), "what it covers stays");
    // Beside the overlay, the view behind scrolls as before.
    draw(cx, true, &behind, &inner);
    wheel(cx, 150.0, 150.0);
    assert_eq!(behind.offset().y, px(-40.0));
}

#[gpui::test]
fn without_occlude_both_would_scroll(cx: &mut TestAppContext) {
    // The case `occlude` guards against: GPUI scrolls every scroller under the pointer.
    let cx = cx.add_empty_window();
    let (behind, inner) = (ScrollHandle::new(), ScrollHandle::new());
    draw(cx, false, &behind, &inner);
    wheel(cx, 50.0, 50.0);
    assert_eq!(inner.offset().y, px(-40.0));
    assert_eq!(behind.offset().y, px(-40.0));
}
