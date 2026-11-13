//! A whole tree as a driver sends it, laid out by GPUI on its test platform
//! through the host's own `RootView`: Dashi's Settings › Mouse, whose card
//! kept empty room under its last row in a narrow window.

use std::sync::mpsc;

use gpui::{px, size, TestAppContext};

use crate::events::EventSender;
use crate::patch::Document;
use crate::sim::{LayoutMap, LayoutNode};
use crate::tree::parse_tree;
use crate::window::RootView;

/// Dashi's System Settings on its Mouse page, as `@mirinjs/metal` serialized it.
const SETTINGS_MOUSE: &str = include_str!("fixtures/settings-mouse.json");
/// The card of the page's rows, and what is in it: four rows and the lines between them.
const CARD: &str = "237";
const IN_CARD: [&str; 7] = ["137", "138", "179", "180", "221", "222", "235"];

/// Every node's place with the window `width` by `height`.
fn laid_out(cx: &mut TestAppContext, json: &str, width: f32, height: f32) -> Vec<LayoutNode> {
    let tree = parse_tree(json).expect("the fixture parses");
    let (tx, rx) = mpsc::channel();
    let layout = LayoutMap::default();
    let events = EventSender::new(tx, layout.clone());
    let map = layout.clone();
    let (_view, cx) =
        cx.add_window_view(|_, cx| RootView::new(Document::new(tree), false, events, map, cx));
    cx.simulate_resize(size(px(width), px(height)));
    cx.run_until_parked();
    cx.update(|window, cx| {
        let _ = window.draw(cx);
    });
    drop(rx);
    layout.snapshot()
}

fn node<'a>(nodes: &'a [LayoutNode], id: &str) -> &'a LayoutNode {
    nodes
        .iter()
        .find(|node| node.id == id)
        .unwrap_or_else(|| panic!("node {id} was laid out"))
}

#[gpui::test]
fn a_card_is_as_tall_as_its_rows_at_every_width(cx: &mut TestAppContext) {
    // 744 is the window in which the page is exactly as wide as its rows'
    // least width (a knob, 120 of words, a 260 slider): there the card came
    // out 96 taller than its rows, the height of a pass that wrapped the
    // last row's pills, kept by taffy's cache for the same width.
    for width in [1000.0, 800.0, 760.0, 745.0, 744.0, 743.0, 740.0, 720.0] {
        let nodes = laid_out(cx, SETTINGS_MOUSE, width, 646.0);
        let rows: f32 = IN_CARD.iter().map(|id| node(&nodes, id).height).sum();
        assert_eq!(node(&nodes, CARD).height, rows, "at {width} wide");
    }
}
