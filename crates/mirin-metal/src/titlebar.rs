//! The window's title bar style (`NativeHostOptions.titleBar`,
//! `MIRIN_METAL_TITLEBAR`). `unified` asks a compositor that supports it
//! (Dashi's `dashi-chrome-v1`) to drop its title bar and draw only the window
//! controls over the app's own toolbar; the compositor then reports the area
//! the controls cover. Any other compositor keeps the standard title bar and
//! reports no area.

/// The title bar style an app asks for, or the one a window effectively has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TitleBar {
    /// The compositor's own title bar above the app's content.
    #[default]
    Standard,
    /// The app's content runs to the top edge; the compositor's window
    /// controls are drawn over it.
    Unified,
}

impl TitleBar {
    /// Wire name, as in `NativeHostOptions.titleBar` and the `chrome` event.
    pub fn name(self) -> &'static str {
        match self {
            TitleBar::Standard => "standard",
            TitleBar::Unified => "unified",
        }
    }

    /// Parse a `MIRIN_METAL_TITLEBAR` value: exactly `standard` or `unified`.
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "standard" => Ok(TitleBar::Standard),
            "unified" => Ok(TitleBar::Unified),
            other => Err(format!(
                "unknown title bar {other:?}; use \"standard\" or \"unified\""
            )),
        }
    }
}

/// The area the compositor's window controls cover, in window pixels: the
/// app keeps it empty.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Controls {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// What a window reports about its chrome: the style it effectively has
/// (`unified` only where the compositor honored it) and the controls' area.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Chrome {
    pub title_bar: TitleBar,
    pub controls: Option<Controls>,
}

impl Chrome {
    /// The chrome for a window that asked for `requested`, given the area the
    /// compositor reported (none without the protocol or when it declined).
    pub fn effective(requested: TitleBar, controls: Option<Controls>) -> Self {
        match (requested, controls) {
            (TitleBar::Unified, Some(controls)) => Chrome {
                title_bar: TitleBar::Unified,
                controls: Some(controls),
            },
            _ => Chrome {
                title_bar: TitleBar::Standard,
                controls: None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_the_two_styles() {
        assert_eq!(TitleBar::parse("standard"), Ok(TitleBar::Standard));
        assert_eq!(TitleBar::parse("unified"), Ok(TitleBar::Unified));
        for bad in ["", "Unified", " unified", "unified ", "none", "hidden"] {
            assert!(TitleBar::parse(bad).is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn names_round_trip() {
        for style in [TitleBar::Standard, TitleBar::Unified] {
            assert_eq!(TitleBar::parse(style.name()), Ok(style));
        }
    }

    #[test]
    fn unified_needs_the_compositor_to_report_controls() {
        let controls = Controls {
            x: 0.0,
            y: 0.0,
            width: 80.0,
            height: 28.0,
        };
        assert_eq!(
            Chrome::effective(TitleBar::Unified, Some(controls)),
            Chrome {
                title_bar: TitleBar::Unified,
                controls: Some(controls)
            }
        );
        // No Dashi protocol (or not honored): the standard title bar.
        let fallback = Chrome {
            title_bar: TitleBar::Standard,
            controls: None,
        };
        assert_eq!(Chrome::effective(TitleBar::Unified, None), fallback);
        // Controls the app never asked for are not reported.
        assert_eq!(
            Chrome::effective(TitleBar::Standard, Some(controls)),
            fallback
        );
    }
}
