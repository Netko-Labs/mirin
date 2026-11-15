//! Partial frames (`sumi::PartialFrame`, `docs/metal/engine.md` section 3):
//! a frame in which only retained subtrees' content changed draws those
//! where they are. What the window then shows (every node's bounds, every
//! primitive and hitbox, what is painted over what) is what a window that
//! draws no partial frame shows after the same updates; and whatever a
//! partial frame can't draw so is drawn in full.

use sumi::{
    point, px, size, Entity, Modifiers, Pixels, Point, ScrollDelta, ScrollEvent, TestAppContext,
    VisualTestContext,
};

use crate::events::EventSender;
use crate::patch::Document;
use crate::sim::{LayoutMap, LayoutNode};
use crate::tree::{parse_tree, NodeSpec};
use crate::window::RootView;

/// What a card of the grid shows.
#[derive(Clone)]
struct Card {
    background: &'static str,
    label: String,
    color: &'static str,
    width: u32,
    dot: bool,
}

impl Card {
    fn plain(index: usize) -> Self {
        Self {
            background: "#18181b",
            label: format!("{}", (index * 7919) % 1000),
            color: "#f4f4f5",
            width: 44,
            dot: true,
        }
    }

    fn selected(index: usize) -> Self {
        Self {
            background: "#1e3a8a",
            ..Self::plain(index)
        }
    }
}

/// The app the cards are in.
#[derive(Clone, Copy)]
struct App {
    rows: usize,
    cols: usize,
    /// The rows are in a scroll view (or in a view that clips them).
    scroll: bool,
    /// Every row's background.
    row_background: Option<&'static str>,
    /// A translucent view over the first rows, painted after them.
    overlay: bool,
    /// The grid's opacity.
    opacity: Option<f32>,
}

const SMALL: App = App {
    rows: 6,
    cols: 5,
    scroll: false,
    row_background: None,
    overlay: false,
    opacity: None,
};

fn card_props(index: usize, card: &Card) -> String {
    format!(
        r##""id":"card{index}","width":{},"padding":4,"gap":2,"borderWidth":1,
        "background":"{}","onPress":true,"hoverBackground":"#27272a""##,
        card.width, card.background
    )
}

fn label_json(index: usize, card: &Card) -> String {
    format!(
        r##"{{"type":"text","props":{{"id":"label{index}","size":11,"color":"{}"}},"children":["{}"]}}"##,
        card.color, card.label
    )
}

fn card_json(index: usize, card: &Card) -> String {
    let dot = if card.dot {
        format!(
            r##",{{"type":"view","props":{{"id":"dot{index}","width":6,"height":6,"background":"#22c55e"}}}}"##
        )
    } else {
        String::new()
    };
    format!(
        r##"{{"type":"view","props":{{{}}},"children":[
          {{"type":"view","props":{{"id":"head{index}","direction":"row","justify":"between"}},"children":[
            {{"type":"text","props":{{"id":"n{index}","size":9}},"children":["#{index}"]}}{dot}]}},
          {}]}}"##,
        card_props(index, card),
        label_json(index, card)
    )
}

