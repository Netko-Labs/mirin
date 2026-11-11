//! Scroll views as GPUI lays them out and drives them, on its test platform:
//! how far they scroll, that they stay in range as the window changes size,
//! where the wheel goes, and the scroll bar under the pointer.

use std::{cell::RefCell, rc::Rc};

use gpui::{
    div, point, prelude::*, px, size, Context, Div, Modifiers, MouseButton, Pixels, Point,
    ScrollDelta, ScrollHandle, Stateful, TestAppContext, VisualTestContext, Window,
};

use crate::gpui_api::ScrollWheelEvent;
use crate::scrollbar::{bars_for, thumb_span, Activity, Scrolled};

/// What a test page holds: a column that scrolls, as `render.rs` draws a
/// `ScrollView` (its bars last), filling the window.
#[derive(Clone)]
struct Spec {
    rows: usize,
    row: f32,
    gap: f32,
    padding: f32,
    last_margin: f32,
    border: bool,
    /// Rows that clip their content (`overflow: hidden`, a rounded card).
    clipped: bool,
    /// Whether rows keep their length (what render.rs does in a scroll view).
    keep_length: bool,
    /// A short scroll view inside, as the second row: its height and rows.
    inner: Option<(f32, usize)>,
}

impl Default for Spec {
    fn default() -> Self {
        Spec {
            rows: 10,
            row: 50.0,
            gap: 0.0,
            padding: 0.0,
            last_margin: 0.0,
            border: false,
            clipped: false,
            keep_length: true,
            inner: None,
        }
    }
}

struct Page {
    spec: Rc<RefCell<Spec>>,
    outer: ScrollHandle,
    inner: ScrollHandle,
    activity: Activity,
}

/// A view that scrolls down.
fn down(handle: &ScrollHandle) -> Scrolled {
    Scrolled::View {
        handle: handle.clone(),
        across: false,
        down: true,
    }
}

fn scroll_view(id: &'static str, handle: &ScrollHandle, activity: Activity) -> Stateful<Div> {
    div()
        .id(id)
        .flex()
        .flex_col()
        .overflow_y_scroll()
        .track_scroll(handle)
        .child(bars_for(down(handle), activity))
}

impl Render for Page {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let spec = self.spec.borrow().clone();
        let rows = (0..spec.rows).map(|index| {
            if index == 1 {
                if let Some((height, rows)) = spec.inner {
                    let inner = div()
                        .id("inner")
                        .flex()
                        .flex_col()
                        .flex_shrink_0()
                        .h(px(height))
                        .overflow_y_scroll()
                        .track_scroll(&self.inner)
                        .children((0..rows).map(|_| div().flex_shrink_0().h(px(50.0))))
                        .child(bars_for(down(&self.inner), Activity::default()));
                    return inner.into_any_element();
                }
            }
            // A row whose length is its content's: a 50-tall line inside.
            let mut row = div()
                .flex()
                .flex_col()
                .child(div().flex_shrink_0().h(px(spec.row)));
            if spec.clipped {
                row = row.overflow_hidden();
            }
            if spec.keep_length {
                row = row.flex_shrink_0();
            }
            if index + 1 == spec.rows && spec.last_margin > 0.0 {
                row = row.mb(px(spec.last_margin));
            }
            row.into_any_element()
        });
        // The bars' canvas goes last, as render.rs puts it; children first.
        let mut page = div()
            .id("page")
            .flex()
            .flex_col()
            .flex_1()
            .min_h(px(0.0))
            .overflow_y_scroll()
            .track_scroll(&self.outer)
            .gap(px(spec.gap))
            .p(px(spec.padding))
            .children(rows)
            .child(bars_for(down(&self.outer), self.activity.clone()));
        if spec.border {
            page = page.border_1();
        }
        div().size_full().flex().flex_col().child(page)
    }
}

