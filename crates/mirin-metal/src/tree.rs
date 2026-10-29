//! Element-tree spec: the JSON envelope a UI driver (eventually the React
//! reconciler in the Bun Worker, via FFI) sends to describe what to render.
//! Parsed with serde at the trust boundary; unknown fields are rejected so
//! driver bugs surface instead of silently rendering wrong.

use serde::Deserialize;

/// One node in the UI tree. The JSON shape is React-element-like:
/// `{"type":"view","props":{...},"children":[...]}`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum NodeSpec {
    View {
        #[serde(default)]
        props: ViewProps,
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
}

/// Layout/appearance props for a `view` node (flexbox-flavored, like RN).
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewProps {
    /// Stable identity; required for interaction events (`onPress`).
    pub id: Option<String>,
    pub direction: Direction,
    pub gap: f32,
    pub padding: f32,
    pub width: Option<f32>,
    pub height: Option<f32>,
    /// Fill the parent on both axes (root views typically set this).
    pub fill: bool,
    /// Center children on both axes.
    pub center: bool,
    /// Background color, `#RGB` or `#RRGGBB`.
    pub background: Option<String>,
    pub corner_radius: f32,
    /// Emit a `press` event carrying this node's `id` on click/tap.
    pub on_press: bool,
}

/// Appearance props for a `text` node.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TextProps {
    /// Text color, `#RGB` or `#RRGGBB`.
    pub color: Option<String>,
    /// Font size in pixels.
    pub size: Option<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    #[default]
    Column,
    Row,
}

/// Parse a UI tree from its JSON envelope.
pub fn parse_tree(json: &str) -> Result<NodeSpec, serde_json::Error> {
    serde_json::from_str(json)
}

/// Parse `#RGB` / `#RRGGBB` into a `0xRRGGBB` value. Strict: anything else is
/// rejected (the driver is a trust boundary, not a place for lenient parsing).
pub(crate) fn parse_color(value: &str) -> Option<u32> {
    let hex = value.strip_prefix('#')?;
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        3 => {
            let short = u32::from_str_radix(hex, 16).ok()?;
            let (r, g, b) = ((short >> 8) & 0xf, (short >> 4) & 0xf, short & 0xf);
            Some((r * 0x11) << 16 | (g * 0x11) << 8 | (b * 0x11))
        }
        6 => u32::from_str_radix(hex, 16).ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_nested_tree() {
        let tree = parse_tree(
            r##"{
              "type": "view",
              "props": {"direction": "row", "gap": 8, "background": "#111114", "fill": true},
              "children": [
                {"type": "text", "props": {"size": 24, "color": "#f4f4f5"}, "children": ["hello"]},
                {"type": "view", "props": {"id": "cta", "onPress": true}}
              ]
            }"##,
        )
        .expect("valid tree must parse");
        let NodeSpec::View { props, children } = tree else {
            panic!("root must be a view");
        };
        assert_eq!(props.direction, Direction::Row);
        assert_eq!(props.gap, 8.0);
        assert!(props.fill);
        assert_eq!(children.len(), 2);
        let NodeSpec::View { props, .. } = &children[1] else {
            panic!("second child must be a view");
        };
        assert_eq!(props.id.as_deref(), Some("cta"));
        assert!(props.on_press);
    }

    #[test]
    fn rejects_unknown_fields_and_types() {
        assert!(parse_tree(r#"{"type":"image","props":{}}"#).is_err());
        assert!(parse_tree(r#"{"type":"view","props":{"bogus":1}}"#).is_err());
    }

    #[test]
    fn parses_colors_strictly() {
        assert_eq!(parse_color("#fff"), Some(0xffffff));
        assert_eq!(parse_color("#123456"), Some(0x123456));
        assert_eq!(parse_color("#12345"), None);
        assert_eq!(parse_color("#gggggg"), None);
        assert_eq!(parse_color("123456"), None);
    }
}