fn row_props(row: usize, background: Option<&str>) -> String {
    let background = background
        .map(|color| format!(r#","background":"{color}""#))
        .unwrap_or_default();
    format!(r#""id":"row{row}","direction":"row","gap":2{background}"#)
}

/// `app` with each card as `cards` says, and each row's background as
/// `rows` says (`None`: the app's).
fn tree(
    app: App,
    cards: &dyn Fn(usize) -> Card,
    rows: &dyn Fn(usize) -> Option<&'static str>,
) -> NodeSpec {
    let row_json: Vec<String> = (0..app.rows)
        .map(|row| {
            let cards: Vec<String> = (0..app.cols)
                .map(|col| card_json(row * app.cols + col, &cards(row * app.cols + col)))
                .collect();
            format!(
                r#"{{"type":"view","props":{{{}}},"children":[{}]}}"#,
                row_props(row, rows(row).or(app.row_background)),
                cards.join(",")
            )
        })
        .collect();
    let opacity = app
        .opacity
        .map(|opacity| format!(r#","opacity":{opacity}"#))
        .unwrap_or_default();
    let grid = if app.scroll {
        format!(
            r#"{{"type":"view","props":{{"id":"scroller","flex":1,"gap":2,"scroll":true{opacity}}},"children":[{}]}}"#,
            row_json.join(",")
        )
    } else {
        format!(
            r#"{{"type":"view","props":{{"id":"grid","flex":1,"gap":2,"clip":true{opacity}}},"children":[{}]}}"#,
            row_json.join(",")
        )
    };
    let overlay = if app.overlay {
        r##",{"type":"view","props":{"id":"overlay","absolute":true,"top":60,"left":40,
            "width":150,"height":90,"background":"#7f1d1d80"}}"##
    } else {
        ""
    };
    let json = format!(
        r#"{{"type":"view","props":{{"id":"root","fill":true,"padding":8,"gap":8}},"children":[
          {{"type":"input","props":{{"id":"query","value":""}}}},{grid}{overlay}]}}"#
    );
    parse_tree(&json).expect("test tree must parse")
}

fn plain(app: App) -> NodeSpec {
    tree(app, &Card::plain, &|_| None)
}

/// `app` with the cards in `cards` as given, the others plain.
fn with_cards(app: App, cards: &[(usize, Card)]) -> NodeSpec {
    tree(
        app,
        &|index| {
            cards
                .iter()
                .find(|(at, _)| *at == index)
                .map_or_else(|| Card::plain(index), |(_, card)| card.clone())
        },
        &|_| None,
    )
}

/// A window showing `tree`, which draws partial frames when `partial`.
fn open(
    cx: &mut TestAppContext,
    tree: NodeSpec,
    partial: bool,
) -> (Entity<RootView>, &mut VisualTestContext) {
    let (tx, _rx) = std::sync::mpsc::channel();
    let layout = LayoutMap::default();
    let events = EventSender::new(tx, layout.clone());
    let (view, cx) = cx.add_window_view(move |_, cx| {
        RootView::new(Document::new(tree), false, events, layout, cx)
    });
    cx.simulate_resize(size(px(1000.0), px(700.0)));
    cx.run_until_parked();
    cx.update(|window, cx| {
        let root = view.downgrade();
        if partial {
            window.set_partial_frames(Some(
                move |frame, window: &mut sumi::Window, cx: &mut sumi::App| {
                    if let Some(root) = root.upgrade() {
                        root.update(cx, |view, cx| view.partial_frame(frame, window, cx));
                    }
                },
            ));
        }
        window.refresh();
        window.draw(cx).clear(cx);
    });
    (view, cx)
}

/// Draw the frame the window asks for, if the test platform has not.
fn settle(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        if window.is_dirty() {
            window.draw(cx).clear(cx);
        }
    });
}

fn partial_frames(view: &Entity<RootView>, cx: &mut VisualTestContext) -> u32 {
    cx.update(|_, cx| view.read(cx).partial_frames)
}

/// Apply `patch` as the host does and draw the frame it asks for; whether
/// that frame was a partial one.
fn patch(view: &Entity<RootView>, cx: &mut VisualTestContext, patch: &str) -> bool {
    let ops = crate::patch::parse_patch(patch).expect("test patch parses");
    let before = partial_frames(view, cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.apply_patch(ops, cx).expect("the patch applies");
            view.notify_changed(window, cx);
        });
    });
    settle(cx);
    partial_frames(view, cx) > before
}

/// What a window shows.
#[derive(PartialEq, Debug)]
struct Shown {
    layout: Vec<LayoutNode>,
    /// Every primitive and hitbox, then what is painted over what.
    drawn: Vec<String>,
}

