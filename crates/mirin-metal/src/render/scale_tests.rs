//! Lengths that are fractions of a device pixel, laid out by GPUI on its
//! test platform (a scale factor of 2, so a quarter of a logical pixel is
//! half a device pixel): what a window at 1.25 or 1.5 has everywhere. Both
//! builds lay such lengths out as authored and round only the edges that
//! result; upstream GPUI rounded each length before layout.

use std::{cell::RefCell, rc::Rc};

use gpui::{div, prelude::*, px, size, Bounds, Context, Pixels, TestAppContext, Window};

/// A column of three rows 10 px tall, 3.25 px apart, inside 1.25 px of padding.
struct Column {
    rows: Rc<RefCell<Vec<Bounds<Pixels>>>>,
}

impl Render for Column {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let rows = self.rows.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .p(px(1.25))
            .gap(px(3.25))
            .on_children_prepainted(move |bounds, _, _| *rows.borrow_mut() = bounds)
            .children((0..3).map(|_| div().h(px(10.0)).w(px(20.0)).flex_none()))
    }
}

#[gpui::test]
fn lengths_of_a_fraction_of_a_device_pixel_are_laid_out_as_authored(cx: &mut TestAppContext) {
    let rows = Rc::new(RefCell::new(Vec::new()));
    let seen = rows.clone();
    let (_view, cx) = cx.add_window_view(|_, _| Column { rows: seen });
    assert_eq!(cx.update(|window, _| window.scale_factor()), 2.0);
    cx.simulate_resize(size(px(200.0), px(200.0)));
    cx.run_until_parked();
    cx.update(|window, cx| {
        let _ = window.draw(cx);
    });
    let rows = rows.borrow();
    let places: Vec<(f32, f32, f32)> = rows
        .iter()
        .map(|row| (f32::from(row.origin.x), f32::from(row.origin.y), f32::from(row.size.height)))
        .collect();
    // In device pixels the padding is 2.5 and the rows start at 2.5, 29 and
    // 55.5, each 20 tall: their edges round (halves away from zero) to 3,
    // 29 and 56. Rounding the padding and the gap first (to 2 and 6, as
    // upstream GPUI does) puts them at 2, 28 and 54: 1, 14 and 27 px.
    assert_eq!(places, [(1.5, 1.5, 10.0), (1.5, 14.5, 10.0), (1.5, 28.0, 10.0)]);
}
