//! mirin: retained subtrees draw what drawing everything would.

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use crate::{
    self as gpui, AnyElement, AppContext, Context, Entity, InteractiveElement, IntoElement,
    ParentElement, Render, RetainedDraw, ScrollHandle, StatefulInteractiveElement, Styled,
    TestAppContext, VisualTestContext, Window, div, point, px, retained, rgb, size,
};

#[derive(Clone)]
struct Row {
    color: u32,
    height: f32,
    version: u64,
}

struct Marker;

/// What the test changes between frames.
#[derive(Clone)]
struct Scene {
    rows: Vec<Row>,
    /// The height of a spacer above the rows.
    above: f32,
    /// The rows sit in a scroll view this tall (0: they fill the window).
    viewport: f32,
    /// Each row holds cells that are retained subtrees themselves.
    cells: usize,
    /// Rows may be moved and left out (`Retained::movable`, `skippable`).
    loose: bool,
}

struct Rows {
    scene: Rc<RefCell<Scene>>,
    markers: Vec<Entity<Marker>>,
    cell_markers: Vec<Entity<Marker>>,
    retain: bool,
    scroll: ScrollHandle,
    draws: Rc<RefCell<HashMap<RetainedDraw, usize>>>,
}

fn cell(row: usize, index: usize) -> AnyElement {
    div()
        .id(("cell", row * 100 + index))
        .w(px(30.0))
        .h_full()
        // Its text runs past its box: clipped by a mask that moves with it.
        .overflow_hidden()
        .bg(rgb(0x0000ff + index as u32))
        .hover(|style| style.bg(rgb(0x00ffff)))
        .child(format!("cell {row}.{index} overflowing"))
        .into_any_element()
}

fn row(index: usize, row: Row, cells: Vec<AnyElement>) -> AnyElement {
    div()
        .id(("row", index))
        .flex()
        .flex_shrink_0()
        .gap_1()
        .h(px(row.height))
        .bg(rgb(row.color))
        .hover(|style| style.bg(rgb(0xff0000)))
        .child(format!("row {index}"))
        // A shadow is painted before a quad of the same draw order: this
        // one must come after the row's background all the same.
        .child(div().size(px(6.0)).bg(rgb(0x00ff00)).shadow_sm())
        .children(cells)
        .into_any_element()
}

impl Render for Rows {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let scene = self.scene.borrow().clone();
        let rows = scene
            .rows
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, spec)| {
                if !self.retain {
                    let cells = (0..scene.cells).map(|cell_index| cell(index, cell_index));
                    return row(index, spec, cells.collect());
                }
                let version = spec.version;
                let draws = self.draws.clone();
                // Built by the subtree, as often as it is asked.
                let (scene_cells, loose) = (scene.cells, scene.loose);
                let cell_markers = self.cell_markers.clone();
                let cell_draws = self.draws.clone();
                retained(
                    ("kept", index),
                    self.markers[index].entity_id(),
                    version,
                    move |_, _| {
                        let cells = (0..scene_cells)
                            .map(|cell_index| {
                                let marker =
                                    cell_markers[index * scene_cells + cell_index].entity_id();
                                let draws = cell_draws.clone();
                                retained(
                                    ("kept-cell", index * 100 + cell_index),
                                    marker,
                                    1,
                                    move |_, _| cell(index, cell_index),
                                )
                                .movable(loose)
                                .skippable(loose)
                                .on_prepaint(move |draw, _, _, _| {
                                    *draws.borrow_mut().entry(draw).or_default() += 1
                                })
                                .into_any_element()
                            })
                            .collect();
                        row(index, spec.clone(), cells)
                    },
                )
                .movable(scene.loose)
                .skippable(scene.loose)
                .on_prepaint(move |draw, _, _, _| *draws.borrow_mut().entry(draw).or_default() += 1)
                .into_any_element()
            })
            .collect::<Vec<_>>();
        let list = div()
            .id("list")
            .flex()
            .flex_col()
            .gap(px(2.5))
            .children(rows);
        let list = if scene.viewport > 0.0 {
            list.h(px(scene.viewport))
                .overflow_y_scroll()
                .track_scroll(&self.scroll)
        } else {
            list
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .p(px(3.3))
            .child(div().h(px(scene.above)).flex_shrink_0())
            .child(list)
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

/// Rows of whole pixels in a scroll view, so they move by whole pixels.
fn scrolled(count: usize, cells: usize) -> Scene {
    Scene {
        rows: (0..count)
            .map(|index| Row {
                color: 0x101010 * (index as u32 % 15 + 1),
                height: 20.0 + (index % 3) as f32 * 4.0,
                version: 1,
            })
            .collect(),
        above: 7.0,
        viewport: 120.0,
        cells,
        loose: true,
    }
}

struct Opened<'a> {
    scene: Rc<RefCell<Scene>>,
    scroll: ScrollHandle,
    draws: Rc<RefCell<HashMap<RetainedDraw, usize>>>,
    cx: &'a mut VisualTestContext,
}

