//! Retained subtrees laid out and drawn by GPUI on its test platform: a
//! frame that keeps most of the tree lays it out exactly as a frame that
//! draws it all, and builds only what changed.

use gpui::{px, size, Entity, TestAppContext, VisualTestContext};

use super::{take_counts, Boundaries};
use crate::events::EventSender;
use crate::patch::Document;
use crate::sim::{LayoutMap, LayoutNode};
use crate::tree::{parse_tree, NodeSpec};
use crate::window::RootView;

/// A grid of `rows` × `cols` cards like the stress bench's; `tall` cards get
/// a second line of text (taller, so everything below them moves), and
/// `selected` ones another background.
fn grid(rows: usize, cols: usize, tall: &[usize], selected: &[usize]) -> NodeSpec {
    let card = |index: usize| {
        let background = if selected.contains(&index) {
            "#1e3a8a"
        } else {
            "#18181b"
        };
        let extra = if tall.contains(&index) {
            r#",{"type":"text","props":{"size":11},"children":["more"]}"#
        } else {
            ""
        };
        format!(
            r##"{{"type":"view","props":{{"id":"card{index}","width":44,"padding":4,"gap":2,
            "borderWidth":1,"background":"{background}","onPress":true,"hoverBackground":"#27272a"}},"children":[
              {{"type":"view","props":{{"id":"head{index}","direction":"row","justify":"between"}},"children":[
                {{"type":"text","props":{{"size":9}},"children":["#{index}"]}},
                {{"type":"view","props":{{"id":"dot{index}","width":6,"height":6}}}}]}},
              {{"type":"text","props":{{"size":11}},"children":["{}"]}}{extra}]}}"##,
            (index * 7919) % 1000
        )
    };
    let rows: Vec<String> = (0..rows)
        .map(|row| {
            let cards: Vec<String> = (0..cols).map(|col| card(row * cols + col)).collect();
            format!(
                r#"{{"type":"view","props":{{"id":"row{row}","direction":"row","gap":2}},"children":[{}]}}"#,
                cards.join(",")
            )
        })
        .collect();
    let json = format!(
        r#"{{"type":"view","props":{{"id":"root","fill":true,"padding":8,"gap":8}},"children":[
          {{"type":"input","props":{{"id":"query","value":""}}}},
          {{"type":"view","props":{{"id":"grid","flex":1,"gap":2,"clip":true}},"children":[{}]}}]}}"#,
        rows.join(",")
    );
    parse_tree(&json).expect("test tree must parse")
}