/// Open a page in a `width` × `height` window and draw it.
fn open(
    cx: &mut TestAppContext,
    spec: Spec,
    width: f32,
    height: f32,
) -> (
    Rc<RefCell<Spec>>,
    ScrollHandle,
    ScrollHandle,
    &mut VisualTestContext,
) {
    let spec = Rc::new(RefCell::new(spec));
    let outer = ScrollHandle::new();
    let inner = ScrollHandle::new();
    let (_, cx) = cx.add_window_view({
        let (spec, outer, inner) = (spec.clone(), outer.clone(), inner.clone());
        move |_, _| Page {
            spec,
            outer,
            inner,
            activity: Activity::default(),
        }
    });
    resize(cx, width, height);
    (spec, outer, inner, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        crate::gpui_api::draw(window, cx);
    });
}

/// The window is now `width` × `height` (a tile, a maximize, full screen).
fn resize(cx: &mut VisualTestContext, width: f32, height: f32) {
    cx.simulate_resize(size(px(width), px(height)));
    cx.run_until_parked();
    draw(cx);
}

fn max(handle: &ScrollHandle) -> f32 {
    f32::from(crate::gpui_api::scroll_max(handle).height)
}

fn scrolled(handle: &ScrollHandle) -> f32 {
    -f32::from(handle.offset().y)
}

fn wheel(cx: &mut VisualTestContext, at: Point<Pixels>, dy: f32) {
    cx.simulate_event(ScrollWheelEvent {
        position: at,
        delta: ScrollDelta::Pixels(point(px(0.0), px(dy))),
        ..Default::default()
    });
    draw(cx);
}

#[gpui::test]
fn a_scroll_view_scrolls_exactly_to_its_end(cx: &mut TestAppContext) {
    // Ten 50-tall rows in a 300-tall window: 200 past it.
    let (_, outer, _, _) = open(cx, Spec::default(), 400.0, 300.0);
    assert_eq!(max(&outer), 200.0);
}

#[gpui::test]
fn its_padding_counts_once(cx: &mut TestAppContext) {
    // 22 above and below the rows, 12 between them (Software's pages). The
    // bars' canvas at the view's corner once made the top padding count twice:
    // the page scrolled 22 past its end.
    let spec = Spec {
        padding: 22.0,
        gap: 12.0,
        ..Spec::default()
    };
    let (_, outer, _, _) = open(cx, spec, 400.0, 300.0);
    assert_eq!(max(&outer), 22.0 + 500.0 + 9.0 * 12.0 + 22.0 - 300.0);
}

#[gpui::test]
fn its_last_rows_margin_and_its_border_count(cx: &mut TestAppContext) {
    let spec = Spec {
        last_margin: 30.0,
        ..Spec::default()
    };
    let (spec, outer, _, cx) = open(cx, spec, 400.0, 300.0);
    assert_eq!(max(&outer), 500.0 + 30.0 - 300.0, "the end margin");
    spec.borrow_mut().border = true;
    draw(cx);
    assert_eq!(
        max(&outer),
        1.0 + 500.0 + 30.0 + 1.0 - 300.0,
        "and the border"
    );
}

#[gpui::test]
fn the_end_stays_in_reach_and_in_range_as_the_window_changes(cx: &mut TestAppContext) {
    let (_, outer, _, cx) = open(cx, Spec::default(), 400.0, 300.0);
    let at = point(px(100.0), px(100.0));
    wheel(cx, at, -10_000.0);
    assert_eq!(scrolled(&outer), 200.0, "the wheel stops at the end");

    // Taller (maximized): it scrolls less, and stays at its new end, not past it.
    resize(cx, 800.0, 420.0);
    assert_eq!(max(&outer), 80.0);
    assert_eq!(scrolled(&outer), 80.0);

    // Full screen, taller than the content: nothing to scroll, back at the top.
    resize(cx, 1200.0, 700.0);
    assert_eq!(max(&outer), 0.0);
    assert_eq!(scrolled(&outer), 0.0);

    // Small again: the range comes back and the end can be reached.
    resize(cx, 300.0, 180.0);
    assert_eq!(max(&outer), 320.0);
    wheel(cx, at, -10_000.0);
    assert_eq!(scrolled(&outer), 320.0);

    // Half the screen, at a fractional height: still exactly the end.
    resize(cx, 548.5, 333.5);
    assert_eq!(max(&outer), 166.5);
    assert_eq!(scrolled(&outer), 166.5);
}

