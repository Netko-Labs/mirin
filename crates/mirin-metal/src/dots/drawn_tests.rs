//! A `dots` node drawn through the host's own `RootView` on GPUI's test
//! platform: one quad a dot, in one box, no element per dot.

use std::sync::mpsc;

use sumi::{px, size, TestAppContext};

use crate::events::EventSender;
use crate::patch::Document;
use crate::sim::LayoutMap;
use crate::tree::parse_tree;
use crate::window::RootView;

/// A row of six: three lit, the fifth a ringed head, the rest unlit.
const ROW: &str = r##"{"type":"view","props":{"id":"1"},"children":[
  {"type":"view","props":{"id":"2","direction":"row"},"children":[
    {"type":"dots","props":{"id":"3","count":6,"pitch":8,"radius":2,"lit":3,"head":4,
      "headRing":true,"color":"#ffffff","unlitColor":"#444444"}}]}]}"##;

#[sumi::test]
fn a_row_of_dots_is_one_quad_a_dot_in_one_box(cx: &mut TestAppContext) {
    let tree = parse_tree(ROW).expect("the row parses");
    let (tx, _rx) = mpsc::channel();
    let layout = LayoutMap::default();
    let events = EventSender::new(tx, layout.clone());
    let map = layout.clone();
    let (_view, cx) =
        cx.add_window_view(|_, cx| RootView::new(Document::new(tree), false, events, map, cx));
    cx.simulate_resize(size(px(200.0), px(100.0)));
    cx.run_until_parked();
    let drawn = cx.update(|window, cx| {
        let _ = window.draw(cx);
        window.last_scene_drawn()
    });
    let quads: Vec<&String> = drawn
        .iter()
        .filter(|line| line.starts_with("Quad"))
        .collect();
    assert_eq!(quads.len(), 6, "{drawn:#?}");
    // The row that holds them is as tall as a dot and as wide as the row.
    let row = layout
        .snapshot()
        .into_iter()
        .find(|node| node.id == "2")
        .expect("the row was laid out");
    assert_eq!((row.width, row.height), (200.0, 4.0));
    // Exactly one of them is a ring: a border and no fill.
    let rings = quads
        .iter()
        .filter(|quad| !quad.contains("border_widths: Edges { top: 0px"))
        .count();
    assert_eq!(rings, 1, "{quads:#?}");
}