fn open(cx: &mut TestAppContext, scene: Scene, retain: bool) -> Opened<'_> {
    let shared = Rc::new(RefCell::new(scene));
    let (count, cells) = {
        let scene = shared.borrow();
        (scene.rows.len(), scene.rows.len() * scene.cells)
    };
    let scroll = ScrollHandle::new();
    let draws = Rc::new(RefCell::new(HashMap::new()));
    let (_, cx) = cx.add_window_view({
        let (scene, scroll, draws) = (shared.clone(), scroll.clone(), draws.clone());
        move |_, cx| Rows {
            scene,
            markers: (0..count).map(|_| cx.new(|_| Marker)).collect(),
            cell_markers: (0..cells).map(|_| cx.new(|_| Marker)).collect(),
            retain,
            scroll,
            draws,
        }
    });
    cx.simulate_resize(size(px(300.0), px(400.0)));
    cx.run_until_parked();
    draw(cx);
    Opened {
        scene: shared,
        scroll,
        draws,
        cx,
    }
}

fn plain(rows: Vec<Row>) -> Scene {
    Scene {
        rows,
        above: 0.0,
        viewport: 0.0,
        cells: 0,
        loose: false,
    }
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}

/// What the last frame drew: every primitive with the ones painted under
/// it (`Scene::stacking`: draw orders may be other numbers, what is painted
/// over what may not), and the hitboxes that can be hit (one wholly clipped
/// never is, and a subtree left undrawn has none).
fn drawn(cx: &mut VisualTestContext) -> (Vec<String>, String) {
    cx.update(|window, _| {
        let frame = &window.rendered_frame;
        let hitboxes: Vec<_> = frame
            .hitboxes
            .iter()
            .filter(|hitbox| {
                !hitbox
                    .bounds
                    .intersect(&hitbox.content_mask.bounds)
                    .is_empty()
            })
            .map(|hitbox| (hitbox.bounds, hitbox.content_mask.clone()))
            .collect();
        (frame.scene.stacking(), format!("{hitboxes:?}"))
    })
}

#[gpui::test]
fn kept_and_redrawn_rows_draw_what_drawing_everything_does(cx: &mut TestAppContext) {
    let kept = open(cx, plain(rows(12)), true);
    // Nothing changes: the rows are reused.
    draw(kept.cx);
    // One row's color: it alone is built again.
    {
        let mut scene = kept.scene.borrow_mut();
        scene.rows[4].color = 0x123456;
        scene.rows[4].version += 1;
    }
    draw(kept.cx);
    let recolored = drawn(kept.cx);
    // One row grows by a fraction of a pixel: the rows below move, and what
    // is inside some rounds to other pixels. They are drawn where they land.
    {
        let mut scene = kept.scene.borrow_mut();
        scene.rows[2].height = 23.7;
        scene.rows[2].version += 1;
    }
    draw(kept.cx);
    let moved = drawn(kept.cx);
    // Again, unchanged, now reusing the moved rows' drawings.
    draw(kept.cx);
    let again = drawn(kept.cx);
    assert!(kept.draws.borrow()[&RetainedDraw::Reused] > 12);
    assert!(kept.draws.borrow()[&RetainedDraw::Redrawn] > 0);

    let mut expected = rows(12);
    expected[4].color = 0x123456;
    let whole = open(cx, plain(expected.clone()), false);
    assert_eq!(recolored, drawn(whole.cx));
    expected[2].height = 23.7;
    let whole = open(cx, plain(expected), false);
    let whole = drawn(whole.cx);
    assert_eq!(moved, whole);
    assert_eq!(again, whole);
}

/// Drive the same steps with retained rows and without, and compare every
/// frame. `step` changes the scene and may scroll (the offset down).
fn compare(
    cx: &mut TestAppContext,
    scene: Scene,
    steps: &[&dyn Fn(&mut Scene) -> Option<f32>],
) -> HashMap<RetainedDraw, usize> {
    let run = |cx: &mut TestAppContext, retain: bool| {
        let opened = open(cx, scene.clone(), retain);
        let mut frames = vec![drawn(opened.cx)];
        for step in steps {
            let to = step(&mut opened.scene.borrow_mut());
            if let Some(to) = to {
                opened.scroll.set_offset(point(px(0.0), px(-to)));
            }
            draw(opened.cx);
            frames.push(drawn(opened.cx));
        }
        (frames, opened.draws.borrow().clone())
    };
    let (kept, draws) = run(cx, true);
    let (whole, _) = run(cx, false);
    for (index, (kept, whole)) in kept.iter().zip(&whole).enumerate() {
        assert_eq!(kept.0, whole.0, "primitives of frame {index}");
        assert_eq!(kept.1, whole.1, "hitboxes of frame {index}");
    }
    draws
}