#[gpui::test]
fn a_view_scrolled_between_pixels_paints_on_them_and_keeps_its_offset(cx: &mut TestAppContext) {
    // The second row is a scroll view itself: where it is painted says
    // where the page painted its rows. A test window draws two device
    // pixels to a logical one.
    let spec = Spec {
        inner: Some((120.0, 6)),
        ..Spec::default()
    };
    let (_, outer, inner, cx) = open(cx, spec, 400.0, 300.0);
    cx.update(|window, _| crate::gpui_api::set_scroll_snap(window, true));
    let at = point(px(100.0), px(20.0));
    let painted = |inner: &ScrollHandle| f32::from(inner.bounds().top());
    let near = |a: f32, b: f32| (a - b).abs() < 1e-4;
    assert_eq!(painted(&inner), 50.0);

    // A touchpad's small steps add up in the offset, which the scroll bar
    // reads; the rows move by a device pixel at a time.
    for (step, top) in [
        (1, 50.0),
        (2, 49.5),
        (3, 49.5),
        (4, 49.0),
        (5, 49.0),
        (6, 49.0),
    ] {
        wheel(cx, at, -0.2);
        assert!(near(scrolled(&outer), 0.2 * step as f32), "step {step}");
        assert!(near(down(&outer).geometry().scrolled.1, 0.2 * step as f32));
        assert_eq!(painted(&inner), top, "step {step}");
    }

    // The end is where it was (taffy lays out in device pixels, so it is
    // on one); a little back from it, the rows are on the nearest pixel.
    resize(cx, 400.0, 333.5);
    assert_eq!(max(&outer), 236.5);
    wheel(cx, at, -10_000.0);
    assert_eq!(scrolled(&outer), 236.5);
    assert_eq!(painted(&inner), 50.0 - 236.5);
    wheel(cx, at, 0.3);
    assert!(near(scrolled(&outer), 236.2));
    assert_eq!(painted(&inner), 50.0 - 236.0);

    // Without it (`MIRIN_METAL_SCROLL_SNAP=0`), painted at the offset.
    cx.update(|window, _| crate::gpui_api::set_scroll_snap(window, false));
    draw(cx);
    assert!(near(painted(&inner), 50.0 - 236.2));
}

#[gpui::test]
fn content_that_grows_later_scrolls_further(cx: &mut TestAppContext) {
    let (spec, outer, _, cx) = open(cx, Spec::default(), 400.0, 300.0);
    spec.borrow_mut().rows = 20;
    draw(cx);
    assert_eq!(max(&outer), 700.0);
    wheel(cx, point(px(100.0), px(100.0)), -10_000.0);
    assert_eq!(scrolled(&outer), 700.0);
    // And shorter again: back in range.
    spec.borrow_mut().rows = 8;
    draw(cx);
    assert_eq!((max(&outer), scrolled(&outer)), (100.0, 100.0));
}

#[gpui::test]
fn rows_that_clip_are_not_squeezed_to_fit(cx: &mut TestAppContext) {
    // A rounded card clips its content (`overflow: hidden`), which in CSS lets
    // it shrink to nothing: in a scroll view each such row was squeezed to fit
    // the window, its content cut, and the view had nothing to scroll.
    let squeezed = Spec {
        clipped: true,
        keep_length: false,
        ..Spec::default()
    };
    let (spec, outer, _, cx) = open(cx, squeezed, 400.0, 300.0);
    assert_eq!(max(&outer), 0.0, "CSS's squeeze, which render.rs avoids");
    spec.borrow_mut().keep_length = true;
    draw(cx);
    assert_eq!(max(&outer), 200.0, "each row keeps its length");
}