fn shown(view: &Entity<RootView>, cx: &mut VisualTestContext) -> Shown {
    let layout = cx.update(|_, cx| view.read(cx).layout.snapshot());
    let mut drawn = cx.update(|window, _| window.last_scene_drawn());
    drawn.extend(cx.update(|window, _| window.last_scene_stacking()));
    Shown { layout, drawn }
}

/// What a window that never draws a partial frame shows of `tree` after
/// `then`.
fn whole(
    cx: &mut TestAppContext,
    tree: NodeSpec,
    then: impl FnOnce(&Entity<RootView>, &mut VisualTestContext),
) -> Shown {
    let (view, cx) = open(cx, tree, false);
    then(&view, cx);
    settle(cx);
    assert_eq!(partial_frames(&view, cx), 0);
    shown(&view, cx)
}

fn set(index: usize, card: &Card) -> String {
    format!(
        r#"{{"op":"set","id":"card{index}","node":{{"type":"view","props":{{{}}}}}}}"#,
        card_props(index, card)
    )
}

fn set_label(index: usize, card: &Card) -> String {
    format!(
        r#"{{"op":"set","id":"label{index}","node":{}}}"#,
        label_json(index, card)
    )
}

fn set_row(row: usize, background: &str) -> String {
    format!(
        r#"{{"op":"set","id":"row{row}","node":{{"type":"view","props":{{{}}}}}}}"#,
        row_props(row, Some(background))
    )
}

