//! Element-tree spec: the JSON envelope a UI driver (the React reconciler in
//! `@mirinjs/metal`) sends to describe what to render. Parsed with serde at
//! the trust boundary; unknown fields are rejected so driver bugs surface
//! instead of silently rendering wrong.

use serde::Deserialize;

pub use crate::grid::GridTrack;

/// One node in the UI tree. The JSON shape is React-element-like:
/// `{"type":"view","props":{...},"children":[...]}`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum NodeSpec {
    View {
        /// Boxed: views carry far more props than the other node types.
        #[serde(default)]
        props: Box<ViewProps>,
        #[serde(default)]
        children: Vec<NodeSpec>,
    },
    Text {
        #[serde(default)]
        props: TextProps,
        /// A text node's children are its string content, concatenated.
        #[serde(default)]
        children: Vec<String>,
    },
    /// A single- or multi-line text field. Editing state (buffer, caret, focus)
    /// lives in the renderer; the driver receives `change`/`submit` events and
    /// may reset the contents through `value`.
    Input { props: InputProps },
    /// A vector icon: inline SVG markup drawn as a mask tinted with `color`.
    Svg { props: SvgProps },
    /// A raster image from a local file path.
    Image { props: ImageProps },
}

/// Props for an `svg` node.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SvgProps {
    /// Complete `<svg>` document. Strokes and fills become the mask; the
    /// renderer paints it with `color`.
    pub markup: String,
    pub size: Option<f32>,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub color: Option<String>,
    pub opacity: Option<f32>,
}

/// Props for an `image` node.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageProps {
    /// Absolute path to a PNG/JPEG/GIF/WebP/SVG file.
    pub src: String,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub fill: bool,
    pub corner_radius: f32,
    /// `cover` crops to fill the box; `contain` (default) letterboxes.
    pub cover: bool,
    pub opacity: Option<f32>,
}