fn open(cx: &mut TestAppContext, tree: NodeSpec) -> (Entity<RootView>, &mut VisualTestContext) {
    let (tx, _rx) = std::sync::mpsc::channel();
    let layout = LayoutMap::default();
    let events = EventSender::new(tx, layout.clone());
    let (view, cx) = cx.add_window_view(move |_, cx| {
        RootView::new(Document::new(tree), false, events, layout, cx)
    });
    cx.simulate_resize(size(px(1000.0), px(700.0)));
    cx.run_until_parked();
    draw(cx);
    (view, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}

fn set_tree(view: &Entity<RootView>, cx: &mut VisualTestContext, tree: NodeSpec) {
    cx.update(|_, cx| view.update(cx, |view, cx| view.set_tree(tree, cx)));
    take_counts();
    draw(cx);
}

fn layout(view: &Entity<RootView>, cx: &mut VisualTestContext) -> Vec<LayoutNode> {
    cx.update(|_, cx| view.read(cx).layout.snapshot())
}

/// What a frame drawing `tree` whole lays out.
fn drawn_whole(cx: &mut TestAppContext, tree: NodeSpec) -> Vec<LayoutNode> {
    let (view, cx) = open(cx, tree);
    layout(&view, cx)
}

#[gpui::test]
fn a_frame_that_keeps_the_tree_lays_it_out_as_one_that_draws_it(cx: &mut TestAppContext) {
    let (view, window) = open(cx, grid(8, 6, &[], &[]));
    let first = layout(&view, window);
    assert!(first.len() > 8 * 6 * 3, "every card's views are laid out");

    // Nothing changed: everything is reused, and laid out where it was.
    set_tree(&view, window, grid(8, 6, &[], &[]));
    assert_eq!(take_counts().0, 0, "nothing is built again");
    assert_eq!(layout(&view, window), first);

    // One card's background: that card, its row and the grid are built again.
    set_tree(&view, window, grid(8, 6, &[], &[9]));
    let (built, _) = take_counts();
    assert!(built <= 3, "built {built}");
    let kept = layout(&view, window);

    // One card grows: the rows below it move, and are drawn where they land.
    set_tree(&view, window, grid(8, 6, &[13], &[9]));
    let moved = layout(&view, window);

    let whole = drawn_whole(cx, grid(8, 6, &[], &[9]));
    assert_eq!(kept, whole);
    let whole = drawn_whole(cx, grid(8, 6, &[13], &[9]));
    assert_eq!(moved, whole);
}

#[gpui::test]
fn only_subtrees_that_render_from_their_content_alone_are_kept(cx: &mut TestAppContext) {
    let tree = |value: &str| {
        parse_tree(&format!(
            r#"{{"type":"view","props":{{"id":"root"}},"children":[
              {{"type":"view","props":{{"id":"form"}},"children":[
                {{"type":"input","props":{{"id":"name","value":"{value}"}}}},
                {{"type":"text","children":["a"]}},{{"type":"text","children":["b"]}}]}},
              {{"type":"view","props":{{"id":"list","scroll":true}},"children":[
                {{"type":"text","children":["a"]}},{{"type":"text","children":["b"]}},
                {{"type":"text","children":["c"]}}]}},
              {{"type":"view","props":{{"id":"small"}},"children":[{{"type":"text","children":["a"]}}]}},
              {{"type":"view","props":{{"id":"card"}},"children":[
                {{"type":"text","children":["a"]}},{{"type":"text","children":["b"]}},
                {{"type":"text","children":["{value}"]}}]}}]}}"#
        ))
        .expect("test tree must parse")
    };
    cx.update(|cx| {
        let mut boundaries = Boundaries::default();
        boundaries.sync(None, &Document::new(tree("x")), false, cx);
        // A field and a scroll view keep state of their own; `small` is too
        // small to be worth it. The root holds the field.
        let kept: Vec<&str> = ["root", "form", "list", "small", "card"]
            .into_iter()
            .filter(|id| boundaries.get(id).is_some())
            .collect();
        assert_eq!(kept, ["card"]);
        let version = boundaries.get("card").map(|card| card.version);
        boundaries.sync(Some(&tree("x")), &Document::new(tree("x")), false, cx);
        assert_eq!(boundaries.get("card").map(|card| card.version), version);
        boundaries.sync(Some(&tree("x")), &Document::new(tree("y")), false, cx);
        assert_ne!(boundaries.get("card").map(|card| card.version), version);
    });
}

#[gpui::test]
fn a_subtree_whose_id_is_not_unique_is_not_kept(cx: &mut TestAppContext) {
    let card = r#"{"type":"view","props":{"id":"card"},"children":[
        {"type":"text","children":["a"]},{"type":"text","children":["b"]},
        {"type":"text","children":["c"]}]}"#;
    let tree = parse_tree(&format!(
        r#"{{"type":"view","props":{{"id":"root"}},"children":[{card},{card}]}}"#
    ))
    .expect("test tree must parse");
    cx.update(|cx| {
        let mut boundaries = Boundaries::default();
        boundaries.sync(None, &Document::new(tree), false, cx);
        assert!(boundaries.get("card").is_none());
    });
}

#[gpui::test]
fn a_patch_builds_only_the_subtrees_whose_generation_moved(cx: &mut TestAppContext) {
    let (view, window) = open(cx, grid(8, 6, &[], &[]));
    let patch = r##"{"patch":[{"op":"set","id":"card9","node":{"type":"view","props":{
        "id":"card9","width":44,"padding":4,"gap":2,"borderWidth":1,"background":"#1e3a8a",
        "onPress":true,"hoverBackground":"#27272a"}}}]}"##;
    let ops = crate::patch::parse_patch(patch).expect("test patch parses");
    window.update(|_, cx| {
        view.update(cx, |view, cx| view.apply_patch(ops, cx))
            .expect("the patch applies")
    });
    take_counts();
    draw(window);
    let (built, _) = take_counts();
    assert!(built <= 3, "built {built}");
    let patched = layout(&view, window);
    assert_eq!(patched, drawn_whole(cx, grid(8, 6, &[], &[9])));
}
