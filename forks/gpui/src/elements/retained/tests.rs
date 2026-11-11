//! mirin: retained subtrees draw what drawing everything would.

use std::{cell::RefCell, rc::Rc};

use crate::{
    self as gpui, AnyElement, AppContext, Context, Entity, InteractiveElement, IntoElement,
    ParentElement, Render, Styled, TestAppContext, VisualTestContext, Window, div, px, retained,
    rgb, size,
};

#[derive(Clone)]
struct Row {
    color: u32,
    height: f32,
    version: u64,
}

struct Marker;

struct Rows {
    rows: Rc<RefCell<Vec<Row>>>,
    markers: Vec<Entity<Marker>>,
    retain: bool,
}

fn row(index: usize, row: Row) -> AnyElement {
    div()
        .id(("row", index))
        .flex()
        .gap_1()
        .h(px(row.height))
        .bg(rgb(row.color))
        .hover(|style| style.bg(rgb(0xff0000)))
        .child(format!("row {index}"))
        .child(div().size(px(6.0)).bg(rgb(0x00ff00)))
        .into_any_element()
}

impl Render for Rows {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let rows = self.rows.borrow().clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .gap(px(2.5))
            .p(px(3.3))
            .children(rows.into_iter().enumerate().map(|(index, spec)| {
                if self.retain {
                    let version = spec.version;
                    retained(
                        ("kept", index),
                        self.markers[index].entity_id(),
                        version,
                        move |_, _| row(index, spec),
                    )
                    .into_any_element()
                } else {
                    row(index, spec)
                }
            }))
    }
}

fn rows(count: usize) -> Vec<Row> {
    (0..count)
        .map(|index| Row {
            color: 0x101010 * (index as u32 % 15 + 1),
            height: 10.0 + (index % 3) as f32 * 0.4,
            version: 1,
        })
        .collect()
}

fn open(
    cx: &mut TestAppContext,
    rows: Vec<Row>,
    retain: bool,
) -> (Rc<RefCell<Vec<Row>>>, &mut VisualTestContext) {
    let shared = Rc::new(RefCell::new(rows));
    let count = shared.borrow().len();
    let (_, cx) = cx.add_window_view({
        let shared = shared.clone();
        move |_, cx| Rows {
            rows: shared,
            markers: (0..count).map(|_| cx.new(|_| Marker)).collect(),
            retain,
        }
    });
    cx.simulate_resize(size(px(300.0), px(400.0)));
    cx.run_until_parked();
    draw(cx);
    (shared, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}

/// What the last frame drew: its quads and glyphs, and its hitboxes.
fn drawn(cx: &mut VisualTestContext) -> (String, String, String) {
    cx.update(|window, _| {
        let frame = &window.rendered_frame;
        let hitboxes: Vec<_> = frame
            .hitboxes
            .iter()
            .map(|hitbox| (hitbox.bounds, hitbox.content_mask.clone()))
            .collect();
        (
            format!("{:?}", frame.scene.quads),
            format!("{:?}", frame.scene.monochrome_sprites),
            format!("{hitboxes:?}"),
        )
    })
}

#[gpui::test]
fn kept_and_redrawn_rows_draw_what_drawing_everything_does(cx: &mut TestAppContext) {
    let (shared, kept) = open(cx, rows(12), true);
    // Nothing changes: the rows are reused.
    draw(kept);
    // One row's color: it alone is built again.
    {
        let mut rows = shared.borrow_mut();
        rows[4].color = 0x123456;
        rows[4].version += 1;
    }
    draw(kept);
    let recolored = drawn(kept);
    // One row grows: the rows below move and are drawn where they land.
    {
        let mut rows = shared.borrow_mut();
        rows[2].height = 23.7;
        rows[2].version += 1;
    }
    draw(kept);
    let moved = drawn(kept);
    // Again, unchanged, now reusing the moved rows' drawings.
    draw(kept);
    let again = drawn(kept);

    let mut expected = rows(12);
    expected[4].color = 0x123456;
    let (_, whole) = open(cx, expected.clone(), false);
    assert_eq!(recolored, drawn(whole));
    expected[2].height = 23.7;
    let (_, whole) = open(cx, expected, false);
    let whole = drawn(whole);
    assert_eq!(moved, whole);
    assert_eq!(again, whole);
}
