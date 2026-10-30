//! Window surface roles beyond ordinary toplevels: a `surface` description
//! (the `windows.*.surface` shape in docs/api-design.md §1a) parsed into
//! GPUI's layer-shell options, or a session-lock surface (`role: "lock"`,
//! which takes no other options). `popup` is reserved.

use gpui::{KeyboardInteractivity, Layer, LayerAnchor, LayerMargin, LayerShellOptions};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SurfaceSpec {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    layer: Option<String>,
    #[serde(default)]
    anchor: Vec<String>,
    #[serde(default)]
    exclusive_zone: Option<i32>,
    #[serde(default)]
    keyboard: Option<String>,
    #[serde(default)]
    margin: Option<MarginSpec>,
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    output: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum MarginSpec {
    All(i32),
    Edges {
        #[serde(default)]
        top: i32,
        #[serde(default)]
        right: i32,
        #[serde(default)]
        bottom: i32,
        #[serde(default)]
        left: i32,
    },
}

/// What a window opens as.
#[derive(Clone, Debug)]
pub enum Surface {
    Layer(LayerShellOptions),
    /// Locks the session; it unlocks only on `{"unlock": true}` from the
    /// driver, never because the process went away.
    Lock,
}

/// Parse a surface description; `namespace` defaults to `fallback_namespace`
/// (the window title).
pub fn parse_surface(json: &str, fallback_namespace: &str) -> Result<Surface, String> {
    let spec: SurfaceSpec =
        serde_json::from_str(json).map_err(|error| format!("invalid surface: {error}"))?;
    match spec.role.as_deref() {
        None | Some("layer") => {}
        Some("lock") => {
            let layered = spec.layer.is_some()
                || !spec.anchor.is_empty()
                || spec.exclusive_zone.is_some()
                || spec.keyboard.is_some()
                || spec.margin.is_some()
                || spec.namespace.is_some();
            if layered || spec.output.is_some() {
                return Err("a lock surface takes no other options".into());
            }
            return Ok(Surface::Lock);
        }
        Some("popup") => return Err("surface role \"popup\" is not supported yet".into()),
        Some(role) => return Err(format!("unknown surface role \"{role}\"")),
    }
    // One screen by its output name ("eDP-1"); "all" (a surface per screen)
    // is the driver's to do, by opening one host per screen.
    let output = match spec.output {
        None => None,
        Some(name)
            if !name.is_empty()
                && name.len() <= 64
                && name != "all"
                && name.chars().all(|c| c.is_ascii_graphic()) =>
        {
            Some(name)
        }
        Some(name) => {
            return Err(format!(
                "surface output must be one screen's name, got \"{name}\""
            ))
        }
    };
    let layer = match spec.layer.as_deref() {
        None | Some("top") => Layer::Top,
        Some("background") => Layer::Background,
        Some("bottom") => Layer::Bottom,
        Some("overlay") => Layer::Overlay,
        Some(other) => return Err(format!("unknown surface layer \"{other}\"")),
    };
    let mut anchor = LayerAnchor::default();
    for edge in &spec.anchor {
        match edge.as_str() {
            "top" => anchor.top = true,
            "bottom" => anchor.bottom = true,
            "left" => anchor.left = true,
            "right" => anchor.right = true,
            other => return Err(format!("unknown surface anchor \"{other}\"")),
        }
    }
    let keyboard_interactivity = match spec.keyboard.as_deref() {
        None | Some("none") => KeyboardInteractivity::None,
        Some("on-demand") => KeyboardInteractivity::OnDemand,
        Some("exclusive") => KeyboardInteractivity::Exclusive,
        Some(other) => return Err(format!("unknown surface keyboard policy \"{other}\"")),
    };
    let exclusive_zone = spec.exclusive_zone.unwrap_or(0);
    if exclusive_zone < -1 {
        return Err(format!(
            "surface exclusiveZone must be -1 or more, got {exclusive_zone}"
        ));
    }
    let margin = match spec.margin {
        None => LayerMargin::default(),
        Some(MarginSpec::All(all)) => LayerMargin {
            top: all,
            right: all,
            bottom: all,
            left: all,
        },
        Some(MarginSpec::Edges {
            top,
            right,
            bottom,
            left,
        }) => LayerMargin {
            top,
            right,
            bottom,
            left,
        },
    };
    let namespace = spec
        .namespace
        .filter(|namespace| !namespace.is_empty())
        .unwrap_or_else(|| fallback_namespace.to_string());
    Ok(Surface::Layer(LayerShellOptions {
        namespace,
        layer,
        anchor,
        exclusive_zone,
        margin,
        keyboard_interactivity,
        output,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(json: &str, title: &str) -> LayerShellOptions {
        match parse_surface(json, title).unwrap() {
            Surface::Layer(options) => options,
            Surface::Lock => panic!("{json} parsed as a lock surface"),
        }
    }

    #[test]
    fn parses_a_panel() {
        let options = layer(
            r#"{"layer":"top","anchor":["top","left","right"],"exclusiveZone":28,"keyboard":"on-demand","namespace":"menubar"}"#,
            "title",
        );
        assert_eq!(options.layer, Layer::Top);
        assert_eq!(
            options.anchor,
            LayerAnchor {
                top: true,
                bottom: false,
                left: true,
                right: true
            }
        );
        assert_eq!(options.exclusive_zone, 28);
        assert_eq!(
            options.keyboard_interactivity,
            KeyboardInteractivity::OnDemand
        );
        assert_eq!(options.namespace, "menubar");
        assert_eq!(options.output, None);
    }

    #[test]
    fn a_surface_can_name_its_screen() {
        assert_eq!(
            layer(r#"{"output":"DP-2"}"#, "x").output.as_deref(),
            Some("DP-2")
        );
        for json in [r#"{"output":""}"#, r#"{"output":"two words"}"#] {
            assert!(
                parse_surface(json, "x").is_err(),
                "{json} should be rejected"
            );
        }
    }

    #[test]
    fn defaults_and_margins() {
        let options = layer(r#"{"anchor":["bottom"],"margin":8}"#, "Dock");
        assert_eq!(options.layer, Layer::Top);
        assert_eq!(options.exclusive_zone, 0);
        assert_eq!(options.keyboard_interactivity, KeyboardInteractivity::None);
        assert_eq!(options.namespace, "Dock");
        assert_eq!(options.margin.bottom, 8);
        assert_eq!(options.margin.left, 8);

        let options = layer(r#"{"margin":{"bottom":6}}"#, "x");
        assert_eq!(
            options.margin,
            LayerMargin {
                top: 0,
                right: 0,
                bottom: 6,
                left: 0
            }
        );
    }

    #[test]
    fn lock_surfaces_take_nothing_else() {
        assert!(matches!(
            parse_surface(r#"{"role":"lock"}"#, "x"),
            Ok(Surface::Lock)
        ));
        assert!(parse_surface(r#"{"role":"lock","layer":"overlay"}"#, "x").is_err());
        assert!(parse_surface(r#"{"role":"lock","namespace":"lock"}"#, "x").is_err());
    }

    #[test]
    fn rejects_unsupported_and_unknown_values() {
        for json in [
            r#"{"role":"popup"}"#,
            r#"{"role":"window"}"#,
            r#"{"layer":"middle"}"#,
            r#"{"anchor":["center"]}"#,
            r#"{"keyboard":"always"}"#,
            r#"{"exclusiveZone":-2}"#,
            r#"{"output":"all"}"#,
            r#"{"exclusive":28}"#,
            "not json",
        ] {
            assert!(
                parse_surface(json, "x").is_err(),
                "{json} should be rejected"
            );
        }
    }
}
