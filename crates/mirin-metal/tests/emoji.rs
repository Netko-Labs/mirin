//! An emoji is drawn. Noto Color Emoji as Fedora ships it holds COLRv1
//! glyphs (paint graphs with gradients), which swash, sumi's rasteriser,
//! does not read: every emoji was shaped and then drawn as nothing. Through
//! sumi's real text system on Linux, with the fonts of `tests/fonts`.
#![cfg(target_os = "linux")]

use std::borrow::Cow;

use sumi::{font, point, px, FontRun, PlatformTextSystem, RenderGlyphParams};
use sumi_wgpu::CosmicTextSystem;

const STATIC: &[u8] = include_bytes!("fonts/MirinTestStatic-Regular.ttf");
const EMOJI: &[u8] = include_bytes!("fonts/MirinTestEmoji.ttf");

#[test]
fn an_emoji_falls_back_to_the_colour_font_and_is_drawn_in_colour() {
    let text_system = CosmicTextSystem::new_without_system_fonts("Mirin Test Static");
    text_system
        .add_fonts(vec![Cow::Borrowed(STATIC), Cow::Borrowed(EMOJI)])
        .expect("the test fonts load");
    let primary = text_system.font_id(&font("Mirin Test Static")).unwrap();

    // "m" is the text's font; the face has no glyph there and falls back.
    let text = "m\u{1F600}";
    let run = FontRun {
        len: text.len(),
        font_id: primary,
    };
    let layout = text_system.layout_line(text, px(32.0), &[run]);
    let glyphs: Vec<_> = layout
        .runs
        .iter()
        .flat_map(|run| run.glyphs.iter().map(|glyph| (run.font_id, glyph)))
        .collect();
    assert_eq!(glyphs.len(), 2);
    let (emoji_font, emoji) = glyphs[1];
    assert_ne!(emoji_font, primary);
    assert!(emoji.is_emoji, "the glyph is known for an emoji");
    assert!(!glyphs[0].1.is_emoji);

    let params = RenderGlyphParams {
        font_id: emoji_font,
        glyph_id: emoji.id,
        font_size: px(32.0),
        subpixel_variant: point(0, 0),
        scale_factor: 2.0,
        is_emoji: true,
        subpixel_rendering: false,
        dilation: 0,
    };
    let bounds = text_system.glyph_raster_bounds(&params).unwrap();
    // 32 px at a scale of 2: a face about 64 device pixels across.
    let (width, height) = (bounds.size.width.0, bounds.size.height.0);
    assert!((48..=96).contains(&width), "{width} wide");
    assert!((48..=96).contains(&height), "{height} tall");
    // It sits on the line: its top above the baseline, its bottom near it.
    assert!(bounds.origin.y.0 < -40, "top at {}", bounds.origin.y.0);

    let (size, bytes) = text_system.rasterize_glyph(&params, bounds).unwrap();
    assert_eq!(size, bounds.size);
    assert_eq!(bytes.len(), (width * height * 4) as usize, "four channels");

    // BGRA, not premultiplied. The middle of the face is opaque and yellow
    // (red and green high, blue low); a corner of the box is empty.
    let pixel = |x: i32, y: i32| {
        let at = ((y * width + x) * 4) as usize;
        (bytes[at + 2], bytes[at + 1], bytes[at], bytes[at + 3])
    };
    let (red, green, blue, alpha) = pixel(width / 2, height / 3);
    assert_eq!(alpha, 255, "the face is opaque");
    assert!(
        red > 200 && green > 150 && blue < 120,
        "yellow, got {red} {green} {blue}"
    );
    assert_eq!(pixel(0, 0).3, 0, "nothing in the corner");
    // Gradients, not one flat colour: the face is lighter at the top than
    // at the bottom.
    let (_, top_green, _, _) = pixel(width / 2, height / 5);
    let (_, low_green, _, low_alpha) = pixel(width / 2, height * 9 / 10 - 2);
    assert_eq!(low_alpha, 255);
    assert_ne!(top_green, low_green, "the face is shaded");
}
