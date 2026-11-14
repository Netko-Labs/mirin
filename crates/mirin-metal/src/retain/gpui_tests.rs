//! Retained subtrees on upstream GPUI (`forks/zed`) draw what drawing
//! everything does: moved, left out, and built again onto their kept
//! layout. Ports of the fork's GPUI-level tests
//! (`forks/gpui/src/elements/retained/tests.rs`); upstream GPUI's own tests
//! need zed's workspace, so they run here, on its public API, comparing
//! `Window::scene_drawn` (every primitive and hittable hitbox, sorted) and
//! what each frame paints over what (`Window::last_scene_stacking`).

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};

use gpui::{
    div, point, prelude::*, px, retained, rgb, size, AnyElement, Context, Entity, Modifiers,
    RetainedDraw, ScrollHandle, TestAppContext, VisualTestContext, Window,
};

#[derive(Clone)]
struct Row {
    color: u32,
    height: f32,
    version: u64,
}

struct Marker;

/// What a test changes between frames.
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
    /// Rows and cells may not be left out (cells hear hovers, as a view with
    /// `onHoverChange` keeps mirin-metal's subtrees around it drawn).
    hears: bool,
    /// Added to every cell's color when it is built. Not part of any
    /// version: a cell hears of a change by being notified.
    tint: Rc<Cell<u32>>,
    /// Rows draw nothing of their own size (no fill, no hover), and say so
    /// (`Retained::stretchable`).
    bare: bool,
    /// The window's width.
    width: f32,
    /// Counts each row's builds; with it, every build of a row but its
    /// first has one more (empty) element in it.
    unsteady: Option<Rc<RefCell<HashMap<usize, usize>>>>,
    /// How often a row's elements, and a cell's, were made.
    builds: Rc<Cell<(usize, usize)>>,
    /// A cell's build reads the view that renders the rows, as an app's
    /// build reads its own state (mirin-metal's root view).
    reads: bool,
}

struct Rows {
    scene: Rc<RefCell<Scene>>,
    markers: Vec<Entity<Marker>>,
    cell_markers: Vec<Entity<Marker>>,
    retain: bool,
    scroll: ScrollHandle,
    draws: Rc<RefCell<HashMap<RetainedDraw, usize>>>,
}

