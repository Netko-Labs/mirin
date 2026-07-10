/// One `-webkit-app-region` rectangle in web coordinates (top-left origin).
#[derive(Clone, Copy)]
pub struct DragRegion {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub draggable: bool,
}

/// How the window's title bar is presented.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitleBarStyle {
    /// Standard titled window.
    Default,
    /// Title bar hidden, content fills; traffic-light buttons remain.
    Hidden,
    /// Title bar transparent and content extends under it; inset traffic lights.
    HiddenInset,
}

/// Window creation parameters resolved by the engine.
pub struct WindowParams<'a> {
    pub id: u32,
    pub title: &'a str,
    pub width: f64,
    pub height: f64,
    /// Screen position (bottom-left origin, points). Centered when absent.
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub title_bar_style: TitleBarStyle,
    pub transparent: bool,
    pub always_on_top: bool,
    pub movable_by_background: bool,
    pub show: bool,
}
