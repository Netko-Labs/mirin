//! CSS grid for views: track lists, item placement, and inline-axis
//! alignment, laid out by taffy through mirin's GPUI fork
//! (`forks/gpui/MIRIN.md`).
//!
//! Tracks arrive as JSON: a number is pixels; strings are `"1fr"`, `"25%"`,
//! `"auto"`, `"min-content"`, `"max-content"`; `{"min": …, "max": …}` is
//! `minmax(min, max)`. Anything else is rejected at parse time.

use gpui::{px, Div, GridTrack as Track, Styled, TrackBreadth};
use serde::Deserialize;

use crate::tree::{Align, ViewProps};

/// One validated grid track.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(try_from = "TrackJson")]
pub struct GridTrack(pub(crate) Track);

#[derive(Deserialize)]
#[serde(untagged)]
enum TrackJson {
    Pixels(f32),
    Keyword(String),
    MinMax { min: Breadth, max: Breadth },
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Breadth {
    Pixels(f32),
    Keyword(String),
}

fn breadth(value: Breadth) -> Result<TrackBreadth, String> {
    match value {
        Breadth::Pixels(pixels) if pixels.is_finite() && pixels >= 0.0 => {
            Ok(TrackBreadth::Pixels(pixels))
        }
        Breadth::Pixels(pixels) => Err(format!("invalid track size {pixels}")),
        Breadth::Keyword(keyword) => keyword_breadth(&keyword),
    }
}

fn keyword_breadth(keyword: &str) -> Result<TrackBreadth, String> {
    let number = |text: &str| {
        text.parse::<f32>()
            .ok()
            .filter(|value| value.is_finite() && *value >= 0.0)
    };
    match keyword {
        "auto" => Ok(TrackBreadth::Auto),
        "min-content" => Ok(TrackBreadth::MinContent),
        "max-content" => Ok(TrackBreadth::MaxContent),
        _ => {
            if let Some(value) = keyword.strip_suffix("fr").and_then(number) {
                Ok(TrackBreadth::Fr(value))
            } else if let Some(value) = keyword.strip_suffix('%').and_then(number) {
                Ok(TrackBreadth::Percent(value / 100.0))
            } else if let Some(value) = keyword.strip_suffix("px").and_then(number) {
                Ok(TrackBreadth::Pixels(value))
            } else {
                Err(format!("invalid grid track {keyword:?}"))
            }
        }
    }
}

impl TryFrom<TrackJson> for GridTrack {
    type Error = String;

    fn try_from(value: TrackJson) -> Result<Self, Self::Error> {
        Ok(Self(match value {
            TrackJson::Pixels(pixels) => Track::new(breadth(Breadth::Pixels(pixels))?),
            TrackJson::Keyword(keyword) => Track::new(keyword_breadth(&keyword)?),
            TrackJson::MinMax { min, max } => {
                let min = breadth(min)?;
                if matches!(min, TrackBreadth::Fr(_)) {
                    return Err("minmax() cannot take fr as its minimum".into());
                }
                Track {
                    min,
                    max: breadth(max)?,
                }
            }
        }))
    }
}

fn to_gpui(align: Align) -> gpui::AlignItems {
    match align {
        Align::Start => gpui::AlignItems::Start,
        Align::Center => gpui::AlignItems::Center,
        Align::End => gpui::AlignItems::End,
        Align::Stretch => gpui::AlignItems::Stretch,
    }
}

/// Grid container props, item placement, inline-axis alignment, and per-axis
/// gaps. Runs after the flex styling, so `grid` overrides the display.
pub(crate) fn apply_grid(element: &mut Div, props: &ViewProps) {
    let style = element.style();
    if props.grid {
        style.display = Some(gpui::Display::Grid);
        if let Some(tracks) = &props.grid_columns {
            style.grid_template_columns = Some(tracks.iter().map(|track| track.0).collect());
        }
        if let Some(tracks) = &props.grid_rows {
            style.grid_template_rows = Some(tracks.iter().map(|track| track.0).collect());
        }
    }
    if let Some(align) = props.justify_items {
        style.justify_items = Some(to_gpui(align));
    }
    if let Some(align) = props.justify_self {
        style.justify_self = Some(to_gpui(align));
    }
    if let Some(gap) = props.gap_x {
        style.gap.width = Some(px(gap).into());
    }
    if let Some(gap) = props.gap_y {
        style.gap.height = Some(px(gap).into());
    }
    let placed = [
        props.col_start,
        props.col_end,
        props.row_start,
        props.row_end,
    ]
    .iter()
    .any(Option::is_some)
        || props.col_span.is_some()
        || props.row_span.is_some();
    if !placed {
        return;
    }
    let location = style.grid_location_mut();
    if let Some(start) = props.col_start {
        location.column.start = gpui::GridPlacement::Line(start);
    }
    if let Some(end) = props.col_end {
        location.column.end = gpui::GridPlacement::Line(end);
    }
    if let Some(count) = props.col_span {
        location.column.end = gpui::GridPlacement::Span(count);
    }
    if let Some(start) = props.row_start {
        location.row.start = gpui::GridPlacement::Line(start);
    }
    if let Some(end) = props.row_end {
        location.row.end = gpui::GridPlacement::Line(end);
    }
    if let Some(count) = props.row_span {
        location.row.end = gpui::GridPlacement::Span(count);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(json: &str) -> Result<GridTrack, serde_json::Error> {
        serde_json::from_str(json)
    }

    #[test]
    fn parses_track_forms() {
        assert_eq!(
            track("16").unwrap().0,
            Track::new(TrackBreadth::Pixels(16.0))
        );
        assert_eq!(
            track("\"1fr\"").unwrap().0,
            Track {
                min: TrackBreadth::Auto,
                max: TrackBreadth::Fr(1.0)
            }
        );
        assert_eq!(track("\"auto\"").unwrap().0, Track::new(TrackBreadth::Auto));
        assert_eq!(
            track("\"25%\"").unwrap().0,
            Track::new(TrackBreadth::Percent(0.25))
        );
        assert_eq!(
            track(r#"{"min": 0, "max": "1fr"}"#).unwrap().0,
            Track {
                min: TrackBreadth::Pixels(0.0),
                max: TrackBreadth::Fr(1.0)
            }
        );
    }

    #[test]
    fn rejects_bad_tracks() {
        assert!(track("\"1em\"").is_err());
        assert!(track("-4").is_err());
        assert!(track(r#"{"min": "1fr", "max": "2fr"}"#).is_err());
    }
}
