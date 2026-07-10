/// "hidden" | "hiddenInset" | standard, mirroring `mac::TitleBarStyle`. Both custom
/// variants render frameless on Windows (content to the edges).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitleBarStyle {
    Default,
    HiddenInset,
    Hidden,
}

impl TitleBarStyle {
    pub(super) fn is_custom(self) -> bool {
        !matches!(self, TitleBarStyle::Default)
    }
}

/// Per-window creation options (the Windows analogue of `mac::WindowParams`).
pub struct WindowParams {
    pub id: u32,
    pub title: String,
    pub width: f64,
    pub height: f64,
    /// Minimum window size enforced via WM_GETMINMAXINFO (0 = no minimum).
    pub min_width: f64,
    pub min_height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub title_bar_style: TitleBarStyle,
    pub always_on_top: bool,
    /// Windowless (OSR) layered window — CEF paints a per-pixel-alpha frame we
    /// composite, so the window is see-through. Implies borderless.
    pub transparent: bool,
    pub show: bool,
}

/// One `-webkit-app-region` rectangle in web (DIP, top-left) coordinates.
#[derive(Clone, Copy)]
pub struct DragRegion {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub draggable: bool,
}