thread_local! {
    /// What cells that hear hovers heard, in order.
    static HEARD: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

fn cell(row: usize, index: usize, tint: u32) -> AnyElement {
    div()
        .id(("cell", row * 100 + index))
        .on_hover(move |hovered, _, _| {
            HEARD.with(|heard| heard.borrow_mut().push(format!("{row}.{index} {hovered}")))
        })
        .w(px(30.0))
        .h_full()
        // Its text runs past its box: clipped by a mask that moves with it.
        .overflow_hidden()
        .bg(rgb(0x0000ff + index as u32 + tint))
        .hover(|style| style.bg(rgb(0x00ffff)))
        .child(format!("cell {row}.{index} overflowing"))
        .into_any_element()
}

fn row(
    index: usize,
    row: Row,
    cells: Vec<AnyElement>,
    bare: bool,
    unsteady: Option<&RefCell<HashMap<usize, usize>>>,
) -> AnyElement {
    let built_before = unsteady.is_some_and(|builds| {
        let mut builds = builds.borrow_mut();
        let count = builds.entry(index).or_default();
        *count += 1;
        *count > 1
    });
    let element = div()
        .id(("row", index))
        .flex()
        .flex_shrink_0()
        .gap_1()
        .h(px(row.height));
    let element = if bare {
        element
    } else {
        element
            // A border, which upstream draws in strips, each under a mask
            // of its own: clipped at the view's edge, a row's strips are
            // clipped again where it is copied (`Scene::insert_strip`).
            .border_1()
            .border_color(rgb(0xffff00 ^ row.color))
            .rounded_sm()
            .bg(rgb(row.color))
            .hover(|style| style.bg(rgb(0xff0000)))
    };
    element
        .child(format!("row {index}"))
        .child(div().size(px(6.0)).bg(rgb(0x00ff00)).shadow_sm())
        .children(cells)
        .children(built_before.then(div))
        .into_any_element()
}

impl Render for Rows {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let scene = self.scene.borrow().clone();
        let me = cx.entity();
        let rows = scene
            .rows
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, spec)| {
                if !self.retain {
                    let tint = scene.tint.get();
                    let cells = (0..scene.cells).map(|cell_index| cell(index, cell_index, tint));
                    return row(
                        index,
                        spec,
                        cells.collect(),
                        scene.bare,
                        scene.unsteady.as_deref(),
                    );
                }
                let version = spec.version;
                let draws = self.draws.clone();
                let (cells, loose, hears, bare) =
                    (scene.cells, scene.loose, scene.hears, scene.bare);
                let (tint, unsteady) = (scene.tint.clone(), scene.unsteady.clone());
                let cell_markers = self.cell_markers.clone();
                let cell_draws = self.draws.clone();
                let builds = scene.builds.clone();
                let (me, reads) = (me.clone(), scene.reads);
                retained(
                    ("kept", index),
                    self.markers[index].entity_id(),
                    version,
                    move |_, _| {
                        let (rows, cells_built) = builds.get();
                        builds.set((rows + 1, cells_built));
                        let kept_cells = (0..cells)
                            .map(|cell_index| {
                                let marker = cell_markers[index * cells + cell_index].entity_id();
                                let draws = cell_draws.clone();
                                let (tint, builds) = (tint.clone(), builds.clone());
                                let me = me.clone();
                                retained(("kept-cell", index * 100 + cell_index), marker, 1, {
                                    move |_, cx| {
                                        if reads {
                                            let _ = me.read(cx).retain;
                                        }
                                        let (rows, cells_built) = builds.get();
                                        builds.set((rows, cells_built + 1));
                                        cell(index, cell_index, tint.get())
                                    }
                                })
                                .movable(loose)
                                .skippable(loose && !hears)
                                .on_prepaint(move |draw, _, _, _| {
                                    *draws.borrow_mut().entry(draw).or_default() += 1
                                })
                                .into_any_element()
                            })
                            .collect();
                        row(index, spec.clone(), kept_cells, bare, unsteady.as_deref())
                    },
                )
                .stretchable(scene.bare)
                .movable(scene.loose)
                .skippable(scene.loose && !scene.hears)
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

fn plain(rows: Vec<Row>) -> Scene {
    Scene {
        rows,
        above: 0.0,
        viewport: 0.0,
        cells: 0,
        loose: false,
        hears: false,
        tint: Rc::default(),
        bare: false,
        width: 300.0,
        unsteady: None,
        builds: Rc::default(),
        reads: false,
    }
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
        hears: false,
        tint: Rc::default(),
        bare: false,
        width: 300.0,
        unsteady: None,
        builds: Rc::default(),
        reads: false,
    }
}

type Draws = Rc<RefCell<HashMap<RetainedDraw, usize>>>;

struct Opened<'a> {
    view: Entity<Rows>,
    scene: Rc<RefCell<Scene>>,
    cell_markers: Vec<Entity<Marker>>,
    scroll: ScrollHandle,
    draws: Draws,
    cx: &'a mut VisualTestContext,
}

/// A window of the test platform (scale factor 2) showing `scene`.
fn open(cx: &mut TestAppContext, scene: Scene, retain: bool) -> Opened<'_> {
    open_at(cx, scene, retain, 2.0)
}

/// `open`, at a scale factor of `scale`.
fn open_at(cx: &mut TestAppContext, scene: Scene, retain: bool, scale: f32) -> Opened<'_> {
    let shared = Rc::new(RefCell::new(scene));
    let (count, cells, width) = {
        let scene = shared.borrow();
        (
            scene.rows.len(),
            scene.rows.len() * scene.cells,
            scene.width,
        )
    };
    let scroll = ScrollHandle::new();
    let draws = Rc::new(RefCell::new(HashMap::new()));
    let (view, cx) = cx.add_window_view({
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
    let cell_markers = cx.update(|_, cx| view.read(cx).cell_markers.clone());
    if scale != 2.0 {
        cx.simulate_scale_factor_change(scale);
    }
    cx.simulate_resize(size(px(width), px(400.0)));
    cx.run_until_parked();
    draw(cx);
    Opened {
        view,
        scene: shared,
        cell_markers,
        scroll,
        draws,
        cx,
    }
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        crate::gpui_api::draw(window, cx);
    });
}

/// What the last frame drew, and what it painted over what
/// (`Window::last_scene_stacking`: a copied drawing is placed in the bounds
/// tree as one, so its draw orders' numbers differ from drawing everything,
/// but not what overlaps what).
fn drawn(cx: &mut VisualTestContext) -> Vec<String> {
    cx.update(|window, _| {
        let mut drawn = window.last_scene_drawn();
        drawn.extend(
            window
                .last_scene_stacking()
                .into_iter()
                .map(|stacked| format!("stacked: {stacked}")),
        );
        drawn
    })
}

