//! Minimal mirin-native check: render a static tree in the GPU window.
//! Run from this crate's directory: `cargo run --example hello`

use std::sync::mpsc;

use mirin_native::{parse_tree, NativeUiOptions};

fn main() {
    let tree = parse_tree(
        r##"{
          "type": "view",
          "props": {"fill": true, "center": true, "gap": 8, "background": "#111114"},
          "children": [
            {"type": "text", "props": {"size": 28, "color": "#f4f4f5"},
              "children": ["mirin native (alpha)"]},
            {"type": "text", "props": {"size": 14, "color": "#9f9fa8"},
              "children": ["GPU-rendered by GPUI — no web engine in this window"]}
          ]
        }"##,
    )
    .expect("static hello tree is valid");

    let (_update_tx, update_rx) = mpsc::channel();
    let (event_tx, _event_rx) = mpsc::channel();
    mirin_native::run(NativeUiOptions::default(), tree, update_rx, event_tx);
}
