//! mirin-metal-host: stdio bridge for the alpha React renderer.
//! The driver process (the React reconciler running in Bun — see
//! `packages/mirin-metal`) writes newline-delimited JSON element trees on
//! stdin; interaction events go back as newline-delimited JSON on stdout.
//! This stands in for the eventual in-process FFI wiring.

use std::io::{BufRead, Write};
use std::sync::mpsc;

use mirin_metal::{parse_tree, run, NativeUiEvent, NativeUiOptions, NodeSpec};

fn main() {
    let (update_tx, update_rx) = mpsc::channel::<NodeSpec>();
    let (event_tx, event_rx) = mpsc::channel::<NativeUiEvent>();

    // stdin → tree updates. EOF means the driver went away; the window simply
    // stops updating (closing it quits the process).
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            match parse_tree(&line) {
                Ok(tree) => {
                    if update_tx.send(tree).is_err() {
                        break;
                    }
                }
                Err(error) => eprintln!("[mirin-metal-host] rejected tree: {error}"),
            }
        }
    });

    // interaction events → stdout.
    std::thread::spawn(move || {
        let mut out = std::io::stdout();
        while let Ok(event) = event_rx.recv() {
            let mut line =
                serde_json::json!({ "type": event.kind.name(), "nodeId": event.node_id });
            if let Some(value) = event.kind.value() {
                line["value"] = serde_json::Value::String(value.to_string());
            }
            if writeln!(out, "{line}").and_then(|()| out.flush()).is_err() {
                break;
            }
        }
    });

    let title = std::env::var("MIRIN_METAL_TITLE").unwrap_or_else(|_| "mirin metal".into());
    // `MIRIN_METAL_SIZE=1280x820` picks the initial window size.
    let (width, height) = std::env::var("MIRIN_METAL_SIZE")
        .ok()
        .and_then(|size| {
            let (w, h) = size.split_once('x')?;
            Some((w.parse::<f32>().ok()?, h.parse::<f32>().ok()?))
        })
        .filter(|(w, h)| *w >= 200.0 && *h >= 200.0)
        .unwrap_or((
            NativeUiOptions::default().width,
            NativeUiOptions::default().height,
        ));
    let initial = parse_tree(r##"{"type":"view","props":{"fill":true,"background":"#111114"}}"##)
        .expect("static initial tree is valid JSON");
    run(
        NativeUiOptions {
            title: title.into(),
            width,
            height,
        },
        initial,
        update_rx,
        event_tx,
    );
}