/// Two frames drew the same; the failure names what only one has.
fn assert_same(kept: &[String], whole: &[String], what: &str) {
    if kept != whole {
        let only = |a: &[String], b: &[String]| {
            a.iter()
                .filter(|drawn| !b.contains(drawn))
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
        };
        panic!(
            "{what}: {} kept, {} whole\nonly kept: {:#?}\nonly whole: {:#?}",
            kept.len(),
            whole.len(),
            only(kept, whole),
            only(whole, kept),
        );
    }
}

type Step<'a> = &'a dyn Fn(&mut Scene) -> Option<f32>;

/// Drive the same steps with retained rows and without, and compare every
/// frame. A step changes the scene and may scroll (the offset down).
fn compare(cx: &mut TestAppContext, scene: Scene, steps: &[Step]) -> HashMap<RetainedDraw, usize> {
    compare_at(cx, scene, 2.0, steps)
}

/// `compare`, at a scale factor of `scale`.
fn compare_at(
    cx: &mut TestAppContext,
    scene: Scene,
    scale: f32,
    steps: &[Step],
) -> HashMap<RetainedDraw, usize> {
    let run = |cx: &mut TestAppContext, retain: bool| {
        let opened = open_at(cx, scene.clone(), retain, scale);
        let mut frames = vec![drawn(opened.cx)];
        for step in steps {
            let width = opened.scene.borrow().width;
            if let Some(to) = step(&mut opened.scene.borrow_mut()) {
                opened.scroll.set_offset(point(px(0.0), px(-to)));
            }
            let now = opened.scene.borrow().width;
            if now != width {
                opened.cx.simulate_resize(size(px(now), px(400.0)));
                opened.cx.run_until_parked();
            }
            draw(opened.cx);
            frames.push(drawn(opened.cx));
        }
        let draws = opened.draws.borrow().clone();
        (frames, draws)
    };
    let (kept, draws) = run(cx, true);
    let (whole, _) = run(cx, false);
    for (index, (kept, whole)) in kept.iter().zip(&whole).enumerate() {
        assert_same(kept, whole, &format!("frame {index}"));
    }
    draws
}

fn count(draws: &HashMap<RetainedDraw, usize>, draw: RetainedDraw) -> usize {
    draws.get(&draw).copied().unwrap_or_default()
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
    let draws = kept.draws.borrow().clone();
    assert!(count(&draws, RetainedDraw::Reused) > 12, "{draws:?}");
    assert!(count(&draws, RetainedDraw::Redrawn) > 0, "{draws:?}");

    let mut expected = rows(12);
    expected[4].color = 0x123456;
    let whole = open(cx, plain(expected.clone()), false);
    assert_same(&recolored, &drawn(whole.cx), "recolored");
    expected[2].height = 23.7;
    let whole = open(cx, plain(expected), false);
    let whole = drawn(whole.cx);
    assert_same(&moved, &whole, "moved");
    assert_same(&again, &whole, "again");
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
            // A quarter of a logical pixel: half a device pixel, which the
            // scroll view snaps, so the rows still move by whole ones.
            &|_| Some(40.25),
            &|_| Some(41.5),
            &|_| Some(42.0),
            &|_| Some(60.0),
        ],
    );
    assert!(count(&draws, RetainedDraw::Moved) > 10, "{draws:?}");
    assert!(count(&draws, RetainedDraw::Skipped) > 100, "{draws:?}");
    assert!(count(&draws, RetainedDraw::Redrawn) > 5, "{draws:?}");
}

#[gpui::test]
fn rows_only_resized_keep_their_drawings(cx: &mut TestAppContext) {
    let width = |width: f32| {
        move |scene: &mut Scene| {
            scene.width = width;
            None
        }
    };
    // Rows of cells stretched to the window's width: wider or narrower,
    // what is inside each sits where it was, so rows that draw nothing of
    // their own size keep their drawings (`Retained::stretchable`); in the
    // scroll view too, under its new mask.
    for viewport in [0.0, 120.0] {
        let scene = Scene {
            bare: true,
            viewport,
            ..scrolled(12, 2)
        };
        let draws = compare(
            cx,
            scene,
            &[&width(260.0), &width(340.5), &|_| Some(30.0), &width(300.0)],
        );
        // In the scroll view, rows its edges clip as it scrolls are drawn
        // again (not stretched: 25 without, and every row built apart).
        let most = if viewport == 0.0 { 0 } else { 10 };
        assert!(count(&draws, RetainedDraw::Redrawn) <= most, "{draws:?}");
        assert!(
            count(&draws, RetainedDraw::Reused) + count(&draws, RetainedDraw::Moved) > 20,
            "{draws:?}"
        );
    }
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
            &grow(1, 24.3),
            &|_| Some(55.0),
            &grow(1, 24.0),
        ],
    );
    assert!(count(&draws, RetainedDraw::Moved) > 10, "{draws:?}");
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
    assert!(count(&draws, RetainedDraw::Moved) > 10, "{draws:?}");
    assert!(count(&draws, RetainedDraw::Skipped) > 100, "{draws:?}");
}

