//! A text's weight and its display cut: the nine CSS weights drawn as asked
//! (`Weight`), and `display`, the family numbers and large titles are set in.
//!
//! GPUI's text system already finds the face nearest a weight, and draws a
//! variable face (one with a weight axis) at any weight on it (sumi's
//! `cosmic_text_system.rs`); the protocol took only `normal` to `bold`, so a
//! Light or Thin cut was never asked for. A host that takes all nine says
//! `"fontWeights":true` in its `protocol` line, and one that takes a text's
//! `display` says `"displayFont":true`: one from before refuses a tree with
//! either, so a driver sends them only to a host that said so.

use std::sync::OnceLock;

use sumi::{FontWeight, SharedString};

use crate::render::{fontconfig_family, sans_family};
use crate::tree::Weight;

/// In the host binary while it draws all nine weights (`fontWeights`).
pub const FONT_WEIGHTS_MARKER: &str = "MIRIN_METAL_FONT_WEIGHTS";

/// In the host binary while a text may ask for the display cut (`displayFont`).
pub const DISPLAY_FONT_MARKER: &str = "MIRIN_METAL_DISPLAY_FONT";

/// The family a `display` text asks fontconfig for.
const DISPLAY_FAMILY: &str = "Inter Display";

/// The weight GPUI is asked for: CSS's number for each name.
pub(crate) fn font_weight(weight: Weight) -> FontWeight {
    match weight {
        Weight::Thin => FontWeight::THIN,
        Weight::Extralight => FontWeight::EXTRA_LIGHT,
        Weight::Light => FontWeight::LIGHT,
        Weight::Normal => FontWeight::NORMAL,
        Weight::Medium => FontWeight::MEDIUM,
        Weight::Semibold => FontWeight::SEMIBOLD,
        Weight::Bold => FontWeight::BOLD,
        Weight::Extrabold => FontWeight::EXTRA_BOLD,
        Weight::Black => FontWeight::BLACK,
    }
}

/// The display cut's family, resolved once: `MIRIN_METAL_DISPLAY_FONT`, else
/// `Inter Display` when fontconfig has it, else the sans family (a desktop
/// without it draws display text as any other).
pub(crate) fn display_family() -> SharedString {
    static FAMILY: OnceLock<SharedString> = OnceLock::new();
    FAMILY
        .get_or_init(|| {
            let named = std::env::var("MIRIN_METAL_DISPLAY_FONT").ok();
            let found = fontconfig_family(DISPLAY_FAMILY).map(|family| family.to_string());
            pick_display(named.as_deref(), found.as_deref())
                .map(SharedString::from)
                .unwrap_or_else(sans_family)
        })
        .clone()
}

/// The display family from the override and what fontconfig matched for
/// `Inter Display`. fontconfig always matches something, so its answer
/// counts only when it is that family; `None` falls back to the sans one.
fn pick_display(named: Option<&str>, matched: Option<&str>) -> Option<String> {
    if let Some(named) = named.map(str::trim).filter(|named| !named.is_empty()) {
        return Some(named.to_owned());
    }
    matched
        .filter(|family| family.eq_ignore_ascii_case(DISPLAY_FAMILY))
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::{font_weight, pick_display};
    use crate::tree::{parse_tree, NodeSpec, Weight};
    use sumi::FontWeight;

    fn text_weight(json_weight: &str) -> Weight {
        let json = format!(
            r#"{{"type":"text","props":{{"weight":"{json_weight}","display":true}},"children":["42"]}}"#
        );
        match parse_tree(&json).expect("a named weight parses") {
            NodeSpec::Text { props, .. } => {
                assert!(props.display);
                props.weight
            }
            other => panic!("not a text: {other:?}"),
        }
    }

    #[test]
    fn the_light_weights_are_drawn_as_asked_not_clamped_to_normal() {
        // Before, "light" did not parse and nothing lighter than 400 was asked of GPUI.
        let asked = [
            ("thin", 100.0),
            ("extralight", 200.0),
            ("light", 300.0),
            ("normal", 400.0),
            ("medium", 500.0),
            ("semibold", 600.0),
            ("bold", 700.0),
            ("extrabold", 800.0),
            ("black", 900.0),
        ];
        for (name, number) in asked {
            assert_eq!(font_weight(text_weight(name)), FontWeight(number), "{name}");
        }
    }

    #[test]
    fn an_unknown_weight_is_refused() {
        let json = r#"{"type":"text","props":{"weight":"300"},"children":["42"]}"#;
        assert!(
            parse_tree(json).is_err(),
            "numbers are the driver's to name"
        );
    }

    #[test]
    fn the_display_cut_is_inter_display_only_when_fontconfig_has_it() {
        assert_eq!(
            pick_display(None, Some("Inter Display")).as_deref(),
            Some("Inter Display")
        );
        // fontconfig matched its nearest: not the display cut, so the sans family.
        assert_eq!(pick_display(None, Some("Noto Sans")), None);
        assert_eq!(pick_display(None, None), None);
        // The override wins, blank is no override.
        assert_eq!(
            pick_display(Some(" Fira Sans "), Some("Inter Display")).as_deref(),
            Some("Fira Sans")
        );
        assert_eq!(
            pick_display(Some("  "), Some("Inter Display")).as_deref(),
            Some("Inter Display")
        );
    }
}
