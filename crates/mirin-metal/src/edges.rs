//! Box edges the flex shorthand does not cover: per-side padding, margins
//! (including `auto`), per-side border widths, and Tailwind shadow presets.

use gpui::{hsla, point, prelude::*, px, AbsoluteLength, BoxShadow, DefiniteLength, Div, Length};

use crate::tree::ViewProps;

/// Per-side padding, margins (including `auto`), and per-side border widths.
pub(crate) fn apply_box_edges(element: &mut Div, props: &ViewProps) {
    let style = element.style();
    let pad = |value: f32| -> DefiniteLength { px(value).into() };
    if let Some(v) = props.padding_top {
        style.padding.top = Some(pad(v));
    }
    if let Some(v) = props.padding_bottom {
        style.padding.bottom = Some(pad(v));
    }
    if let Some(v) = props.padding_left {
        style.padding.left = Some(pad(v));
    }
    if let Some(v) = props.padding_right {
        style.padding.right = Some(pad(v));
    }
    let margin = |value: f32| -> Length { px(value).into() };
    if let Some(v) = props.margin_top {
        style.margin.top = Some(margin(v));
    }
    if let Some(v) = props.margin_bottom {
        style.margin.bottom = Some(margin(v));
    }
    if let Some(v) = props.margin_left {
        style.margin.left = Some(margin(v));
    }
    if let Some(v) = props.margin_right {
        style.margin.right = Some(margin(v));
    }
    if props.margin_left_auto {
        style.margin.left = Some(Length::Auto);
    }
    if props.margin_right_auto {
        style.margin.right = Some(Length::Auto);
    }
    if props.margin_top_auto {
        style.margin.top = Some(Length::Auto);
    }
    let border = |value: f32| -> AbsoluteLength { px(value).into() };
    if let Some(v) = props.border_top {
        style.border_widths.top = Some(border(v));
    }
    if let Some(v) = props.border_bottom {
        style.border_widths.bottom = Some(border(v));
    }
    if let Some(v) = props.border_left {
        style.border_widths.left = Some(border(v));
    }
    if let Some(v) = props.border_right {
        style.border_widths.right = Some(border(v));
    }
}

/// Tailwind's shadow presets as GPUI box shadows.
pub(crate) fn shadow_preset(name: &str) -> Vec<BoxShadow> {
    let shade = |alpha: f32| hsla(0.0, 0.0, 0.0, alpha);
    let layer = |y: f32, blur: f32, spread: f32, alpha: f32| BoxShadow {
        color: shade(alpha),
        offset: point(px(0.0), px(y)),
        blur_radius: px(blur),
        spread_radius: px(spread),
    };
    match name {
        "xs" => vec![layer(1.0, 2.0, 0.0, 0.05)],
        "sm" => vec![layer(1.0, 3.0, 0.0, 0.1), layer(1.0, 2.0, -1.0, 0.1)],
        "md" => vec![layer(4.0, 6.0, -1.0, 0.1), layer(2.0, 4.0, -2.0, 0.1)],
        "lg" => vec![layer(10.0, 15.0, -3.0, 0.1), layer(4.0, 6.0, -4.0, 0.1)],
        "xl" | "2xl" => vec![layer(20.0, 25.0, -5.0, 0.1), layer(8.0, 10.0, -6.0, 0.1)],
        _ => Vec::new(),
    }
}