#[gpui::test]
fn what_is_under_the_pointer_is_drawn_again_when_rows_move(cx: &mut TestAppContext) {
    // The pointer rests over the rows: each scroll puts another row (and
    // cell) under it, hovered though no pointer move said so.
    let run = |cx: &mut TestAppContext, retain: bool| {
        let opened = open(cx, scrolled(30, 3), retain);
        opened
            .cx
            .simulate_mouse_move(point(px(80.0), px(60.0)), None, Modifiers::default());
        let mut frames = Vec::new();
        for to in [0.0, 9.0, 31.0, 150.0, 141.0, 0.0] {
            opened.scroll.set_offset(point(px(0.0), px(-to)));
            draw(opened.cx);
            frames.push(drawn(opened.cx));
        }
        let draws = opened.draws.borrow().clone();
        (frames, draws)
    };
    let (kept, draws) = run(cx, true);
    let (whole, _) = run(cx, false);
    let red = "h: 0.0, s: 1.0, l: 0.5";
    assert!(
        kept[0].iter().any(|drawn| drawn.contains(red)),
        "a row is hovered"
    );
    for (index, (kept, whole)) in kept.iter().zip(&whole).enumerate() {
        assert_same(kept, whole, &format!("frame {index}"));
    }
    // Fewer than the fork moves: a drawing the pointer was over before the
    // scroll, or is over after it, is drawn again (`plan`), rows and cells.
    assert!(count(&draws, RetainedDraw::Moved) > 5, "{draws:?}");
}

#[gpui::test]
fn a_view_notified_while_it_was_left_undrawn_is_built_again(cx: &mut TestAppContext) {
    let run = |cx: &mut TestAppContext, retain: bool| {
        let opened = open(cx, scrolled(30, 3), retain);
        // Once more, so the rows out of view are left out.
        draw(opened.cx);
        // Every cell draws another color, and is notified: the ones out of
        // view too, which are in no drawing.
        opened.scene.borrow().tint.set(0x003300);
        opened.cx.update(|_, cx| {
            for marker in &opened.cell_markers {
                cx.notify(marker.entity_id());
            }
        });
        let mut frames = Vec::new();
        for to in [0.0, 300.0, 140.0, 0.0] {
            opened.scroll.set_offset(point(px(0.0), px(-to)));
            draw(opened.cx);
            frames.push(drawn(opened.cx));
        }
        let draws = opened.draws.borrow().clone();
        (frames, draws)
    };
    let (kept, draws) = run(cx, true);
    let (whole, _) = run(cx, false);
    for (index, (kept, whole)) in kept.iter().zip(&whole).enumerate() {
        assert_same(kept, whole, &format!("frame {index}"));
    }
    assert!(count(&draws, RetainedDraw::Skipped) > 20, "{draws:?}");
}

#[gpui::test]
fn a_subtree_whose_elements_differ_from_build_to_build_is_built_apart(cx: &mut TestAppContext) {
    let mut scene = scrolled(12, 0);
    // Rows that may not be copied elsewhere are built again when they move,
    // with one more element than the layout they kept was made for.
    scene.loose = false;
    scene.unsteady = Some(Rc::default());
    gpui::take_built_apart();
    let draws = compare(
        cx,
        scene,
        &[&|_| Some(9.0), &|_| Some(30.0), &|_| Some(0.0)],
    );
    assert!(count(&draws, RetainedDraw::Redrawn) > 10, "{draws:?}");
    assert!(gpui::take_built_apart() > 10);
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
    assert_eq!(count(&draws, RetainedDraw::Moved), 0, "{draws:?}");
    assert_eq!(count(&draws, RetainedDraw::Skipped), 0, "{draws:?}");
    assert!(count(&draws, RetainedDraw::Redrawn) > 30, "{draws:?}");
    assert!(count(&draws, RetainedDraw::Reused) > 30, "{draws:?}");
}

