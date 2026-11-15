//! How text is antialiased: in grays, or by the panel's subpixels.
//!
//! sumi asks for subpixel antialiasing on Linux (colour at a glyph's edges,
//! sharper on a panel whose subpixels are the red, green, blue stripes it
//! assumes). The host draws grayscale there instead: it is what Metal drew
//! before sumi and what Dashi's look was designed on, it is right on any
//! panel, rotated or not, and a screenshot or a recording of it carries no
//! fringes to another screen. `MIRIN_METAL_TEXT=subpixel` asks for
//! subpixel; `MIRIN_METAL_TEXT=grayscale` asks for grays on a platform
//! whose default is not (docs/metal.md, section 4).
//!
//! That is the host's default. A driver changes it while the host runs
//! with a `{"textAntialiasing": …}` line (`Antialiasing`): the engine
//! decides each glyph's antialiasing as it paints it and keeps the two
//! kinds apart in its atlas, so the change is one whole redraw of the
//! window (`RootView::text_changed`), and a line sent before a deferred
//! host's `open` is how its window opens. The engine keeps one mode for the
//! process, which is one window at a time for a host.

use sumi::{App, TextRenderingMode};

/// In the host binary while it takes a `textAntialiasing` line; its
/// `protocol` line says `"textAntialiasing":true`.
pub const TEXT_ANTIALIASING_MARKER: &str = "MIRIN_METAL_TEXT_ANTIALIASING";

/// What a driver asks text to be antialiased by (`{"textAntialiasing": …}`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Antialiasing {
    /// What the host started with: `MIRIN_METAL_TEXT`, else its default.
    Default,
    Grayscale,
    Subpixel,
}

impl Antialiasing {
    /// The line's value: `"default"`, `"grayscale"` or `"subpixel"`.
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "default" => Some(Self::Default),
            "grayscale" => Some(Self::Grayscale),
            "subpixel" => Some(Self::Subpixel),
            _ => None,
        }
    }

    fn mode(self) -> TextRenderingMode {
        match self {
            Self::Default => mode(std::env::var("MIRIN_METAL_TEXT").ok().as_deref()),
            Self::Grayscale => TextRenderingMode::Grayscale,
            Self::Subpixel => TextRenderingMode::Subpixel,
        }
    }

    /// Make it the app's; whether that is a change (what is drawn is then
    /// drawn in the other).
    pub(crate) fn apply(self, cx: &mut App) -> bool {
        let mode = self.mode();
        let changed = cx.text_rendering_mode() != mode;
        cx.set_text_rendering_mode(mode);
        changed
    }
}

/// Set the app's text antialiasing from `MIRIN_METAL_TEXT`. Call before the
/// first window draws.
pub(crate) fn apply(cx: &mut App) {
    Antialiasing::Default.apply(cx);
}

/// The mode for what `MIRIN_METAL_TEXT` holds: `subpixel` or `grayscale`,
/// else the host's default (anything else is not a reason to fail a start).
fn mode(asked: Option<&str>) -> TextRenderingMode {
    match asked.map(str::trim) {
        Some("subpixel") => TextRenderingMode::Subpixel,
        Some("grayscale") => TextRenderingMode::Grayscale,
        _ => default_mode(),
    }
}

/// Grayscale on Linux; elsewhere what the platform does (macOS smooths in
/// grays itself, Windows follows the system's ClearType setting).
fn default_mode() -> TextRenderingMode {
    if cfg!(target_os = "linux") {
        TextRenderingMode::Grayscale
    } else {
        TextRenderingMode::PlatformDefault
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_grayscale_on_linux_unless_subpixel_is_asked_for() {
        assert_eq!(mode(Some("subpixel")), TextRenderingMode::Subpixel);
        assert_eq!(mode(Some(" subpixel\n")), TextRenderingMode::Subpixel);
        assert_eq!(mode(Some("grayscale")), TextRenderingMode::Grayscale);
        for unset in [None, Some(""), Some("lcd")] {
            assert_eq!(mode(unset), default_mode());
        }
        #[cfg(target_os = "linux")]
        assert_eq!(default_mode(), TextRenderingMode::Grayscale);
    }

    #[test]
    fn a_driver_names_one_of_three() {
        assert_eq!(
            Antialiasing::parse("subpixel"),
            Some(Antialiasing::Subpixel)
        );
        assert_eq!(
            Antialiasing::parse("grayscale"),
            Some(Antialiasing::Grayscale)
        );
        assert_eq!(Antialiasing::parse("default"), Some(Antialiasing::Default));
        assert_eq!(Antialiasing::parse("lcd"), None);
        assert_eq!(Antialiasing::Subpixel.mode(), TextRenderingMode::Subpixel);
        assert_eq!(Antialiasing::Grayscale.mode(), TextRenderingMode::Grayscale);
    }

    #[sumi::test]
    fn a_change_is_told_and_the_same_again_is_not(cx: &mut sumi::TestAppContext) {
        cx.update(|cx| {
            Antialiasing::Grayscale.apply(cx);
            assert!(Antialiasing::Subpixel.apply(cx));
            assert_eq!(cx.text_rendering_mode(), TextRenderingMode::Subpixel);
            assert!(!Antialiasing::Subpixel.apply(cx));
            assert!(Antialiasing::Grayscale.apply(cx));
        });
    }
}