fn ops(ops: &[String]) -> String {
    format!(r#"{{"patch":[{}]}}"#, ops.join(","))
}

fn wheel(cx: &mut VisualTestContext, at: Point<Pixels>, dy: f32) {
    cx.simulate_event(ScrollEvent {
        position: at,
        delta: ScrollDelta::Pixels(point(px(0.0), px(dy))),
        ..Default::default()
    });
    settle(cx);
}

fn move_to(cx: &mut VisualTestContext, x: f32, y: f32) {
    cx.simulate_mouse_move(point(px(x), px(y)), None, Modifiers::default());
    settle(cx);
}

fn resize(cx: &mut VisualTestContext, width: f32, height: f32) {
    cx.simulate_resize(size(px(width), px(height)));
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
}

#[sumi::test]
fn a_card_recolored_is_drawn_in_place(cx: &mut TestAppContext) {
    let (view, window) = open(cx, plain(SMALL), true);
    assert!(patch(&view, window, &ops(&[set(7, &Card::selected(7))])));
    let now = shown(&view, window);
    let after = with_cards(SMALL, &[(7, Card::selected(7))]);
    assert_eq!(now, whole(cx, after, |_, _| {}));
}

#[sumi::test]
fn a_text_recolored_is_drawn_in_place(cx: &mut TestAppContext) {
    let (view, window) = open(cx, plain(SMALL), true);
    let dim = Card {
        color: "#a1a1aa",
        ..Card::plain(12)
    };
    assert!(patch(&view, window, &ops(&[set_label(12, &dim)])));
    let now = shown(&view, window);
    assert_eq!(now, whole(cx, with_cards(SMALL, &[(12, dim)]), |_, _| {}));
}

#[sumi::test]
fn what_changes_a_layout_is_drawn_in_full(cx: &mut TestAppContext) {
    // A text's content, a card's width, a child that leaves.
    let longer = Card {
        label: "1234567".to_owned(),
        ..Card::plain(3)
    };
    let wide = Card {
        width: 60,
        ..Card::plain(3)
    };
    let without_dot = Card {
        dot: false,
        ..Card::plain(3)
    };
    let changes = [
        (ops(&[set_label(3, &longer)]), longer),
        (ops(&[set(3, &wide)]), wide),
        (
            ops(&[r#"{"op":"remove","id":"dot3"}"#.to_owned()]),
            without_dot,
        ),
    ];
    for (change, card) in changes {
        let (view, window) = open(cx, plain(SMALL), true);
        assert!(!patch(&view, window, &change), "{change}");
        let now = shown(&view, window);
        assert_eq!(now, whole(cx, with_cards(SMALL, &[(3, card)]), |_, _| {}));
    }
}

#[sumi::test]
fn partial_frames_one_after_another_and_then_a_whole_one(cx: &mut TestAppContext) {
    let after = with_cards(SMALL, &[(0, Card::selected(0)), (29, Card::selected(29))]);
    let oracle = whole(cx, after, |_, _| {});
    let (view, window) = open(cx, plain(SMALL), true);
    let steps = [
        (0, Card::selected(0)),
        (7, Card::selected(7)),
        (29, Card::selected(29)),
        (7, Card::plain(7)),
    ];
    for (index, card) in &steps {
        assert!(patch(&view, window, &ops(&[set(*index, card)])));
    }
    assert_eq!(shown(&view, window), oracle);
    // Then a frame from the root, which copies what the partial frames left.
    window.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    assert_eq!(shown(&view, window), oracle);
}

#[sumi::test]
fn two_cards_in_one_patch_are_each_drawn_in_place(cx: &mut TestAppContext) {
    let (view, window) = open(cx, plain(SMALL), true);
    let both = ops(&[set(2, &Card::selected(2)), set(21, &Card::selected(21))]);
    assert!(patch(&view, window, &both));
    let after = with_cards(SMALL, &[(2, Card::selected(2)), (21, Card::selected(21))]);
    assert_eq!(shown(&view, window), whole(cx, after, |_, _| {}));
}

#[sumi::test]
fn a_row_recolored_keeps_its_cards_where_they_are(cx: &mut TestAppContext) {
    let app = App {
        row_background: Some("#111114"),
        ..SMALL
    };
    let (view, window) = open(cx, plain(app), true);
    assert!(patch(&view, window, &ops(&[set_row(2, "#3f3f46")])));
    let after = tree(app, &Card::plain, &|row| (row == 2).then_some("#3f3f46"));
    assert_eq!(shown(&view, window), whole(cx, after, |_, _| {}));
}

#[sumi::test]
fn a_row_and_a_card_in_it_in_one_patch_are_drawn_in_full(cx: &mut TestAppContext) {
    let app = App {
        row_background: Some("#111114"),
        ..SMALL
    };
    let (view, window) = open(cx, plain(app), true);
    let both = ops(&[set_row(2, "#3f3f46"), set(11, &Card::selected(11))]);
    assert!(!patch(&view, window, &both));
    let after = tree(
        app,
        &|index| match index {
            11 => Card::selected(11),
            index => Card::plain(index),
        },
        &|row| (row == 2).then_some("#3f3f46"),
    );
    assert_eq!(shown(&view, window), whole(cx, after, |_, _| {}));
}

#[sumi::test]
fn a_card_under_an_overlay_and_under_opacity_keeps_its_place(cx: &mut TestAppContext) {
    for app in [
        App {
            overlay: true,
            ..SMALL
        },
        App {
            opacity: Some(0.5),
            ..SMALL
        },
    ] {
        let (view, window) = open(cx, plain(app), true);
        // Card 6 is under the overlay.
        assert!(patch(&view, window, &ops(&[set(6, &Card::selected(6))])));
        let after = with_cards(app, &[(6, Card::selected(6))]);
        assert_eq!(shown(&view, window), whole(cx, after, |_, _| {}));
    }
}

#[sumi::test]
fn a_card_out_of_view_is_drawn_in_full(cx: &mut TestAppContext) {
    let app = App { rows: 40, ..SMALL };
    let (view, window) = open(cx, plain(app), true);
    assert!(!patch(
        &view,
        window,
        &ops(&[set(197, &Card::selected(197))])
    ));
    let after = with_cards(app, &[(197, Card::selected(197))]);
    assert_eq!(shown(&view, window), whole(cx, after, |_, _| {}));
}

#[sumi::test]
fn a_window_resized_after_a_partial_frame_draws_what_it_left(cx: &mut TestAppContext) {
    let app = App { rows: 30, ..SMALL };
    let after = with_cards(app, &[(7, Card::selected(7)), (11, Card::selected(11))]);
    let oracle = whole(cx, after, |_, window| {
        resize(window, 900.0, 300.0);
        resize(window, 1100.0, 900.0);
    });
    let (view, window) = open(cx, plain(app), true);
    assert!(patch(&view, window, &ops(&[set(7, &Card::selected(7))])));
    // Shorter (rows leave the window), then taller than it was (rows that
    // were never drawn come into it), with a partial frame between.
    resize(window, 900.0, 300.0);
    assert!(patch(&view, window, &ops(&[set(11, &Card::selected(11))])));
    resize(window, 1100.0, 900.0);
    assert_eq!(shown(&view, window), oracle);
}

#[sumi::test]
fn partial_frames_and_scrolls_in_any_order(cx: &mut TestAppContext) {
    let app = App {
        rows: 40,
        scroll: true,
        ..SMALL
    };
    let at = point(px(300.0), px(300.0));
    let cards = [
        (7, Card::selected(7)),
        (22, Card::selected(22)),
        (13, Card::selected(13)),
    ];
    let oracle = whole(cx, with_cards(app, &cards), |_, window| {
        wheel(window, at, -130.0);
        wheel(window, at, -900.0);
        wheel(window, at, 1000.0);
    });
    let (view, window) = open(cx, plain(app), true);
    // A card drawn in place, scrolled away and back with a row between
    // (its drawing moved, left out, brought back), then one that came into
    // view with the scroll drawn in place where the scroll left it.
    assert!(patch(&view, window, &ops(&[set(7, &Card::selected(7))])));
    wheel(window, at, -130.0);
    assert!(patch(&view, window, &ops(&[set(22, &Card::selected(22))])));
    wheel(window, at, -900.0);
    wheel(window, at, 1000.0);
    assert!(patch(&view, window, &ops(&[set(13, &Card::selected(13))])));
    assert_eq!(shown(&view, window), oracle);
}

#[sumi::test]
fn the_pointer_over_a_card_and_off_it_is_drawn_in_place(cx: &mut TestAppContext) {
    // Card 7 is the third of the second row, card 8 its neighbor.
    let (on_7, on_8) = ((125.0, 110.0), (170.0, 110.0));
    let selected = with_cards(SMALL, &[(8, Card::selected(8))]);
    let hovered = whole(cx, plain(SMALL), |_, window| {
        move_to(window, on_7.0, on_7.1)
    });
    let next = whole(cx, plain(SMALL), |_, window| {
        move_to(window, on_7.0, on_7.1);
        move_to(window, on_8.0, on_8.1);
    });
    let patched = whole(cx, selected.clone(), |_, window| {
        move_to(window, on_8.0, on_8.1)
    });
    let left = whole(cx, selected, |_, _| {});
    assert_ne!(hovered, next, "a hover draws something");

    let (view, window) = open(cx, plain(SMALL), true);
    let before = partial_frames(&view, window);
    move_to(window, on_7.0, on_7.1);
    assert!(partial_frames(&view, window) > before, "the hover");
    assert_eq!(shown(&view, window), hovered);
    // Onto its neighbor: one loses the hover and one gains it, in one frame.
    let before = partial_frames(&view, window);
    move_to(window, on_8.0, on_8.1);
    assert!(partial_frames(&view, window) > before, "from card to card");
    assert_eq!(shown(&view, window), next);
    // A patch to the card under the pointer keeps its hover.
    assert!(patch(&view, window, &ops(&[set(8, &Card::selected(8))])));
    assert_eq!(shown(&view, window), patched);
    move_to(window, 2.0, 2.0);
    assert_eq!(shown(&view, window), left);
}
