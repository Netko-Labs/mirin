//! Window surface roles beyond ordinary toplevels: a `surface` description
//! (the `windows.*.surface` shape in docs/api-design.md §1a) parsed into a
//! layer surface, or a session-lock surface (`role: "lock"`, which takes no
//! other options but `opaque` and `output`), and the window options that
//! open it ([`with_role`]).
//! `popup` is reserved.

use serde::Deserialize;
use sumi::{App, WindowOptions};

#[cfg(target_os = "linux")]
pub(crate) use sumi::layer_shell::{KeyboardInteractivity, Layer};

/// A layer surface's layer. Layer surfaces are Wayland's: elsewhere the
/// description parses (the protocol is the same on every platform) and the
/// window opens as a normal one ([`with_role`]).
#[cfg(not(target_os = "linux"))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Layer {
    Background,
    Bottom,
    Top,
    #[default]
    Overlay,
}

/// How a layer surface takes the keyboard; see [`Layer`].
#[cfg(not(target_os = "linux"))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum KeyboardInteractivity {
    None,
    Exclusive,
    #[default]
    OnDemand,
}

/// The screen edges a layer surface is anchored to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LayerAnchor {
    pub top: bool,
    pub bottom: bool,
    pub left: bool,
    pub right: bool,
}

/// A layer surface's distance from the edges it is anchored to, in pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LayerMargin {
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub left: i32,
}

/// A layer surface as the driver describes it.
// Off Linux nothing reads its fields: there is no layer surface to open.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayerSurface {
    pub namespace: String,
    pub layer: Layer,
    pub anchor: LayerAnchor,
    pub exclusive_zone: i32,
    pub margin: LayerMargin,
    pub keyboard_interactivity: KeyboardInteractivity,
    /// The screen by its output name (the engine's `PlatformDisplay::name`);
    /// the compositor picks when unset or when no screen has that name.
    pub output: Option<String>,
    /// The app paints every pixel of it, opaque (`Surface::is_opaque`).
    pub opaque: bool,
}

#[cfg(target_os = "linux")]
impl LayerSurface {
    /// The engine's window kind for it.
    fn window_kind(&self) -> sumi::WindowKind {
        use sumi::{layer_shell::Anchor, px};
        let mut anchor = Anchor::empty();
        anchor.set(Anchor::TOP, self.anchor.top);
        anchor.set(Anchor::BOTTOM, self.anchor.bottom);
        anchor.set(Anchor::LEFT, self.anchor.left);
        anchor.set(Anchor::RIGHT, self.anchor.right);
        sumi::WindowKind::LayerShell(sumi::layer_shell::LayerShellOptions {
            namespace: self.namespace.clone(),
            layer: self.layer,
            anchor,
            exclusive_zone: Some(px(self.exclusive_zone as f32)),
            exclusive_edge: None,
            margin: Some((
                px(self.margin.top as f32),
                px(self.margin.right as f32),
                px(self.margin.bottom as f32),
                px(self.margin.left as f32),
            )),
            keyboard_interactivity: self.keyboard_interactivity,
        })
    }
}

/// `options` for a window of that role: a layer surface or the lock screen;
/// with none, a toplevel. A layer surface that names its screen opens on the
/// display of that name. Off Linux there is neither role: the window is a
/// toplevel.
pub(crate) fn with_role(
    options: WindowOptions,
    surface: Option<&Surface>,
    cx: &App,
) -> WindowOptions {
    let screen = match surface {
        Some(Surface::Layer(layer)) => layer.output.as_deref(),
        Some(Surface::Lock { output, .. }) => output.as_deref(),
        None => None,
    }
    .and_then(|name| {
        cx.displays()
            .into_iter()
            .find(|display| display.name().as_deref() == Some(name))
    })
    .map(|display| display.id());
    #[cfg(target_os = "linux")]
    let kind = match surface {
        Some(Surface::Lock { .. }) => sumi::WindowKind::SessionLock,
        Some(Surface::Layer(layer)) => layer.window_kind(),
        None => sumi::WindowKind::Normal,
    };
    #[cfg(not(target_os = "linux"))]
    let kind = sumi::WindowKind::Normal;
    // A desktop surface is never the active window (most take no keyboard),
    // and the engine draws an inactive window at 30 frames a second at most:
    // a Dock sliding in, a banner, a menu bar's clock were held to that.
    let inactive_frame_interval = match surface {
        Some(_) => None,
        None => options.inactive_frame_interval,
    };
    WindowOptions {
        kind,
        display_id: screen.or(options.display_id),
        inactive_frame_interval,
        ..options
    }
}

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
    #[serde(default)]
    opaque: bool,
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
    Layer(LayerSurface),
    /// Locks the session; it unlocks only on `{"unlock": true}` from the
    /// driver, never because the process went away. `opaque` as a layer
    /// surface's (`Surface::is_opaque`). `output` is the screen it covers,
    /// by name (the first the compositor advertised when unset or unknown):
    /// a lock screen on every screen is one host per screen, as a layer
    /// surface on every screen is.
    Lock {
        opaque: bool,
        output: Option<String>,
    },
}

