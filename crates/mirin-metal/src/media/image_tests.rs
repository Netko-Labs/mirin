//! Images the host can and cannot draw, on GPUI's test platform: which
//! files draw, and what a driver that listens (`onError`) hears of the rest.

use std::sync::mpsc::{channel, Receiver};

use sumi::{px, size, Entity, TestAppContext, VisualTestContext};

use crate::events::{EventKind, EventSender, NativeUiEvent};
use crate::patch::Document;
use crate::sim::LayoutMap;
use crate::tree::parse_tree;
use crate::window::RootView;

/// A file of `tests/images`.
fn file(name: &str) -> String {
    format!("{}/tests/images/{name}", env!("CARGO_MANIFEST_DIR"))
}

/// A window of images, each `(id, file, listens)`.
fn page(images: &[(&str, String, bool)]) -> String {
    let nodes: Vec<String> = images
        .iter()
        .map(|(id, src, listens)| {
            let on_error = if *listens { r#","onError":true"# } else { "" };
            format!(
                r#"{{"type":"image","props":{{"id":"{id}","src":{src:?},"width":64,"height":48{on_error}}}}}"#
            )
        })
        .collect();
    format!(
        r#"{{"type":"view","props":{{"id":"root","fill":true}},"children":[{}]}}"#,
        nodes.join(",")
    )
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    json: &str,
) -> (
    Entity<RootView>,
    Receiver<NativeUiEvent>,
    &'a mut VisualTestContext,
) {
    let tree = parse_tree(json).expect("test tree must parse");
    let (tx, events) = channel();
    let layout = LayoutMap::default();
    let sender = EventSender::new(tx, layout.clone());
    let (view, cx) = cx.add_window_view(move |_, cx| {
        RootView::new(Document::new(tree), false, sender, layout, cx)
    });
    cx.simulate_resize(size(px(400.0), px(300.0)));
    settle(cx);
    (view, events, cx)
}

/// Frames until every file has been read and decoded, or given up on.
fn settle(cx: &mut VisualTestContext) {
    for _ in 0..4 {
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
    }
}

/// The `imageerror` events since last asked: each node and why.
fn errors(events: &Receiver<NativeUiEvent>) -> Vec<(String, String)> {
    let mut errors: Vec<(String, String)> = events
        .try_iter()
        .filter_map(|event| match event.kind {
            EventKind::ImageError { reason } => Some((event.node_id, reason)),
            _ => None,
        })
        .collect();
    errors.sort();
    errors
}

fn told(id: &str, reason: &str) -> (String, String) {
    (id.to_owned(), reason.to_owned())
}

#[sumi::test]
fn an_image_that_cannot_be_drawn_tells_a_driver_that_listens(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (_view, events, _cx) = open(
        cx,
        &page(&[
            ("png", file("ok.png"), true),
            ("webp", file("ok.webp"), true),
            ("svg", file("ok.svg"), true),
            ("avif", file("ok.avif"), true),
            ("words", file("words.png"), true),
            ("gone", file("nothing-here.png"), true),
            ("folder", file(""), true),
            ("quiet", file("words.png"), false),
        ]),
    );
    // PNG, WebP and an SVG document draw. AVIF has no decoder, and a file
    // that is not a picture, not there, or not a file is told as such; one
    // whose driver does not listen is drawn as nothing, in silence.
    assert_eq!(
        errors(&events),
        [
            told("avif", "not an image the host can decode"),
            told("folder", "not a file"),
            told("gone", "no such file"),
            told("words", "not an image the host can decode"),
        ]
    );
}

#[sumi::test]
fn a_failure_is_told_once_for_each_file(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (view, events, cx) = open(cx, &page(&[("picture", file("words.png"), true)]));
    assert_eq!(errors(&events).len(), 1);
    // Drawn again and again, it says no more.
    settle(cx);
    assert!(errors(&events).is_empty());
    // Another file that fails is news, one that draws is not, and the one
    // that failed, shown again after it, is told again.
    for (src, wanted) in [
        (file("ok.avif"), 1),
        (file("ok.png"), 0),
        (file("ok.avif"), 1),
    ] {
        let tree = parse_tree(&page(&[("picture", src, true)])).expect("tree");
        cx.update(|_, cx| view.update(cx, |view, cx| view.set_tree(tree, cx)));
        settle(cx);
        assert_eq!(errors(&events).len(), wanted);
    }
}
