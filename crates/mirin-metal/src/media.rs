//! Vector icons and raster images. SVG markup arrives inline in the tree;
//! GPUI loads SVGs through an `AssetSource` by path, so each distinct markup
//! is registered under a content-hash path the element can reference.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Mutex, OnceLock};

use sumi::{div, img, prelude::*, px, rgba, svg, AnyElement, AssetSource, ObjectFit, SharedString};

use crate::tree::{parse_color, ImageProps, SvgProps};
use crate::window::RootView;

/// Prefix of the virtual asset paths that hold registered SVG markup.
const SVG_PREFIX: &str = "mirin-metal/svg/";

fn registry() -> &'static Mutex<HashMap<String, Vec<u8>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register `markup` and return the asset path that resolves to it.
pub(crate) fn register_svg(markup: &str) -> String {
    let mut hasher = DefaultHasher::new();
    markup.hash(&mut hasher);
    let path = format!("{SVG_PREFIX}{:016x}.svg", hasher.finish());
    let mut map = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    map.entry(path.clone())
        .or_insert_with(|| markup.as_bytes().to_vec());
    path
}

/// Serves registered SVG markup to GPUI.
pub(crate) struct MetalAssets;

impl AssetSource for MetalAssets {
    fn load(&self, path: &str) -> sumi::Result<Option<Cow<'static, [u8]>>> {
        let map = registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(map.get(path).map(|bytes| Cow::Owned(bytes.clone())))
    }

    fn list(&self, path: &str) -> sumi::Result<Vec<SharedString>> {
        let map = registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(map
            .keys()
            .filter(|key| key.starts_with(path))
            .map(|key| SharedString::from(key.clone()))
            .collect())
    }
}

pub(crate) fn render_svg(props: &SvgProps) -> AnyElement {
    if props.markup.is_empty() {
        return div().into_any_element();
    }
    let path = register_svg(&props.markup);
    let width = props.width.or(props.size).unwrap_or(16.0);
    let height = props.height.or(props.size).unwrap_or(16.0);
    let mut element = svg().path(path).w(px(width)).h(px(height)).flex_shrink_0();
    let color = props
        .color
        .as_deref()
        .and_then(parse_color)
        .unwrap_or(0xffffffff);
    element = element.text_color(rgba(color));
    if let Some(opacity) = props.opacity {
        element = element.opacity(opacity);
    }
    element.into_any_element()
}

/// In the host binary while an image that cannot be drawn tells the driver
/// (`onError`); its `protocol` line says `"imageError":true`.
pub const IMAGE_ERROR_MARKER: &str = "MIRIN_METAL_IMAGE_ERROR";

/// The images whose failure the driver has heard of: each node's id, and
/// the file it was then. An image is asked for its stand-in every frame it
/// cannot be drawn; the driver hears once for each file.
#[derive(Clone, Default)]
pub(crate) struct ImageErrors(Rc<RefCell<HashMap<String, String>>>);

/// Past this many, the ones whose nodes have left the tree are forgotten.
const ERRORS_KEPT: usize = 256;

impl ImageErrors {
    /// Whether the failure of node `id`'s file `src` is news.
    fn is_news(&self, id: &str, src: &str) -> bool {
        let mut told = self.0.borrow_mut();
        if told.get(id).is_some_and(|file| file == src) {
            return false;
        }
        told.insert(id.to_owned(), src.to_owned());
        true
    }

    /// Node `id` now shows `src`: a failure told of another file is behind it.
    fn shows(&self, id: &str, src: &str) {
        let mut told = self.0.borrow_mut();
        if told.get(id).is_some_and(|file| file != src) {
            told.remove(id);
        }
    }

    /// Forget the nodes no longer in the tree, once there are many.
    pub(crate) fn prune(&self, in_tree: impl Fn(&str) -> bool) {
        let mut told = self.0.borrow_mut();
        if told.len() > ERRORS_KEPT {
            told.retain(|id, _| in_tree(id));
        }
    }
}

/// Why a file could not be drawn, in a few words: it is asked once the
/// engine has failed to load it, so the file is looked at again only then.
fn why(src: &str) -> &'static str {
    match std::fs::metadata(src) {
        Ok(file) if file.is_file() => "not an image the host can decode",
        Ok(_) => "not a file",
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "no such file",
        Err(_) => "the file cannot be read",
    }
}

pub(crate) fn render_image(props: &ImageProps, view: &RootView) -> AnyElement {
    if props.src.is_empty() {
        return div().into_any_element();
    }
    let mut element = img(PathBuf::from(&props.src)).object_fit(if props.cover {
        ObjectFit::Cover
    } else {
        ObjectFit::Contain
    });
    // An image that cannot be drawn is drawn as nothing, as before; the
    // engine asks for this stand-in when loading it has failed (a file that
    // is not there, or one it has no decoder for), which is when a driver
    // that listens is told.
    if let (true, Some(id)) = (props.on_error, props.id.clone()) {
        view.image_errors.shows(&id, &props.src);
        let (events, told, src) = (
            view.events.clone(),
            view.image_errors.clone(),
            props.src.clone(),
        );
        element = element.with_fallback(move || {
            if told.is_news(&id, &src) {
                events.image_error(&id, why(&src));
            }
            div().into_any_element()
        });
    }
    if let Some(width) = props.width {
        element = element.w(px(width));
    }
    if let Some(height) = props.height {
        element = element.h(px(height));
    }
    if props.fill {
        element = element.size_full();
    }
    if props.corner_radius > 0.0 {
        element = element.rounded(px(props.corner_radius));
    }
    if let Some(opacity) = props.opacity {
        element = element.opacity(opacity);
    }
    element.into_any_element()
}

#[cfg(test)]
mod image_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_markup_under_a_stable_path() {
        let markup = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>"#;
        let first = register_svg(markup);
        let second = register_svg(markup);
        assert_eq!(first, second);
        assert!(first.starts_with(SVG_PREFIX));
        let loaded = MetalAssets.load(&first).expect("load").expect("registered");
        assert_eq!(loaded.as_ref(), markup.as_bytes());
        assert!(MetalAssets
            .load("mirin-metal/svg/missing.svg")
            .expect("load")
            .is_none());
    }
}
