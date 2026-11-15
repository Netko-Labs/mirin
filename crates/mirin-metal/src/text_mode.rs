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
//! It is chosen when the host starts and holds for its life: the variable
//! is read once, before any window, and nothing changes the mode after. A
//! host kept warm (`MIRIN_METAL_DEFERRED`) opens every window in it. The
//! engine reads the same variable as it prepares its GPU context
//! (`sumi-wgpu`'s `wgpu_prepare.rs`), so only a host that asked for
//! subpixel has those shaders parsed ahead.

use sumi::{App, TextRenderingMode};

/// Set the app's text antialiasing from `MIRIN_METAL_TEXT`. Call before the
/// first window draws.
pub(crate) fn apply(cx: &mut App) {
    cx.set_text_rendering_mode(mode(std::env::var("MIRIN_METAL_TEXT").ok().as_deref()));
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
}
