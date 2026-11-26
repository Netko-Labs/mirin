//! Glass drawn through the host's own `RootView` on sumi's test platform:
//! the panes a frame paints are the views of that frame as laid out (a
//! resize's first frame has the new size), back to front, clipped; the fill
//! is left out only while the platform draws glass; and the scene handed to
//! the platform carries the panes of the frame it draws.

use std::sync::mpsc;

use sumi::{
    point, px, size, Bounds, GlassMaterial, GlassPane, Pixels, TestAppContext, VisualTestContext,
};

use crate::events::EventSender;
use crate::patch::Document;
use crate::sim::LayoutMap;
use crate::tree::{parse_tree, NodeSpec};
use crate::window::RootView;

/// A panel of regular glass filling the window, with a fallback fill, a
/// card of paper inside it, and rows enough to be worth keeping.
const PANEL: &str = r##"{"type":"view","props":{"id":"1","fill":true,"padding":20,
  "material":"regular","cornerRadius":16,"background":"#f8f8fa"},"children":[
  {"type":"view","props":{"id":"card","height":40,"material":"paper","cornerRadius":12,
    "background":"#fbfbf9"}},
  {"type":"view","props":{"id":"a","height":10,"background":"#101010"}},
  {"type":"view","props":{"id":"b","height":10,"background":"#202020"}},
  {"type":"view","props":{"id":"c","height":10,"background":"#303030"}},
  {"type":"view","props":{"id":"d","height":10,"background":"#404040"}}]}"##;

fn open<'a>(
    cx: &'a mut TestAppContext,
    tree: &str,
    width: f32,
    height: f32,
) -> &'a mut VisualTestContext {
    let tree = parse_tree(tree).expect("the tree parses");
    let (tx, _rx) = mpsc::channel();
    let layout = LayoutMap::default();
    let events = EventSender::new(tx, layout.clone());
    let (_view, cx) =
        cx.add_window_view(|_, cx| RootView::new(Document::new(tree), false, events, layout, cx));
    cx.simulate_resize(size(px(width), px(height)));
    cx
}

/// Draws a frame and gives its panes and its drawing.
fn draw(cx: &mut VisualTestContext) -> (Vec<GlassPane>, Vec<String>) {
    cx.update(|window, cx| {
        window.refresh();
        let _ = window.draw(cx);
        (window.last_glass_drawn(), window.last_scene_drawn())
    })
}

fn bounds(x: f32, y: f32, width: f32, height: f32) -> Bounds<Pixels> {
    Bounds::new(point(px(x), px(y)), size(px(width), px(height)))
}

/// Whether a quad of the frame is filled with `#f8f8fa` (the panel's fill).
fn panel_filled(drawn: &[String]) -> bool {
    // #f8f8fa as sumi's Hsla prints it: lightness 0.98.
    drawn
        .iter()
        .any(|line| line.starts_with("Quad") && line.contains("l: 0.97") && line.contains("a: 1"))
}

