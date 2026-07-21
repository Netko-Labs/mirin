//! The React Native-like loop, end to end: a driver thread (standing in for
//! the future Bun/React reconciler) owns the state, describes the UI as JSON
//! trees, and reacts to press events by sending a new tree.
//! Run from this crate's directory: `cargo run --example counter`

use std::sync::mpsc;

use mirin_native::{parse_tree, NativeUiEvent, NativeUiOptions, NodeSpec};

fn tree(count: u32) -> NodeSpec {
    let json = format!(
        r##"{{
          "type": "view",
          "props": {{"fill": true, "center": true, "gap": 12, "background": "#111114"}},
          "children": [
            {{"type": "text", "props": {{"size": 28, "color": "#f4f4f5"}},
              "children": ["count: {count}"]}},
            {{"type": "view",
              "props": {{"id": "increment", "onPress": true, "padding": 12,
                         "cornerRadius": 8, "background": "#3b82f6", "center": true}},
              "children": [
                {{"type": "text", "props": {{"color": "#ffffff"}}, "children": ["tap me"]}}
              ]}}
          ]
        }}"##
    );
    parse_tree(&json).expect("driver-authored tree is statically valid JSON")
}

fn main() {
    let (update_tx, update_rx) = mpsc::channel();
    let (event_tx, event_rx) = mpsc::channel::<NativeUiEvent>();

    // The "JS side": react to events with new trees.
    std::thread::spawn(move || {
        let mut count = 0u32;
        while let Ok(event) = event_rx.recv() {
            if event.node_id == "increment" {
                count += 1;
                if update_tx.send(tree(count)).is_err() {
                    return;
                }
            }
        }
    });

    mirin_native::run(
        NativeUiOptions {
            title: "mirin native counter (alpha)".into(),
            ..Default::default()
        },
        tree(0),
        update_rx,
        event_tx,
    );
}