/// Layout/appearance props for a `view` node (flexbox-flavored, like RN).
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewProps {
    /// Stable identity; required for interaction (`onPress`, `hoverBackground`)
    /// and for scrolling, which keeps per-element state.
    pub id: Option<String>,
    pub direction: Direction,
    pub gap: f32,
    pub padding: f32,
    pub padding_x: Option<f32>,
    pub padding_y: Option<f32>,
    pub padding_top: Option<f32>,
    pub padding_bottom: Option<f32>,
    pub padding_left: Option<f32>,
    pub padding_right: Option<f32>,
    /// Margins in px (negative allowed). `*Auto` pushes the node away, like
    /// CSS `margin-left: auto`.
    pub margin_top: Option<f32>,
    pub margin_bottom: Option<f32>,
    pub margin_left: Option<f32>,
    pub margin_right: Option<f32>,
    pub margin_left_auto: bool,
    pub margin_right_auto: bool,
    pub margin_top_auto: bool,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub min_width: Option<f32>,
    pub min_height: Option<f32>,
    pub max_width: Option<f32>,
    pub max_height: Option<f32>,
    /// Take the node out of flow and place it against its nearest `relative`
    /// ancestor (or the window) using `top`/`left`/`right`/`bottom`.
    pub absolute: bool,
    /// Anchor for absolute descendants.
    pub relative: bool,
    pub top: Option<f32>,
    pub left: Option<f32>,
    pub right: Option<f32>,
    pub bottom: Option<f32>,
    /// Width/height as a fraction (0..1) of the parent.
    pub width_percent: Option<f32>,
    pub height_percent: Option<f32>,
    /// Width / height ratio, e.g. `1.777` for 16:9.
    pub aspect_ratio: Option<f32>,
    /// Wrap children onto new lines along the main axis.
    pub wrap: bool,
    /// `flex > 0` grows into the remaining main-axis space from a zero basis
    /// (CSS `flex: N 1 0%`, React Native `flex: N`), so the content need not
    /// be measured first.
    pub flex: f32,
    /// `grow > 0` grows from the content size (CSS `flex-grow` with
    /// `flex-basis: auto`).
    pub grow: f32,
    /// `false` keeps the node from shrinking below its content.
    pub shrink: Option<bool>,
    /// Fill the parent on both axes (root views typically set this).
    pub fill: bool,
    /// Center children on both axes (shorthand for align + justify center).
    pub center: bool,
    pub align: Option<Align>,
    pub justify: Option<Justify>,
    /// Background color, `#RGB`, `#RRGGBB`, or `#RRGGBBAA`.
    pub background: Option<String>,
    /// Background while hovered (needs `id`).
    pub hover_background: Option<String>,
    pub corner_radius: f32,
    /// Border width in px; 0 (default) draws none.
    pub border_width: f32,
    /// Per-side border widths in px; override `borderWidth` for that side.
    pub border_top: Option<f32>,
    pub border_bottom: Option<f32>,
    pub border_left: Option<f32>,
    pub border_right: Option<f32>,
    /// Drop shadow preset: `xs`, `sm`, `md`, `lg`, `xl`.
    pub shadow: Option<String>,
    pub border_color: Option<String>,
    /// Scroll overflowing children vertically (needs `id`).
    pub scroll: bool,
    /// Scroll overflowing children horizontally (needs `id`).
    pub scroll_x: bool,
    /// Clip overflowing children.
    pub clip: bool,
    pub opacity: Option<f32>,
    /// Emit a `press` event carrying this node's `id` on click/tap.
    pub on_press: bool,
    /// Emit `hover` events (`hovered: true|false`) for this node (needs `id`).
    pub on_hover: bool,
    /// Emit `pointer` events (down on this node, then move/up anywhere until
    /// release) with window coordinates and this node's bounds (needs `id`).
    pub on_pointer: bool,
    /// Emit `contextmenu` on right-click with window coordinates (needs `id`).
    pub on_context_menu: bool,
    /// Take the keyboard (focused when the node appears and when pressed)
    /// and emit `keydown` for every key, with its modifiers and the text it
    /// types (needs `id`). For views that handle raw keys themselves: a
    /// terminal, a game.
    pub on_key_down: bool,
    /// Emit `wheel` with the scroll delta, in lines (needs `id`).
    pub on_wheel: bool,
    /// Stop pointer events from reaching nodes painted underneath (overlays).
    pub occlude: bool,
    /// A press here moves the window and a double click zooms it, as on a
    /// title bar (needs `id`). Descendants with their own `onPress`,
    /// `onPointer`, or an `input` keep the clicks on them.
    pub drag_region: bool,
    /// Emit a `layout` event with this node's bounds whenever they change
    /// (needs `id`). Popups use it to measure themselves and the window.
    pub on_layout: bool,
    /// Override the parent's cross-axis alignment for this node.
    pub align_self: Option<Align>,
    /// Lay children out as a CSS grid (`grid.rs`) instead of a flex line.
    pub grid: bool,
    /// `grid-template-columns`; without it the grid has one implicit column.
    pub grid_columns: Option<Vec<GridTrack>>,
    /// `grid-template-rows`; rows are implicit (`auto`) otherwise.
    pub grid_rows: Option<Vec<GridTrack>>,
    /// Inline-axis alignment of grid items (CSS `justify-items`).
    pub justify_items: Option<Align>,
    /// This grid item's inline-axis alignment (CSS `justify-self`).
    pub justify_self: Option<Align>,
    /// Grid placement of this node: 1-based lines (negative counts from the
    /// end) and spans, as in CSS `grid-column` / `grid-row`.
    pub col_start: Option<i16>,
    pub col_end: Option<i16>,
    pub col_span: Option<u16>,
    pub row_start: Option<i16>,
    pub row_end: Option<i16>,
    pub row_span: Option<u16>,
    /// Gap between columns / rows, overriding `gap` on that axis.
    pub gap_x: Option<f32>,
    pub gap_y: Option<f32>,
}

/// Appearance props for a `text` node.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TextProps {
    /// Text color, `#RGB`, `#RRGGBB`, or `#RRGGBBAA`.
    pub color: Option<String>,
    /// Font size in pixels.
    pub size: Option<f32>,
    pub weight: Weight,
    /// Use the system monospace family.
    pub mono: bool,
    /// Keep on one line and end with an ellipsis instead of wrapping.
    pub truncate: bool,
    pub opacity: Option<f32>,
    pub align: Option<TextAlign>,
    pub italic: bool,
    pub underline: bool,
    pub line_through: bool,
    /// Line height in pixels.
    pub line_height: Option<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    Left,
    Center,
    Right,
}