impl Surface {
    /// The driver said the surface is opaque (`"opaque": true`): its tree
    /// paints every pixel, with no alpha. It is then opened opaque, as a
    /// window is: the compositor is told so and need not blend it over
    /// what is behind, and its text may be antialiased by subpixels, which
    /// needs the colour behind each glyph to be the surface's own
    /// (`text_mode.rs`). Whatever the tree leaves unpainted is black, and
    /// what it paints translucent is over black. Without it a surface is
    /// transparent where its tree is, and its text is in grays.
    pub fn is_opaque(&self) -> bool {
        match self {
            Self::Layer(layer) => layer.opaque,
            Self::Lock { opaque, .. } => *opaque,
        }
    }
}

/// In the host binary while a surface can be opened opaque; its `protocol`
/// line says `"opaqueSurface":true`.
pub const OPAQUE_SURFACE_MARKER: &str = "MIRIN_METAL_OPAQUE_SURFACE";

/// Parse a surface description; `namespace` defaults to `fallback_namespace`
/// (the window title).
pub fn parse_surface(json: &str, fallback_namespace: &str) -> Result<Surface, String> {
    let spec: SurfaceSpec =
        serde_json::from_str(json).map_err(|error| format!("invalid surface: {error}"))?;
    // One screen by its output name ("eDP-1"); "all" (a surface per screen)
    // is the driver's to do, by opening one host per screen.
    let output = match spec.output.clone() {
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
    match spec.role.as_deref() {
        None | Some("layer") => {}
        Some("lock") => {
            let layered = spec.layer.is_some()
                || !spec.anchor.is_empty()
                || spec.exclusive_zone.is_some()
                || spec.keyboard.is_some()
                || spec.margin.is_some()
                || spec.namespace.is_some();
            if layered {
                return Err("a lock surface takes no other options but opaque and output".into());
            }
            return Ok(Surface::Lock {
                opaque: spec.opaque,
                output,
            });
        }
        Some("popup") => return Err("surface role \"popup\" is not supported yet".into()),
        Some(role) => return Err(format!("unknown surface role \"{role}\"")),
    }
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
    Ok(Surface::Layer(LayerSurface {
        namespace,
        layer,
        anchor,
        exclusive_zone,
        margin,
        keyboard_interactivity,
        output,
        opaque: spec.opaque,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(json: &str, title: &str) -> LayerSurface {
        match parse_surface(json, title).unwrap() {
            Surface::Layer(options) => options,
            Surface::Lock { .. } => panic!("{json} parsed as a lock surface"),
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
            Ok(Surface::Lock { opaque: false, output: None })
        ));
        assert!(parse_surface(r#"{"role":"lock","layer":"overlay"}"#, "x").is_err());
        assert!(parse_surface(r#"{"role":"lock","namespace":"lock"}"#, "x").is_err());
    }

    #[test]
    fn a_lock_surface_names_its_screen() {
        // One host per screen: each covers the screen it names.
        let Ok(Surface::Lock { output, .. }) =
            parse_surface(r#"{"role":"lock","output":"HDMI-A-1"}"#, "x")
        else {
            panic!("not a lock surface");
        };
        assert_eq!(output.as_deref(), Some("HDMI-A-1"));
        assert!(parse_surface(r#"{"role":"lock","output":"all"}"#, "x").is_err());
        assert!(parse_surface(r#"{"role":"lock","output":""}"#, "x").is_err());
    }

    #[test]
    fn a_surface_is_opaque_only_when_it_says_so() {
        // Transparent where its tree is, unless the driver says it paints it whole.
        let bar = r#"{"anchor":["top","left","right"],"exclusiveZone":28}"#;
        assert!(!parse_surface(bar, "x").unwrap().is_opaque());
        assert!(!parse_surface(r#"{"opaque":false}"#, "x")
            .unwrap()
            .is_opaque());
        assert!(parse_surface(r#"{"opaque":true}"#, "x")
            .unwrap()
            .is_opaque());
        assert!(layer(r#"{"layer":"top","opaque":true}"#, "x").opaque);
        // A lock screen too.
        assert!(!parse_surface(r#"{"role":"lock"}"#, "x")
            .unwrap()
            .is_opaque());
        let lock = parse_surface(r#"{"role":"lock","opaque":true}"#, "x").unwrap();
        assert!(matches!(lock, Surface::Lock { opaque: true, .. }));
        assert!(lock.is_opaque());
        assert!(parse_surface(r#"{"opaque":"yes"}"#, "x").is_err());
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
