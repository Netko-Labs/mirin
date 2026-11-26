//! Box edges the flex shorthand does not cover: per-side padding, margins
//! (including `auto`), per-side border widths, Tailwind shadow presets, and
//! one shadow spelled out (`"0 0 30 3 #rrggbbaa"`: a glow in a colour).

use sumi::{
    hsla, point, prelude::*, px, rgba, AbsoluteLength, BoxShadow, DefiniteLength, Div, Length,
};

use crate::tree::{parse_color, ViewProps};

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

/// One shadow spelled out as CSS's `box-shadow` is, without units: `x y blur spread #colour`
/// (`"0 0 30 3 #00737e99"`, a glow of an ink). Anything else is not one.
fn spelled_shadow(value: &str) -> Option<BoxShadow> {
    let parts: Vec<&str> = value.split_whitespace().collect();
    let [x, y, blur, spread, colour] = parts.as_slice() else {
        return None;
    };
    let number = |text: &str| text.parse::<f32>().ok().filter(|n| n.is_finite());
    let blur = number(blur)?;
    if blur < 0.0 {
        return None;
    }
    Some(BoxShadow {
        color: rgba(parse_color(colour)?).into(),
        offset: point(px(number(x)?), px(number(y)?)),
        blur_radius: px(blur),
        spread_radius: px(number(spread)?),
        inset: false,
    })
}

/// Tailwind's shadow presets as GPUI box shadows, or one shadow spelled out (`spelled_shadow`).
pub(crate) fn shadow_preset(name: &str) -> Vec<BoxShadow> {
    if let Some(shadow) = spelled_shadow(name) {
        return vec![shadow];
    }
    let shade = |alpha: f32| hsla(0.0, 0.0, 0.0, alpha);
    let layer = |y: f32, blur: f32, spread: f32, alpha: f32| BoxShadow {
        color: shade(alpha),
        offset: point(px(0.0), px(y)),
        blur_radius: px(blur),
        spread_radius: px(spread),
        inset: false,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shadow_spelled_out_is_one_glow_in_its_colour() {
        let shadows = shadow_preset("0 0 30 3 #00737e99");
        assert_eq!(shadows.len(), 1);
        let glow = &shadows[0];
        assert_eq!(glow.blur_radius, px(30.0));
        assert_eq!(glow.spread_radius, px(3.0));
        assert_eq!(glow.offset, point(px(0.0), px(0.0)));
        let colour: sumi::Rgba = glow.color.into();
        assert!((colour.a - 0x99 as f32 / 255.0).abs() < 0.01);
        assert!((colour.g - 0x73 as f32 / 255.0).abs() < 0.01);
    }

    #[test]
    fn a_shadow_badly_spelled_draws_nothing() {
        for bad in [
            "0 0 30 #00737e",
            "0 0 -4 3 #00737e",
            "0 0 30 3 teal",
            "a 0 30 3 #00737e",
            "0 0 30 3 #00737e extra",
        ] {
            assert!(shadow_preset(bad).is_empty(), "{bad}");
        }
        assert_eq!(shadow_preset("xl").len(), 2);
    }
}