#[gpui::test]
fn the_wheel_scrolls_the_innermost_view_then_the_one_around_it(cx: &mut TestAppContext) {
    // A 100-tall list of six 50-tall rows, second on the page.
    let spec = Spec {
        inner: Some((100.0, 6)),
        ..Spec::default()
    };
    let (_, outer, inner, cx) = open(cx, spec, 400.0, 300.0);
    assert_eq!((max(&outer), max(&inner)), (250.0, 200.0));
    let over_list = point(px(100.0), px(75.0));
    wheel(cx, over_list, -120.0);
    assert_eq!(
        (scrolled(&inner), scrolled(&outer)),
        (120.0, 0.0),
        "the list only"
    );
    wheel(cx, over_list, -120.0);
    assert_eq!(
        (scrolled(&inner), scrolled(&outer)),
        (200.0, 0.0),
        "to its end"
    );
    wheel(cx, over_list, -60.0);
    assert_eq!(
        (scrolled(&inner), scrolled(&outer)),
        (200.0, 60.0),
        "then the page"
    );
}

#[gpui::test]
fn the_thumb_can_be_dragged(cx: &mut TestAppContext) {
    let (_, outer, _, cx) = open(cx, Spec::default(), 400.0, 300.0);
    let none = Modifiers::none();
    // Near the right edge: the bar shows, and takes the press.
    let (start, length) = thumb_span(300.0, 200.0, 0.0, 0.0).expect("a thumb");
    let on_thumb = point(px(396.0), px(start + length / 2.0));
    cx.simulate_mouse_move(on_thumb, None, none);
    draw(cx);
    cx.simulate_mouse_down(on_thumb, MouseButton::Left, none);
    draw(cx);
    // Halfway down its run, and the view is halfway down its content.
    let run = 300.0 - 6.0 - length;
    let halfway = point(px(396.0), on_thumb.y + px(run / 2.0));
    cx.simulate_mouse_move(halfway, Some(MouseButton::Left), none);
    draw(cx);
    assert!(
        (scrolled(&outer) - 100.0).abs() < 0.5,
        "{}",
        scrolled(&outer)
    );
    // Past the end, and away from the bar: still held, at the end.
    let past = point(px(200.0), px(900.0));
    cx.simulate_mouse_move(past, Some(MouseButton::Left), none);
    draw(cx);
    assert_eq!(scrolled(&outer), 200.0);
    cx.simulate_mouse_up(past, MouseButton::Left, none);
    draw(cx);
    // Let go: moving again scrolls nothing.
    cx.simulate_mouse_move(point(px(396.0), px(10.0)), None, none);
    draw(cx);
    assert_eq!(scrolled(&outer), 200.0);
}

#[gpui::test]
fn a_press_on_the_track_pages(cx: &mut TestAppContext) {
    let spec = Spec {
        rows: 40,
        ..Spec::default()
    };
    let (_, outer, _, cx) = open(cx, spec, 400.0, 300.0);
    let none = Modifiers::none();
    let below_thumb = point(px(396.0), px(280.0));
    cx.simulate_mouse_move(below_thumb, None, none);
    draw(cx);
    cx.simulate_click(below_thumb, none);
    draw(cx);
    assert_eq!(scrolled(&outer), 300.0 - 24.0, "a page down");
    let above_thumb = point(px(396.0), px(5.0));
    cx.simulate_mouse_move(above_thumb, None, none);
    draw(cx);
    cx.simulate_click(above_thumb, none);
    draw(cx);
    assert_eq!(scrolled(&outer), 0.0, "and back up");
}

