//! A row or field of dots (`dots`): progress, a history, a picture in dots,
//! drawn in one paint with no element per dot.
//!
//! A row of 60 dots made of views was 60 elements to build, lay out and
//! paint each frame, and as an SVG mask it was parsed and rasterised again
//! whenever the lit count changed. Here the node is one box of a size known
//! from its props, and a canvas paints a quad per dot into it: a lit count
//! that changes is a new prop and a new paint, nothing more.
//!
//! The dots are `count` across and `rows` down (1 unless given), centres
//! `pitch` apart, each `radius` round. The first `lit` (row by row) are in
//! `color`, the rest in `unlitColor`; `head` is one dot drawn otherwise (in
//! `headColor`, and as a ring with `headRing`): a playhead, a limit. `cells`
//! says each dot instead, one character a dot: `0` unlit, `1` lit, `2` a
//! ring in `color`. A host that takes `dots` says `"dots":true` in its
//! `protocol` line; one from before refuses a tree with it.

use serde::Deserialize;
use sumi::{
    div, point, prelude::*, px, quad, rgba, size, AnyElement, BorderStyle, Bounds, Hsla, Pixels,
    Window,
};

use crate::tree::parse_color;

/// In the host binary while it draws `dots` nodes.
pub const DOTS_MARKER: &str = "MIRIN_METAL_DOTS";

/// The most dots one node draws: a 64 × 64 field. More are not drawn.
const MAX_DOTS: usize = 4096;

/// Props for a `dots` node.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DotsProps {
    /// Stable identity, only to address the node in a patch (`patch/`).
    pub id: Option<String>,
    /// Dots across.
    pub count: u32,
    /// Dots down; one row without it.
    pub rows: Option<u32>,
    /// From one dot's centre to the next, in px.
    pub pitch: f32,
    pub radius: f32,
    /// How many are lit, from the first, row by row.
    pub lit: u32,
    /// The lit dots' colour (white without it).
    pub color: Option<String>,
    /// The unlit dots' colour; not drawn without it.
    pub unlit_color: Option<String>,
    /// One dot drawn in `headColor` (`color` without it).
    pub head: Option<u32>,
    pub head_color: Option<String>,
    /// The head as a ring, not a filled dot.
    pub head_ring: bool,
    /// Each dot's look, row by row: `0` unlit, `1` lit, `2` a ring. Wins over `lit`.
    pub cells: Option<String>,
    pub opacity: Option<f32>,
}

/// How one dot is drawn.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Look {
    Unlit,
    Lit,
    Head,
    Ring,
}

/// Each dot's column, row and look, row by row, at most `MAX_DOTS`.
pub(crate) fn looks(props: &DotsProps) -> Vec<(u32, u32, Look)> {
    let columns = props.count;
    let rows = props.rows.unwrap_or(1);
    let total = (columns as usize)
        .saturating_mul(rows as usize)
        .min(MAX_DOTS);
    let cells = props.cells.as_deref().map(str::as_bytes);
    (0..total)
        .map(|index| {
            let look = match cells {
                Some(cells) => match cells.get(index) {
                    Some(b'1') => Look::Lit,
                    Some(b'2') => Look::Ring,
                    _ => Look::Unlit,
                },
                None if props.head == Some(index as u32) => Look::Head,
                None if (index as u32) < props.lit => Look::Lit,
                None => Look::Unlit,
            };
            let column = (index % columns.max(1) as usize) as u32;
            (column, (index / columns.max(1) as usize) as u32, look)
        })
        .collect()
}

/// The node's box: from the first dot's left edge to the last's right.
pub(crate) fn extent(props: &DotsProps) -> (f32, f32) {
    let (pitch, diameter) = (props.pitch.max(0.0), props.radius.max(0.0) * 2.0);
    let across = |n: u32| {
        if n == 0 {
            0.0
        } else {
            (n - 1) as f32 * pitch + diameter
        }
    };
    let rows = props.rows.unwrap_or(1);
    let shown = looks(props).len() as u32;
    let rows = rows.min(shown.div_ceil(props.count.max(1)));
    (across(props.count.min(shown)), across(rows))
}