/// Props for an `input` node.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputProps {
    /// Required: keys the editing state and the events.
    pub id: String,
    /// Driver-owned value. When it changes between trees the buffer is reset.
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub placeholder: Option<String>,
    /// Enter inserts a newline; Ctrl/Cmd+Enter submits.
    #[serde(default)]
    pub multiline: bool,
    /// Render bullets instead of the text (passwords).
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub mono: bool,
    #[serde(default)]
    pub size: Option<f32>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub placeholder_color: Option<String>,
    #[serde(default)]
    pub background: Option<String>,
    #[serde(default)]
    pub padding: f32,
    #[serde(default)]
    pub corner_radius: f32,
    #[serde(default)]
    pub border_color: Option<String>,
    #[serde(default)]
    pub focus_border_color: Option<String>,
    #[serde(default)]
    pub width: Option<f32>,
    /// Width as a fraction (0..1) of the parent, e.g. 1 for CSS `width: 100%`.
    #[serde(default)]
    pub width_percent: Option<f32>,
    #[serde(default)]
    pub height: Option<f32>,
    #[serde(default)]
    pub min_height: Option<f32>,
    #[serde(default)]
    pub flex: f32,
    #[serde(default)]
    pub fill: bool,
    /// Focus this input when it first appears.
    #[serde(default)]
    pub autofocus: bool,
    #[serde(default)]
    pub on_change: bool,
    #[serde(default)]
    pub on_submit: bool,
    /// Report Escape, ArrowUp, and ArrowDown (a launcher's list navigation).
    #[serde(default)]
    pub on_key: bool,
}

