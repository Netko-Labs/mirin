//! Upstream GPUI's layer tests (`forks/zed/crates/gpui/src/scene.rs`), run
//! here on its public API: mirin's fork inserts every primitive through its
//! own `insert_op` (a quad's strips, the mask it is drawn under, a copied
//! drawing's primitives), and GPUI's own tests need zed's workspace.

use sumi::{point, size, Bounds, ContentMask, Hsla, Quad, ScaledPixels, Scene, Underline};

fn square(x: f32) -> Bounds<ScaledPixels> {
    Bounds {
        origin: point(ScaledPixels(x), ScaledPixels(0.)),
        size: size(ScaledPixels(10.), ScaledPixels(10.)),
    }
}

fn quad(x: f32) -> Quad {
    Quad {
        bounds: square(x),
        content_mask: ContentMask { bounds: square(x) },
        ..Default::default()
    }
}

fn underline(x: f32) -> Underline {
    Underline {
        order: 0,
        pad: 0,
        bounds: square(x),
        content_mask: ContentMask { bounds: square(x) },
        color: Hsla::default(),
        thickness: ScaledPixels(1.),
        wavy: false.into(),
    }
}

fn batch_labels(scene: &mut Scene) -> Vec<String> {
    scene.finish();
    scene.batches().map(|batch| batch.label()).collect()
}

#[test]
fn layers_are_drawn_in_paint_order() {
    // A quad painted after a layer goes above it.
    let mut scene = Scene::default();
    scene.insert_primitive(quad(0.));
    scene.push_layer();
    scene.insert_primitive(underline(0.));
    scene.insert_primitive(underline(5.));
    scene.pop_layer();
    scene.insert_primitive(quad(5.));
    assert_eq!(
        batch_labels(&mut scene),
        ["quads (1)", "underlines (2)", "quads (1)"]
    );

    // A layer goes above the layer painted before it.
    let mut scene = Scene::default();
    scene.push_layer();
    scene.insert_primitive(underline(0.));
    scene.pop_layer();
    scene.push_layer();
    scene.insert_primitive(quad(5.));
    scene.pop_layer();
    assert_eq!(batch_labels(&mut scene), ["underlines (1)", "quads (1)"]);
}

#[test]
fn nested_layers_are_drawn_above_their_parents() {
    // A layer has one draw order, so what it paints after a nested layer
    // still goes below that layer.
    let mut scene = Scene::default();
    scene.push_layer();
    scene.insert_primitive(underline(0.));
    scene.push_layer();
    scene.insert_primitive(quad(5.));
    scene.pop_layer();
    scene.insert_primitive(underline(5.));
    scene.pop_layer();
    assert_eq!(batch_labels(&mut scene), ["underlines (2)", "quads (1)"]);

    // The same holds when the nested layer shares its parent's order.
    let mut scene = Scene::default();
    scene.push_layer();
    scene.insert_primitive(quad(0.));
    scene.push_layer();
    scene.insert_primitive(quad(5.));
    scene.pop_layer();
    scene.insert_primitive(quad(8.));
    scene.pop_layer();
    assert_eq!(batch_labels(&mut scene), ["quads (3)"]);
    assert_eq!(
        scene
            .quads
            .iter()
            .map(|quad| quad.bounds)
            .collect::<Vec<_>>(),
        [square(0.), square(8.), square(5.)]
    );

    // A layer goes above the layers nested in the layer before it.
    let mut scene = Scene::default();
    scene.push_layer();
    scene.push_layer();
    scene.insert_primitive(underline(0.));
    scene.pop_layer();
    scene.pop_layer();
    scene.push_layer();
    scene.insert_primitive(quad(5.));
    scene.pop_layer();
    assert_eq!(batch_labels(&mut scene), ["underlines (1)", "quads (1)"]);
}

/// Primitives that overlap share a draw order where their kinds are drawn
/// in the order they were painted (upstream's batching), and take a new one
/// where they are not.
#[test]
fn overlapping_primitives_share_an_order_when_their_kinds_draw_in_paint_order() {
    let mut scene = Scene::default();
    scene.insert_primitive(quad(0.));
    scene.insert_primitive(quad(5.));
    scene.insert_primitive(underline(5.));
    assert_eq!(batch_labels(&mut scene), ["quads (2)", "underlines (1)"]);
    assert_eq!(scene.quads[0].order, scene.quads[1].order);
    assert_eq!(scene.underlines[0].order, scene.quads[0].order);

    let mut scene = Scene::default();
    scene.insert_primitive(underline(0.));
    scene.insert_primitive(quad(5.));
    assert_eq!(batch_labels(&mut scene), ["underlines (1)", "quads (1)"]);
    assert!(scene.quads[0].order > scene.underlines[0].order);
}
