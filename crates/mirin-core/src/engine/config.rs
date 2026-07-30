use serde::Deserialize;

/// Startup options passed to `run_core` (parsed from the FFI `mirin_run` JSON,
/// or built directly by the m1-smoke test binary).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct CoreConfig {
    /// Writable CEF cache dir (required on recent macOS; cef-rs #287).
    pub cache_path: String,
    /// CEF subprocess executable. Derived from the bundle if empty.
    pub subprocess_path: String,
    /// If set, serve `app://` from this dir (production builds; empty in dev).
    pub resources_path: String,
    /// If set, a concrete square PNG used as the app icon. On Linux it becomes the
    /// window's `_NET_WM_ICON` (taskbar/dock); macOS/Windows take the icon from the
    /// bundle, so it's ignored there.
    #[serde(default)]
    pub icon_path: String,
    /// If set, open a window with this URL at startup (Bun-less m1-smoke test).
    pub startup_url: Option<String>,
    /// Development run (`mirin dev`): enables web-inspector context-menu items.
    #[serde(default)]
    pub dev: bool,
    /// App bundle identifier (e.g. "dev.netko.anko").
    #[serde(default)]
    pub identifier: String,
    /// Single-instance app. Default true; set false to allow multiple instances.
    #[serde(default = "default_true")]
    pub single_instance: bool,
    /// CEF remote-debugging (DevTools protocol) port, or 0 for disabled.
    ///
    /// Chromium binds this on loopback only. mirin's devtools use it for
    /// screenshots, accessibility snapshots, page evaluation, and synthetic input
    /// (docs/agent-devtools.md), which is why it is off unless a port is supplied:
    /// anything that can reach the port can run code in the app's pages.
    #[serde(default)]
    pub remote_debugging_port: u16,
}

/// Ports CEF accepts for remote debugging. 0 disables it; below 1024 is
/// privileged and rejected by Chromium.
const MIN_DEBUG_PORT: u16 = 1024;

impl CoreConfig {
    /// The remote-debugging port to hand CEF, or 0 when disabled/out of range.
    pub(crate) fn debug_port(&self) -> i32 {
        if self.remote_debugging_port >= MIN_DEBUG_PORT {
            i32::from(self.remote_debugging_port)
        } else {
            0
        }
    }
}

/// Per-window creation options (from the Bun Worker via `mirin_window_create`).
/// Unknown fields (e.g. the manifest's `show` paint hint) are ignored by serde.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowOpts {
    #[serde(default = "default_title")]
    pub title: String,
    #[serde(default = "default_width")]
    pub width: f64,
    #[serde(default = "default_height")]
    pub height: f64,
    /// Minimum window size; the OS won't resize below it (0 = no minimum).
    #[serde(default)]
    pub min_width: f64,
    #[serde(default)]
    pub min_height: f64,
    /// Screen position (bottom-left origin, points). Centered when absent.
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    pub url: String,
    /// "hidden" | "hiddenInset" | absent (standard title bar).
    #[serde(default)]
    pub title_bar_style: Option<String>,
    #[serde(default)]
    pub transparent: bool,
    /// Native background material behind the web UI (implies transparent/OSR).
    #[serde(default)]
    pub material: Option<WindowMaterial>,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default)]
    pub movable_by_background: bool,
    /// Custom traffic-light inset for a custom title bar (macOS).
    #[serde(default)]
    pub traffic_light_position: Option<TrafficLightPos>,
    /// Show the window at creation (false creates it hidden, e.g. a Spotlight panel).
    #[serde(default = "default_true")]
    pub visible: bool,
}

/// Custom traffic-light inset (the `trafficLightPosition` config option).
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct TrafficLightPos {
    pub x: f64,
    pub y: f64,
}

/// A window's native background material (the `material` config option,
/// normalized to object form by the TS runtime).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowMaterial {
    /// "liquidGlass" | a vibrancy name (sidebar/menu/popover/hud/...).
    #[serde(rename = "type", default)]
    pub kind: String,
    /// Optional Liquid Glass tint as a CSS hex color (#RGB/#RRGGBB/#RRGGBBAA).
    #[serde(default)]
    pub tint: Option<String>,
    /// Optional corner radius in points.
    #[serde(default)]
    pub corner_radius: Option<f64>,
}

impl WindowOpts {
    pub(crate) fn startup(url: String) -> Self {
        Self {
            title: default_title(),
            width: default_width(),
            height: default_height(),
            min_width: 0.0,
            min_height: 0.0,
            x: None,
            y: None,
            url,
            title_bar_style: None,
            transparent: false,
            material: None,
            always_on_top: false,
            movable_by_background: false,
            traffic_light_position: None,
            visible: true,
        }
    }
}

fn default_title() -> String {
    "mirin".into()
}

fn default_width() -> f64 {
    1024.0
}

fn default_height() -> f64 {
    768.0
}

fn default_true() -> bool {
    true
}