#[test]
fn a_material_is_one_of_the_five_and_nothing_else() {
    let tree = parse_tree(r#"{"type":"view","props":{"material":"thin"}}"#).expect("parses");
    let NodeSpec::View { props, .. } = tree else {
        panic!("a view");
    };
    assert_eq!(props.material, Some(crate::glass::Material::Thin));
    for name in ["regular", "thick", "paper", "veil"] {
        let tree = format!(r#"{{"type":"view","props":{{"material":"{name}"}}}}"#);
        assert!(parse_tree(&tree).is_ok(), "{name}");
    }
    assert!(parse_tree(r#"{"type":"view","props":{"material":"liquidGlass"}}"#).is_err());
}

#[sumi::test]
fn panes_are_the_views_as_laid_out_back_to_front(cx: &mut TestAppContext) {
    let cx = open(cx, PANEL, 300.0, 200.0);
    let (panes, _) = draw(cx);
    assert_eq!(
        panes,
        vec![
            GlassPane {
                bounds: bounds(0.0, 0.0, 300.0, 200.0),
                corner_radius: px(16.0),
                material: GlassMaterial::Regular,
            },
            // Inside the panel's padding, over it: after it.
            GlassPane {
                bounds: bounds(20.0, 20.0, 260.0, 40.0),
                corner_radius: px(12.0),
                material: GlassMaterial::Paper,
            },
        ]
    );
    // A second frame of the same tree (its rows kept, `retain.rs`) paints
    // them again: a kept drawing would have none.
    let (again, _) = draw(cx);
    assert_eq!(again, panes);
}

#[sumi::test]
fn a_resize_has_its_panes_in_its_own_first_frame(cx: &mut TestAppContext) {
    let cx = open(cx, PANEL, 300.0, 200.0);
    draw(cx);
    cx.simulate_resize(size(px(420.0), px(260.0)));
    let (panes, _) = draw(cx);
    assert_eq!(panes[0].bounds, bounds(0.0, 0.0, 420.0, 260.0));
    assert_eq!(panes[1].bounds, bounds(20.0, 20.0, 380.0, 40.0));
}

#[sumi::test]
fn the_fill_is_painted_only_while_the_platform_draws_no_glass(cx: &mut TestAppContext) {
    let cx = open(cx, PANEL, 300.0, 200.0);
    let (_, drawn) = draw(cx);
    assert!(panel_filled(&drawn), "no glass: the fallback fill");
    cx.simulate_glass_available(true);
    let (panes, drawn) = draw(cx);
    assert!(!panel_filled(&drawn), "glass: the compositor tints");
    assert_eq!(panes.len(), 2);
    cx.simulate_glass_available(false);
    let (_, drawn) = draw(cx);
    assert!(panel_filled(&drawn));
}

#[sumi::test]
fn a_pane_is_clipped_by_what_clips_its_view(cx: &mut TestAppContext) {
    let tree = r##"{"type":"view","props":{"id":"1","fill":true},"children":[
      {"type":"view","props":{"id":"box","width":100,"height":50,"clip":true},"children":[
        {"type":"view","props":{"id":"pane","width":160,"height":30,"material":"thin",
          "cornerRadius":8}}]}]}"##;
    let cx = open(cx, tree, 300.0, 200.0);
    let (panes, _) = draw(cx);
    assert_eq!(panes.len(), 1);
    assert_eq!(panes[0].bounds, bounds(0.0, 0.0, 100.0, 30.0));
    assert_eq!(panes[0].material, GlassMaterial::Thin);
}

#[sumi::test]
fn a_bordered_pane_covers_its_border(cx: &mut TestAppContext) {
    let tree = r##"{"type":"view","props":{"id":"1","fill":true,"padding":10},"children":[
      {"type":"view","props":{"id":"pane","width":80,"height":40,"borderWidth":1,
        "borderColor":"#ffffff40","material":"regular","cornerRadius":10}}]}"##;
    let cx = open(cx, tree, 300.0, 200.0);
    let (panes, _) = draw(cx);
    assert_eq!(panes[0].bounds, bounds(10.0, 10.0, 80.0, 40.0));
}

#[sumi::test]
fn the_scene_presented_carries_the_panes_of_its_frame(cx: &mut TestAppContext) {
    let cx = open(cx, PANEL, 300.0, 200.0);
    cx.simulate_presented_frame();
    assert_eq!(
        cx.presented_glass()[0].bounds,
        bounds(0.0, 0.0, 300.0, 200.0)
    );
    // The frame that first draws the new size hands the platform its panes
    // with it, not the size before (what `onLayout` over IPC could not do).
    cx.simulate_resize(size(px(360.0), px(240.0)));
    cx.simulate_presented_frame();
    let presented = cx.presented_glass();
    assert_eq!(presented[0].bounds, bounds(0.0, 0.0, 360.0, 240.0));
    assert_eq!(presented[1].bounds, bounds(20.0, 20.0, 320.0, 40.0));
}

#[sumi::test]
fn a_pane_inside_a_kept_subtree_is_painted_every_frame(cx: &mut TestAppContext) {
    // The group would be kept from frame to frame (`retain.rs`) but for the
    // pane inside it: a kept drawing paints no glass.
    let tree = r##"{"type":"view","props":{"id":"1","fill":true},"children":[
      {"type":"view","props":{"id":"group","padding":4},"children":[
        {"type":"view","props":{"id":"pane","height":20,"material":"regular"}},
        {"type":"view","props":{"id":"a","height":10,"background":"#101010"}},
        {"type":"view","props":{"id":"b","height":10,"background":"#202020"}},
        {"type":"view","props":{"id":"c","height":10,"background":"#303030"}}]}]}"##;
    let cx = open(cx, tree, 300.0, 200.0);
    for frame in 0..3 {
        let (panes, _) = cx.update(|window, cx| {
            let _ = window.draw(cx);
            (window.last_glass_drawn(), ())
        });
        assert_eq!(panes.len(), 1, "frame {frame}");
    }
}
