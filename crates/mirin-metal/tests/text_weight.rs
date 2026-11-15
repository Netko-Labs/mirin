//! A variable font is drawn at the weight the text asks for: as a fallback
//! (how Chinese, Japanese and Korean reach the screen: Noto Sans CJK is one
//! variable face whose default is Thin, and it was drawn Thin) and as a
//! text's own family. Through sumi's real text system on Linux, with the
//! fonts of `tests/fonts`.
#![cfg(target_os = "linux")]

use std::borrow::Cow;

use sumi::{
    font, point, px, Font, FontId, FontRun, FontStyle, FontWeight, GlyphId, PlatformTextSystem,
    RenderGlyphParams,
};
use sumi_wgpu::CosmicTextSystem;

const STATIC: &[u8] = include_bytes!("fonts/MirinTestStatic-Regular.ttf");
const VARIABLE: &[u8] = include_bytes!("fonts/MirinTestVariable.ttf");

/// A text system that knows the two test fonts and no other.
fn text_system() -> CosmicTextSystem {
    let text_system = CosmicTextSystem::new_without_system_fonts("Mirin Test Static");
    text_system
        .add_fonts(vec![Cow::Borrowed(STATIC), Cow::Borrowed(VARIABLE)])
        .expect("the test fonts load");
    text_system
}

fn weighted(family: &'static str, weight: f32) -> Font {
    Font {
        weight: FontWeight(weight),
        ..font(family)
    }
}

/// The glyphs of `text` set in `font_id`: each with the font it came from.
fn glyphs(text_system: &CosmicTextSystem, text: &str, font_id: FontId) -> Vec<(FontId, GlyphId)> {
    let run = FontRun {
        len: text.len(),
        font_id,
    };
    text_system
        .layout_line(text, px(40.0), &[run])
        .runs
        .iter()
        .flat_map(|run| run.glyphs.iter().map(|glyph| (run.font_id, glyph.id)))
        .collect()
}

/// How much ink a glyph has at 40 px: the sum of its coverage.
fn ink(text_system: &CosmicTextSystem, font_id: FontId, glyph_id: GlyphId) -> u64 {
    let params = RenderGlyphParams {
        font_id,
        glyph_id,
        font_size: px(40.0),
        subpixel_variant: point(0, 0),
        scale_factor: 1.0,
        is_emoji: false,
        subpixel_rendering: false,
        dilation: 0,
    };
    let bounds = text_system
        .glyph_raster_bounds(&params)
        .expect("the glyph has bounds");
    let (_, bytes) = text_system
        .rasterize_glyph(&params, bounds)
        .expect("the glyph is drawn");
    bytes.iter().map(|&coverage| u64::from(coverage)).sum()
}

#[test]
fn a_variable_family_has_a_font_for_each_weight_asked() {
    let text_system = text_system();
    let id = |weight| {
        text_system
            .font_id(&weighted("Mirin Test Variable", weight))
            .expect("the family resolves")
    };
    let (regular, medium, bold) = (id(400.0), id(500.0), id(700.0));
    assert_ne!(regular, medium);
    assert_ne!(medium, bold);
    assert_ne!(regular, bold);
    assert_eq!(id(400.0), regular, "a weight asked twice is one font");
    // Past the axis, the nearest weight it has.
    assert_eq!(id(900.0), bold);
    assert_eq!(id(100.0), regular);
    for (font_id, weight) in [(regular, 400.0), (medium, 500.0), (bold, 700.0)] {
        assert_eq!(
            text_system.font_weight_and_style(font_id).unwrap(),
            (FontWeight(weight), FontStyle::Normal)
        );
    }

    // Heavier is more ink and a wider letter.
    let inks: Vec<u64> = [regular, medium, bold]
        .into_iter()
        .map(|font_id| {
            let glyphs = glyphs(&text_system, "w", font_id);
            assert_eq!(glyphs.len(), 1);
            assert_eq!(glyphs[0].0, font_id, "the glyph is this weight's");
            ink(&text_system, font_id, glyphs[0].1)
        })
        .collect();
    assert!(
        inks[0] < inks[1] && inks[1] < inks[2],
        "ink at 400, 500, 700: {inks:?}"
    );
    let width = |font_id| text_system.layout_line("w", px(40.0), &[FontRun { len: 1, font_id }]);
    assert!(width(regular).width < width(bold).width);
    let advance = |font_id| {
        let glyph = glyphs(&text_system, "w", font_id)[0].1;
        text_system.advance(font_id, glyph).unwrap().width
    };
    assert!(advance(regular) < advance(bold));
}

#[test]
fn a_family_without_a_weight_axis_keeps_its_one_face() {
    let text_system = text_system();
    let regular = text_system.font_id(&font("Mirin Test Static")).unwrap();
    let bold = text_system
        .font_id(&weighted("Mirin Test Static", 700.0))
        .unwrap();
    assert_eq!(regular, bold);
    assert_eq!(
        text_system.font_weight_and_style(bold).unwrap(),
        (FontWeight(400.0), FontStyle::Normal)
    );
}

#[test]
fn a_variable_fallback_is_drawn_at_the_weight_of_the_text() {
    let text_system = text_system();
    // "Mirin Test Static" has "m" and no "w": the "w" falls back to the
    // variable font, whose default weight is 700.
    let primary = text_system.font_id(&font("Mirin Test Static")).unwrap();
    let glyphs = glyphs(&text_system, "mw", primary);
    assert_eq!(glyphs.len(), 2, "{glyphs:?}");
    let (m_font, _) = glyphs[0];
    let (fallback, w) = glyphs[1];
    assert_eq!(m_font, primary);
    assert_ne!(fallback, primary);
    assert_eq!(
        text_system.font_weight_and_style(fallback).unwrap(),
        (FontWeight(400.0), FontStyle::Normal),
        "the fallback is the text's weight, not the face's default"
    );

    // The same ink as the variable family asked for by name at 400, and
    // less than at its default.
    let by_name = |weight| {
        let font_id = text_system
            .font_id(&weighted("Mirin Test Variable", weight))
            .unwrap();
        ink(&text_system, font_id, w)
    };
    let drawn = ink(&text_system, fallback, w);
    assert_eq!(drawn, by_name(400.0));
    assert!(drawn < by_name(700.0), "{drawn} at 400 against the default");
}