#[gpui::test]
fn the_bar_takes_only_presses_on_it(cx: &mut TestAppContext) {
    use std::cell::Cell;
    // A row as wide as the view, under the bar's band.
    struct Row(ScrollHandle, Rc<Cell<u32>>, Activity);
    impl Render for Row {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let presses = self.1.clone();
            scroll_view("page", &self.0, self.2.clone())
                .size_full()
                .child(
                    div()
                        .id("row")
                        .flex_shrink_0()
                        .h(px(900.0))
                        .on_mouse_down(MouseButton::Left, move |_, _, _| {
                            presses.set(presses.get() + 1)
                        }),
                )
        }
    }
    let presses = Rc::new(Cell::new(0));
    let handle = ScrollHandle::new();
    let (_, cx) = cx.add_window_view({
        let (presses, handle) = (presses.clone(), handle.clone());
        move |_, _| Row(handle, presses, Activity::default())
    });
    resize(cx, 400.0, 300.0);
    let none = Modifiers::none();
    let press = |cx: &mut VisualTestContext, at: Point<Pixels>| {
        cx.simulate_mouse_move(at, None, none);
        draw(cx);
        cx.simulate_mouse_down(at, MouseButton::Left, none);
        cx.simulate_mouse_up(at, MouseButton::Left, none);
        draw(cx);
    };
    press(cx, point(px(100.0), px(200.0)));
    assert_eq!(presses.get(), 1, "the row has a press away from the edge");
    press(cx, point(px(396.0), px(200.0)));
    assert_eq!(presses.get(), 1, "the bar has one on it");
    assert!(scrolled(&handle) > 0.0, "and pages");
    // Just inside the band's edge, still the row's.
    press(cx, point(px(400.0 - 15.0), px(200.0)));
    assert_eq!(presses.get(), 2);
}

#[test]
fn a_scroll_views_children_keep_their_length_unless_they_ask() {
    use super::{keeps_length_in_scroll, scrolls_along_its_direction};
    use crate::tree::{Direction, ViewProps};
    let column = ViewProps {
        scroll: true,
        ..ViewProps::default()
    };
    assert!(scrolls_along_its_direction(&column));
    let across = ViewProps {
        scroll: true,
        direction: Direction::Row,
        ..ViewProps::default()
    };
    assert!(
        !scrolls_along_its_direction(&across),
        "a row that scrolls down"
    );
    assert!(keeps_length_in_scroll(&ViewProps::default()));
    for asks in [
        ViewProps {
            flex: 1.0,
            ..ViewProps::default()
        },
        ViewProps {
            grow: 1.0,
            ..ViewProps::default()
        },
        ViewProps {
            shrink: Some(true),
            ..ViewProps::default()
        },
    ] {
        assert!(!keeps_length_in_scroll(&asks));
    }
}

#[gpui::test]
fn content_wider_than_a_view_that_scrolls_down_has_no_bar_across(cx: &mut TestAppContext) {
    struct Wide(ScrollHandle);
    impl Render for Wide {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            scroll_view("page", &self.0, Activity::default())
                .size_full()
                .child(div().flex_shrink_0().w(px(900.0)).h(px(900.0)))
        }
    }
    let handle = ScrollHandle::new();
    let (_, cx) = cx.add_window_view({
        let handle = handle.clone();
        move |_, _| Wide(handle)
    });
    resize(cx, 400.0, 300.0);
    assert!(
        f32::from(crate::gpui_api::scroll_max(&handle).width) > 0.0,
        "GPUI measures it"
    );
    let geometry = down(&handle).geometry();
    assert_eq!(geometry.overflow, (0.0, 600.0));
    assert_eq!(crate::scrollbar::bars(&geometry).len(), 1);
}

#[gpui::test]
fn the_pointer_near_the_edge_shows_the_bar_until_it_leaves_the_window(cx: &mut TestAppContext) {
    use crate::scrollbar::Axis;
    struct Near(ScrollHandle, Activity);
    impl Render for Near {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            scroll_view("page", &self.0, self.1.clone())
                .size_full()
                .child(div().flex_shrink_0().h(px(900.0)))
        }
    }
    let activity = Activity::default();
    let (_, cx) = cx.add_window_view({
        let activity = activity.clone();
        move |_, _| Near(ScrollHandle::new(), activity)
    });
    resize(cx, 400.0, 300.0);
    let none = Modifiers::none();
    cx.simulate_mouse_move(point(px(200.0), px(100.0)), None, none);
    draw(cx);
    assert!(!activity.active(Axis::Vertical), "away from the edge");
    cx.simulate_mouse_move(point(px(392.0), px(100.0)), None, none);
    draw(cx);
    assert!(activity.active(Axis::Vertical), "in the band");
    cx.simulate_event(gpui::MouseExitEvent {
        position: point(px(399.0), px(100.0)),
        pressed_button: None,
        modifiers: none,
    });
    draw(cx);
    assert!(!activity.active(Axis::Vertical), "out of the window");
}
