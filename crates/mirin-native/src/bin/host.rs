//! mirin-native-host: stdio bridge for the alpha React renderer.
//! The driver process (the React reconciler running in Bun — see
//! `packages/mirin-native`) writes newline-delimited JSON element trees on
//! stdin; interaction events go back as newline-delimited JSON on stdout.
//! This stands in for the eventual in-process FFI wiring.

use std::io::{BufRead, Write};
use std::sync::mpsc;

use mirin_native::{parse_tree, run, EventKind, NativeUiEvent, NativeUiOptions, NodeSpec};

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
                Err(error) => eprintln!("[mirin-native-host] rejected tree: {error}"),
            }
        }
    });

    // interaction events → stdout.
    std::thread::spawn(move || {
        let mut out = std::io::stdout();
        while let Ok(event) = event_rx.recv() {
            let kind = match event.kind {
                EventKind::Press => "press",
            };
            let line = serde_json::json!({ "type": kind, "nodeId": event.node_id });
            if writeln!(out, "{line}").and_then(|()| out.flush()).is_err() {
                break;
            }
        }
    });

    let title = std::env::var("MIRIN_NATIVE_TITLE").unwrap_or_else(|_| "mirin native".into());
    let initial = parse_tree(r##"{"type":"view","props":{"fill":true,"background":"#111114"}}"##)
        .expect("static initial tree is valid JSON");
    run(
        NativeUiOptions {
            title: title.into(),
            ..Default::default()
        },
        initial,
        update_rx,
        event_tx,
    );
}
