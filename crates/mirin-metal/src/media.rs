//! Vector icons and raster images. SVG markup arrives inline in the tree;
//! GPUI loads SVGs through an `AssetSource` by path, so each distinct markup
//! is registered under a content-hash path the element can reference.

use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use gpui::{div, img, prelude::*, px, rgba, svg, AnyElement, AssetSource, ObjectFit, SharedString};

use crate::tree::{parse_color, ImageProps, SvgProps};

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
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>> {
        let map = registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(map.get(path).map(|bytes| Cow::Owned(bytes.clone())))
    }

    fn list(&self, path: &str) -> gpui::Result<Vec<SharedString>> {
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

pub(crate) fn render_image(props: &ImageProps) -> AnyElement {
    if props.src.is_empty() {
        return div().into_any_element();
    }
    let mut element = img(PathBuf::from(&props.src)).object_fit(if props.cover {
        ObjectFit::Cover
    } else {
        ObjectFit::Contain
    });
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