pub(crate) fn render_dots(props: &DotsProps) -> AnyElement {
    thread_local!(static TRACED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
    if !TRACED.with(|traced| traced.replace(true)) {
        crate::trace::log(format_args!("{DOTS_MARKER}: a dots node was drawn"));
    }
    let (width, height) = extent(props);
    let colour = |value: &Option<String>| value.as_deref().and_then(parse_color);
    let lit = colour(&props.color).unwrap_or(0xffffffff);
    let unlit = colour(&props.unlit_color);
    let head = colour(&props.head_color).unwrap_or(lit);
    let (pitch, radius, ring) = (props.pitch.max(0.0), props.radius.max(0.0), props.head_ring);
    let dots = looks(props);
    let canvas = sumi::canvas(
        |_, _, _| {},
        move |bounds, (), window, _| {
            for &(column, row, look) in &dots {
                let fill = match look {
                    Look::Unlit => unlit.map(|unlit| (unlit, false)),
                    Look::Lit => Some((lit, false)),
                    Look::Ring => Some((lit, true)),
                    Look::Head => Some((head, ring)),
                };
                if let Some((color, hollow)) = fill {
                    let at = point(px(column as f32 * pitch), px(row as f32 * pitch));
                    paint_dot(bounds.origin + at, radius, color, hollow, window);
                }
            }
        },
    )
    .size_full();
    let mut element = div()
        .w(px(width))
        .h(px(height))
        .flex_shrink_0()
        .child(canvas);
    if let Some(opacity) = props.opacity {
        element = element.opacity(opacity);
    }
    element.into_any_element()
}

/// One dot whose box starts at `origin`: filled, or a ring a third of its radius wide (1–2 px).
fn paint_dot(
    origin: sumi::Point<Pixels>,
    radius: f32,
    color: u32,
    hollow: bool,
    window: &mut Window,
) {
    let bounds = Bounds::new(origin, size(px(radius * 2.0), px(radius * 2.0)));
    let color: Hsla = rgba(color).into();
    let (background, border, width) = if hollow {
        let width = (radius / 3.0).clamp(1.0, 2.0);
        (sumi::transparent_black(), color, width)
    } else {
        (color, sumi::transparent_black(), 0.0)
    };
    window.paint_quad(quad(
        bounds,
        px(radius),
        background,
        px(width),
        border,
        BorderStyle::Solid,
    ));
}

#[cfg(test)]
mod tests {
    use super::{extent, looks, DotsProps, Look, MAX_DOTS};
    use crate::tree::{parse_tree, NodeSpec};

    fn dots(json: &str) -> DotsProps {
        match parse_tree(&format!(r#"{{"type":"dots","props":{json}}}"#)).expect("dots parse") {
            NodeSpec::Dots { props } => props,
            other => panic!("not dots: {other:?}"),
        }
    }

    #[test]
    fn a_row_lights_from_the_start_and_draws_its_head() {
        let row = dots(
            r##"{"id":"7","count":6,"pitch":8,"radius":2,"lit":3,"head":4,"color":"#fff","unlitColor":"#444"}"##,
        );
        let drawn: Vec<Look> = looks(&row).into_iter().map(|(_, _, look)| look).collect();
        use Look::*;
        assert_eq!(drawn, [Lit, Lit, Lit, Unlit, Head, Unlit]);
        // Five gaps of 8 and one dot's width.
        assert_eq!(extent(&row), (44.0, 4.0));
    }

    #[test]
    fn a_field_goes_row_by_row_and_cells_win_over_lit() {
        let field = dots(r#"{"count":3,"rows":2,"pitch":10,"radius":3,"lit":6,"cells":"102x1"}"#);
        let drawn = looks(&field);
        use Look::*;
        assert_eq!(
            drawn,
            [
                (0, 0, Lit),
                (1, 0, Unlit),
                (2, 0, Ring),
                (0, 1, Unlit),
                (1, 1, Lit),
                // Past the end of `cells`: unlit.
                (2, 1, Unlit),
            ]
        );
        assert_eq!(extent(&field), (26.0, 16.0));
    }

    #[test]
    fn a_huge_field_is_cut_to_the_most_one_node_draws() {
        let field = dots(r#"{"count":1000,"rows":1000,"pitch":1,"radius":0.5}"#);
        assert_eq!(looks(&field).len(), MAX_DOTS);
        // Its box is what it draws: four rows of a thousand and 96 of a fifth.
        assert_eq!(extent(&field), (1000.0, 5.0));
        assert_eq!(
            extent(&dots(r#"{"count":0,"pitch":4,"radius":1}"#)),
            (0.0, 0.0)
        );
    }

    #[test]
    fn an_unknown_prop_is_refused() {
        assert!(parse_tree(r#"{"type":"dots","props":{"count":3,"value":0.5}}"#).is_err());
    }
}

// Dots drawn by GPUI on its test platform, through the host's `RootView`.
#[cfg(test)]
mod drawn_tests;