/// A clean cell under a pointer its row moved under can't be copied, and is
/// built again in place, from its row's prepaint: while the row is watched
/// for the entities it reads. What the cell's build reads is not what the
/// row is drawn from. Counted for the row, a view the app notifies on every
/// frame (as mirin-metal's root view is) left the row notified on every
/// frame, and a notified subtree is never left out: once scrolled out of
/// view it was copied, unseen, for good.
#[gpui::test]
fn what_a_build_reads_does_not_keep_the_subtree_around_it_in_the_frame(cx: &mut TestAppContext) {
    let run = |cx: &mut TestAppContext, reads: bool| {
        let mut scene = scrolled(30, 3);
        scene.reads = reads;
        let opened = open(cx, scene, true);
        opened
            .cx
            .simulate_mouse_move(point(px(80.0), px(60.0)), None, Modifiers::default());
        let mut frames = Vec::new();
        // Rows pass under the pointer, then are scrolled well out of view.
        for to in [0.0, 9.0, 31.0, 62.0, 150.0, 300.0, 310.0, 320.0] {
            opened.draws.borrow_mut().clear();
            opened.scroll.set_offset(point(px(0.0), px(-to)));
            // The app notifies its view, which draws the window.
            let view = opened.view.clone();
            opened
                .cx
                .update(|_, cx| view.update(cx, |_, cx| cx.notify()));
            draw(opened.cx);
            let draws = opened.draws.borrow();
            frames.push(
                [
                    RetainedDraw::Built,
                    RetainedDraw::Redrawn,
                    RetainedDraw::Reused,
                    RetainedDraw::Moved,
                    RetainedDraw::Skipped,
                ]
                .map(|draw| count(&draws, draw)),
            );
        }
        frames
    };
    let (silent, reading) = (run(cx, false), run(cx, true));
    assert!(
        silent.iter().any(|[_, redrawn, ..]| *redrawn > 0),
        "something is built again in place: {silent:?}"
    );
    assert_eq!(
        reading, silent,
        "built, redrawn, reused, moved and left out, frame by frame"
    );
}