#[gpui::test]
fn scrolled_rows_are_moved_not_drawn_again(cx: &mut TestAppContext) {
    let draws = compare(
        cx,
        scrolled(30, 0),
        &[
            // Nothing: the rows out of view are left out from now on.
            &|_| None,
            // A step: rows move; one is clipped at the top, one comes in.
            &|_| Some(8.0),
            &|_| Some(17.0),
            // Far: rows that were out of view come in whole.
            &|_| Some(260.0),
            // Back by a row and a bit, then to the top.
            &|_| Some(231.0),
            &|_| Some(0.0),
            // Half a pixel: nothing lands on whole pixels, all is drawn.
            &|_| Some(40.5),
            &|_| Some(41.5),
            &|_| Some(42.0),
            &|_| Some(60.0),
        ],
    );
    assert!(draws[&RetainedDraw::Moved] > 10, "{draws:?}");
    assert!(draws[&RetainedDraw::Skipped] > 100, "{draws:?}");
    assert!(draws[&RetainedDraw::Redrawn] > 5, "{draws:?}");
}

#[gpui::test]
fn rows_below_one_that_grew_are_moved(cx: &mut TestAppContext) {
    let grow = |index: usize, height: f32| {
        move |scene: &mut Scene| {
            scene.rows[index].height = height;
            scene.rows[index].version += 1;
            None
        }
    };
    let draws = compare(
        cx,
        scrolled(30, 0),
        &[
            &|_| Some(30.0),
            // A row in view grows, then one above the view, then what is
            // above the scroll view (which moves the view and its mask).
            &grow(3, 41.0),
            &grow(0, 9.0),
            &|scene| {
                scene.above = 31.0;
                None
            },
            &|scene| {
                scene.above = 2.0;
                None
            },
            &grow(3, 20.0),
            // By a fraction: what is below is no longer on whole pixels.
            &grow(1, 24.5),
            &|_| Some(55.0),
            &grow(1, 24.0),
        ],
    );
    assert!(draws[&RetainedDraw::Moved] > 10, "{draws:?}");
}

#[gpui::test]
fn subtrees_inside_moved_rows_keep_their_own_drawings(cx: &mut TestAppContext) {
    let recolor = |index: usize| {
        move |scene: &mut Scene| {
            scene.rows[index].color ^= 0x00ff00;
            scene.rows[index].version += 1;
            None
        }
    };
    let draws = compare(
        cx,
        scrolled(30, 3),
        &[
            &|_| None,
            &|_| Some(12.0),
            // A row is built again: the cells in it are not.
            &recolor(2),
            &|_| Some(40.0),
            &recolor(4),
            // Cells half out of view at both ends, then far, then back.
            &|_| Some(53.0),
            &|_| Some(300.0),
            &|scene| {
                scene.rows[14].height = 37.0;
                scene.rows[14].version += 1;
                Some(280.0)
            },
            &|_| Some(0.0),
        ],
    );
    assert!(draws[&RetainedDraw::Moved] > 10, "{draws:?}");
    assert!(draws[&RetainedDraw::Skipped] > 100, "{draws:?}");
}

#[gpui::test]
fn what_is_under_the_pointer_is_drawn_again_when_rows_move(cx: &mut TestAppContext) {
    // The pointer rests over the rows: each scroll puts another row (and
    // cell) under it, hovered though no pointer move said so.
    let run = |cx: &mut TestAppContext, retain: bool| {
        let opened = open(cx, scrolled(30, 3), retain);
        opened
            .cx
            .simulate_mouse_move(point(px(80.0), px(60.0)), None, crate::Modifiers::default());
        let mut frames = Vec::new();
        for to in [0.0, 9.0, 31.0, 150.0, 141.0, 0.0] {
            opened.scroll.set_offset(point(px(0.0), px(-to)));
            draw(opened.cx);
            frames.push(drawn(opened.cx));
        }
        (frames, opened.draws.borrow().clone())
    };
    let (kept, draws) = run(cx, true);
    let (whole, _) = run(cx, false);
    let hovered = |frame: &(Vec<String>, String)| {
        let red = "h: 0.0, s: 1.0, l: 0.5";
        frame.0.iter().any(|drawn| drawn.contains(red))
    };
    assert!(hovered(&kept[0]), "a row is hovered");
    assert_eq!(kept, whole);
    assert!(draws[&RetainedDraw::Moved] > 10, "{draws:?}");
}

#[gpui::test]
fn rows_that_may_not_move_are_drawn_where_they_land(cx: &mut TestAppContext) {
    let mut scene = scrolled(30, 2);
    scene.loose = false;
    let draws = compare(
        cx,
        scene,
        &[&|_| Some(8.0), &|_| Some(30.0), &|_| Some(4.0), &|_| None],
    );
    assert!(!draws.contains_key(&RetainedDraw::Moved), "{draws:?}");
    assert!(!draws.contains_key(&RetainedDraw::Skipped), "{draws:?}");
    assert!(draws[&RetainedDraw::Redrawn] > 30, "{draws:?}");
    assert!(draws[&RetainedDraw::Reused] > 30, "{draws:?}");
}