impl Default for InputProps {
    fn default() -> Self {
        Self {
            id: String::new(),
            value: String::new(),
            placeholder: None,
            multiline: false,
            secure: false,
            mono: false,
            size: None,
            color: None,
            placeholder_color: None,
            background: None,
            padding: 0.0,
            corner_radius: 0.0,
            border_color: None,
            focus_border_color: None,
            width: None,
            width_percent: None,
            height: None,
            min_height: None,
            flex: 0.0,
            fill: false,
            autofocus: false,
            on_change: false,
            on_submit: false,
            on_key: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    #[default]
    Column,
    Row,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    Start,
    Center,
    End,
    Stretch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Justify {
    Start,
    Center,
    End,
    Between,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Weight {
    #[default]
    Normal,
    Medium,
    Semibold,
    Bold,
}

/// Parse a UI tree from its JSON envelope.
pub fn parse_tree(json: &str) -> Result<NodeSpec, serde_json::Error> {
    serde_json::from_str(json)
}

/// Parse `#RGB`, `#RRGGBB`, or `#RRGGBBAA` into a `0xRRGGBBAA` value. Strict:
/// anything else is rejected (the driver is a trust boundary, not a place for
/// lenient parsing).
pub(crate) fn parse_color(value: &str) -> Option<u32> {
    let hex = value.strip_prefix('#')?;
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        3 => {
            let short = u32::from_str_radix(hex, 16).ok()?;
            let (r, g, b) = ((short >> 8) & 0xf, (short >> 4) & 0xf, short & 0xf);
            Some(((r * 0x11) << 24) | ((g * 0x11) << 16) | ((b * 0x11) << 8) | 0xff)
        }
        6 => u32::from_str_radix(hex, 16)
            .ok()
            .map(|rgb| (rgb << 8) | 0xff),
        8 => u32::from_str_radix(hex, 16).ok(),
        _ => None,
    }
}

/// Walk the tree and collect every input node, in document order.
pub(crate) fn collect_inputs<'a>(node: &'a NodeSpec, out: &mut Vec<&'a InputProps>) {
    match node {
        NodeSpec::View { children, .. } => {
            for child in children {
                collect_inputs(child, out);
            }
        }
        NodeSpec::Text { .. } | NodeSpec::Svg { .. } | NodeSpec::Image { .. } => {}
        NodeSpec::Input { props } => out.push(props),
    }
}

/// Ids of scrollable views, for pruning renderer-owned scroll state.
pub(crate) fn collect_scroll_ids(node: &NodeSpec, out: &mut std::collections::HashSet<String>) {
    if let NodeSpec::View { props, children } = node {
        if props.scroll || props.scroll_x {
            if let Some(id) = &props.id {
                out.insert(id.clone());
            }
        }
        for child in children {
            collect_scroll_ids(child, out);
        }
    }
}

/// Ids of views that take raw keys (`onKeyDown`), in document order.
pub(crate) fn collect_key_ids(node: &NodeSpec, out: &mut Vec<String>) {
    if let NodeSpec::View { props, children } = node {
        if props.on_key_down {
            if let Some(id) = &props.id {
                out.push(id.clone());
            }
        }
        for child in children {
            collect_key_ids(child, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_views_are_collected() {
        let tree = parse_tree(
            r##"{"type":"view","props":{"id":"root"},"children":[{"type":"view","props":{"id":"term","onKeyDown":true,"onWheel":true}}]}"##,
        )
        .expect("onKeyDown and onWheel must parse");
        let mut ids = Vec::new();
        collect_key_ids(&tree, &mut ids);
        assert_eq!(ids, vec!["term".to_string()]);
    }

    #[test]
    fn drag_region_is_a_view_prop() {
        let tree = parse_tree(r##"{"type":"view","props":{"id":"bar","dragRegion":true}}"##)
            .expect("a drag region must parse");
        let NodeSpec::View { props, .. } = &tree else {
            panic!("root must be a view");
        };
        assert!(props.drag_region);
        let plain = parse_tree(r##"{"type":"view","props":{"id":"bar"}}"##).expect("plain view");
        let NodeSpec::View { props, .. } = &plain else {
            panic!("root must be a view");
        };
        assert!(!props.drag_region);
    }

    #[test]
    fn parses_a_nested_tree() {
        let tree = parse_tree(
            r##"{
              "type": "view",
              "props": {"direction": "row", "gap": 8, "background": "#111114", "fill": true},
              "children": [
                {"type": "text", "props": {"size": 24, "color": "#f4f4f5", "weight": "bold"}, "children": ["hello"]},
                {"type": "view", "props": {"id": "cta", "onPress": true, "scroll": true}},
                {"type": "input", "props": {"id": "sql", "value": "select 1", "multiline": true, "onSubmit": true}}
              ]
            }"##,
        )
        .expect("valid tree must parse");
        let NodeSpec::View { props, children } = &tree else {
            panic!("root must be a view");
        };
        assert_eq!(props.direction, Direction::Row);
        assert_eq!(props.gap, 8.0);
        assert!(props.fill);
        assert_eq!(children.len(), 3);
        let NodeSpec::View { props, .. } = &children[1] else {
            panic!("second child must be a view");
        };
        assert_eq!(props.id.as_deref(), Some("cta"));
        assert!(props.on_press && props.scroll);
        let mut inputs = Vec::new();
        collect_inputs(&tree, &mut inputs);
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].id, "sql");
        assert!(inputs[0].multiline && inputs[0].on_submit);
    }

    #[test]
    fn rejects_unknown_fields_and_types() {
        assert!(parse_tree(r#"{"type":"canvas","props":{}}"#).is_err());
        assert!(parse_tree(r#"{"type":"view","props":{"bogus":1}}"#).is_err());
        assert!(parse_tree(r#"{"type":"input","props":{"value":"x"}}"#).is_err());
    }

    #[test]
    fn parses_colors_strictly() {
        assert_eq!(parse_color("#fff"), Some(0xffffffff));
        assert_eq!(parse_color("#123456"), Some(0x123456ff));
        assert_eq!(parse_color("#12345680"), Some(0x12345680));
        assert_eq!(parse_color("#12345"), None);
        assert_eq!(parse_color("#gggggg"), None);
        assert_eq!(parse_color("123456"), None);
    }
}