/// Scroll to each of `stops` in turn, with retained rows (`retain`) or
/// without; what each frame drew, and how many rows and cells had been built
/// by then.
fn scroll_through(
    cx: &mut TestAppContext,
    cells: usize,
    retain: bool,
    stops: &[f32],
) -> Vec<(Vec<String>, (usize, usize))> {
    let scene = scrolled(30, cells);
    let builds = scene.builds.clone();
    let opened = open(cx, scene, retain);
    stops
        .iter()
        .map(|to| {
            opened.scroll.set_offset(point(px(0.0), px(-to)));
            draw(opened.cx);
            (drawn(opened.cx), builds.get())
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
        let kept = scroll_through(cx, cells, true, THERE_AND_BACK);
        let whole = scroll_through(cx, cells, false, THERE_AND_BACK);
        for (index, ((kept, _), (whole, _))) in kept.iter().zip(&whole).enumerate() {
            assert_same(kept, whole, &format!("stop {index} with {cells} cells"));
        }
        // Once every row that shows on the way has been drawn (the first way
        // down and back), nothing is built for coming back into view. Rows
        // with cells come in clipped, with the cells' own masks clipped by the
        // view's: they are built again onto their kept nodes, unlike on the
        // fork (whose mask map moves them): no layout, but builds.
        let (rows_before, cells_before) = kept[6].1;
        let (rows_after, cells_after) = kept[kept.len() - 1].1;
        if cells == 0 {
            assert_eq!(rows_after, rows_before, "rows");
            assert_eq!(cells_after, cells_before, "cells");
        }
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
        let pointer = |cx: &mut VisualTestContext, y: f32| {
            cx.simulate_mouse_move(point(px(80.0), px(y)), None, Modifiers::default());
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

#[gpui::test]
fn cells_that_hear_hovers_hear_what_drawing_everything_tells_them(cx: &mut TestAppContext) {
    // The pointer rests over the view while it scrolls, rows clipped at its
    // edges move in and out, and the window is resized under it.
    let run = |cx: &mut TestAppContext, retain: bool| {
        HEARD.with(|heard| heard.borrow_mut().clear());
        let mut scene = scrolled(40, 3);
        scene.hears = true;
        let opened = open(cx, scene, retain);
        opened
            .cx
            .simulate_mouse_move(point(px(80.0), px(60.0)), None, Modifiers::default());
        let mut frames = Vec::new();
        for to in [0.0, 13.0, 40.0, 53.0, 93.0, 300.0, 270.0, 0.0] {
            opened.scroll.set_offset(point(px(0.0), px(-to)));
            draw(opened.cx);
            opened.cx.run_until_parked();
            frames.push((drawn(opened.cx), HEARD.with(|heard| heard.take())));
        }
        frames
    };
    let kept = run(cx, true);
    let whole = run(cx, false);
    for (index, ((kept, kept_heard), (whole, whole_heard))) in kept.iter().zip(&whole).enumerate() {
        assert_eq!(kept_heard, whole_heard, "heard at frame {index}");
        assert_same(kept, whole, &format!("frame {index}"));
    }
}

/// Scrolls that land between pixels, a row growing, and a way back.
const UNEVEN_STEPS: &[Step<'static>] = &[
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
    // Port of the fork's `scaled` test. Upstream's scroll view paints its
    // content at whole device pixels, so rows move by whole device pixels
    // whatever a logical pixel is: 1 and 2 are exact, the rest lose a
    // little at every position, which the device grid settles (`Grid`).
    for scale in [1.0, 2.0, 1.25, 1.5, 1.75, 3.0] {
        let draws = compare_at(cx, scrolled(30, 0), scale, UNEVEN_STEPS);
        assert!(
            count(&draws, RetainedDraw::Moved) >= 40,
            "{scale}: {draws:?}"
        );
        assert!(
            count(&draws, RetainedDraw::Skipped) > 100,
            "{scale}: {draws:?}"
        );
        // Cells clip their text with masks of their own, which the view's
        // edge clips: the mask map moves them anyway (`MaskMap`), where
        // scaling is exact. Elsewhere such a mask moved is not what pushing
        // it there gives in its last bits, so those rows are drawn again;
        // what is drawn is the same.
        let draws = compare_at(cx, scrolled(30, 3), scale, UNEVEN_STEPS);
        if scale == 1.0 || scale == 2.0 {
            assert!(
                count(&draws, RetainedDraw::Moved) > 60,
                "{scale}: {draws:?}"
            );
            assert!(
                count(&draws, RetainedDraw::Redrawn) < 30,
                "{scale}: {draws:?}"
            );
        }
    }
    // 1.1 is not even a fraction a float holds: what is drawn is still what
    // drawing everything draws.
    compare_at(cx, scrolled(30, 3), 1.1, UNEVEN_STEPS);
    compare_at(cx, scrolled(30, 0), 1.1, UNEVEN_STEPS);
}

#[gpui::test]
fn small_wheel_steps_draw_what_drawing_everything_does(cx: &mut TestAppContext) {
    // Port of the fork's `scaled` wheel test: a touchpad's steps of a
    // fraction of a pixel, the view painted at the device pixel upstream
    // snaps its offset to, rows moved, cells with masks of their own.
    use gpui::{ScrollDelta, ScrollEvent, TouchPhase};
    const STEP: f32 = 0.3;
    const STEPS: usize = 40;
    // Cells clip their text with masks of their own, which keep a row from
    // moving where scaling is not exact (`Recorded::masks`).
    for (scale, cells) in [(1.0, 3), (2.0, 3), (1.5, 3), (1.5, 0)] {
        let wheeled = |cx: &mut TestAppContext, retain: bool| {
            let opened = open_at(cx, scrolled(30, cells), retain, scale);
            // The pointer rests where the wheel turns, over a row.
            let at = point(px(100.0), px(60.0));
            opened
                .cx
                .simulate_mouse_move(at, None, Modifiers::default());
            let mut frames = Vec::new();
            for _ in 0..STEPS {
                opened.cx.simulate_event(ScrollEvent {
                    position: at,
                    delta: ScrollDelta::Pixels(point(px(0.0), px(-STEP))),
                    modifiers: Modifiers::default(),
                    touch_phase: TouchPhase::Moved,
                    ..Default::default()
                });
                draw(opened.cx);
                frames.push(drawn(opened.cx));
            }
            let draws = opened.draws.borrow().clone();
            (frames, draws)
        };
        let (kept, draws) = wheeled(cx, true);
        let (whole, _) = wheeled(cx, false);
        for (index, (kept, whole)) in kept.iter().zip(&whole).enumerate() {
            assert_same(kept, whole, &format!("step {index} at {scale}"));
        }
        if scale != 1.5 || cells == 0 {
            assert!(count(&draws, RetainedDraw::Moved) > 0, "{scale}: {draws:?}");
        }
    }
}
