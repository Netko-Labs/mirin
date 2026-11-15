//! mirin: COLRv1 colour glyphs, drawn.
//!
//! swash draws colour glyphs of two kinds: bitmaps (CBDT, sbix) and COLRv0
//! layers of flat colour. Noto Color Emoji as Fedora ships it
//! (`Noto-COLRv1.ttf`) is neither: its glyphs are COLRv1 paint graphs
//! (gradients, transforms, clips, composited layers), which swash does not
//! read, so every emoji was shaped and then drawn as nothing. Here skrifa
//! walks the paint graph and tiny-skia draws what it says, into the image
//! the text system hands on as it does swash's.
//!
//! Not drawn as the font says: a sweep gradient is one flat colour, the mean
//! of its stops (tiny-skia 0.11 has none), and a radial gradient whose inner
//! circle is neither a point nor concentric with the outer starts at a
//! point. Noto's emoji use no sweep gradient: none of the 4,012 colour glyphs
//! of Fedora's `Noto-COLRv1.ttf` (google-noto-color-emoji-fonts 20260921)
//! reaches a `PaintSweepGradient` or its variable form, so every one of them
//! is drawn as the font says; the flat colour is for another font's.

use skrifa::{
    FontRef, GlyphId, MetadataProvider,
    color::{Brush, ColorGlyphFormat, ColorPainter, ColorStop, CompositeMode, Extend, Transform},
    instance::{LocationRef, Size},
    outline::{DrawSettings, OutlinePen},
    raw::types::BoundingBox,
};
use swash::scale::{
    Source,
    image::{Content, Image},
};
use swash::zeno::Placement;
use tiny_skia::{
    BlendMode, Color, FillRule, FilterQuality, GradientStop, LinearGradient, Mask, Paint,
    PathBuilder, Pixmap, PixmapPaint, Point, RadialGradient, Rect, Shader, SpreadMode,
};

/// Room around a glyph's box for antialiased edges, in pixels.
const MARGIN: f32 = 1.0;
/// The largest side of a glyph's image, in pixels: past it nothing is drawn.
const LARGEST_SIDE: f32 = 4096.0;

/// The COLRv1 glyph `glyph_id` of the font at `index` in `data`, at
/// `pixels_per_em` and the variation `coords`, as the image swash would
/// give for a colour glyph: straight (not premultiplied) RGBA, placed from
/// the glyph's origin on the baseline. `None` when the font has no COLRv1
/// paint for the glyph, so the caller goes on to what swash can draw.
pub(crate) fn render(
    data: &[u8],
    index: u32,
    glyph_id: u16,
    pixels_per_em: f32,
    coords: &[i16],
) -> Option<Image> {
    let font = FontRef::from_index(data, index).ok()?;
    let glyph = font
        .color_glyphs()
        .get_with_format(GlyphId::new(glyph_id.into()), ColorGlyphFormat::ColrV1)?;
    let coords: Vec<_> = coords
        .iter()
        .map(|&coord| skrifa::instance::NormalizedCoord::from_bits(coord))
        .collect();
    let location = LocationRef::new(&coords);
    let units_per_em = f32::from(font.metrics(Size::unscaled(), location).units_per_em);
    if units_per_em <= 0.0 || pixels_per_em <= 0.0 {
        return None;
    }
    let scale = pixels_per_em / units_per_em;

    // The glyph's box in font units, y up: its clip box, or the em square
    // around the origin for a font that gives none.
    let bounds = glyph
        .bounding_box(location, Size::unscaled())
        .unwrap_or(BoundingBox {
            x_min: 0.0,
            y_min: -0.25 * units_per_em,
            x_max: units_per_em,
            y_max: units_per_em,
        });
    let left = (bounds.x_min * scale - MARGIN).floor();
    let top = (bounds.y_max * scale + MARGIN).ceil();
    let width = (bounds.x_max * scale + MARGIN).ceil() - left;
    let height = top - (bounds.y_min * scale - MARGIN).floor();
    if !(1.0..=LARGEST_SIDE).contains(&width) || !(1.0..=LARGEST_SIDE).contains(&height) {
        return None;
    }

    // Font units, y up, to pixels of the image, y down.
    let to_image = tiny_skia::Transform::from_row(scale, 0.0, 0.0, -scale, -left, top);
    let mut painter = Painter::new(&font, location, width as u32, height as u32, to_image)?;
    glyph.paint(location, &mut painter).ok()?;
    let pixmap = painter.finish()?;

    let mut data = Vec::with_capacity(pixmap.pixels().len() * 4);
    for pixel in pixmap.pixels() {
        let color = pixel.demultiply();
        data.extend_from_slice(&[color.red(), color.green(), color.blue(), color.alpha()]);
    }
    Some(Image {
        source: Source::ColorOutline(0),
        content: Content::Color,
        placement: Placement {
            left: left as i32,
            top: top as i32,
            width: width as u32,
            height: height as u32,
        },
        data,
    })
}

/// What skrifa's walk of a paint graph draws on: a stack of layers, of
/// transforms and of clips, as the graph pushes and pops them.
struct Painter<'a> {
    font: &'a FontRef<'a>,
    location: LocationRef<'a>,
    /// The first palette's colours (CPAL), which paints name by index.
    palette: Vec<Color>,
    /// The image, then each layer open above it.
    layers: Vec<Pixmap>,
    /// Font units to pixels, then what the graph pushed onto it.
    transforms: Vec<tiny_skia::Transform>,
    /// The clip inside each `push_clip`: `None` is "everything".
    clips: Vec<Option<Mask>>,
    /// A pixmap or a mask could not be made: the glyph is not drawn.
    failed: bool,
}

impl<'a> Painter<'a> {
    fn new(
        font: &'a FontRef<'a>,
        location: LocationRef<'a>,
        width: u32,
        height: u32,
        to_image: tiny_skia::Transform,
    ) -> Option<Self> {
        let palette = font
            .color_palettes()
            .get(0)
            .map(|palette| {
                palette
                    .colors()
                    .iter()
                    .map(|color| Color::from_rgba8(color.red, color.green, color.blue, color.alpha))
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            font,
            location,
            palette,
            layers: vec![Pixmap::new(width, height)?],
            transforms: vec![to_image],
            clips: Vec::new(),
            failed: false,
        })
    }

    /// The image, when every push was popped and nothing failed.
    fn finish(mut self) -> Option<Pixmap> {
        if self.failed || self.layers.len() != 1 {
            return None;
        }
        self.layers.pop()
    }

    fn transform(&self) -> tiny_skia::Transform {
        self.transforms.last().copied().unwrap_or_default()
    }

    /// A palette entry with a paint's own alpha. Index 0xFFFF is the text's
    /// colour, which an emoji has none of: black.
    fn color(&self, palette_index: u16, alpha: f32) -> Color {
        let mut color = self
            .palette
            .get(usize::from(palette_index))
            .copied()
            .unwrap_or(Color::BLACK);
        color.apply_opacity(alpha.clamp(0.0, 1.0));
        color
    }

    fn stops(&self, color_stops: &[ColorStop]) -> Vec<GradientStop> {
        color_stops
            .iter()
            .map(|stop| {
                GradientStop::new(
                    stop.offset.clamp(0.0, 1.0),
                    self.color(stop.palette_index, stop.alpha),
                )
            })
            .collect()
    }

    /// One colour for a gradient that cannot be drawn: its stops' mean.
    fn mean(&self, color_stops: &[ColorStop]) -> Color {
        let count = color_stops.len().max(1) as f32;
        let mut sum = [0.0_f32; 4];
        for stop in color_stops {
            let color = self.color(stop.palette_index, stop.alpha);
            for (total, channel) in
                sum.iter_mut()
                    .zip([color.red(), color.green(), color.blue(), color.alpha()])
            {
                *total += channel / count;
            }
        }
        Color::from_rgba(sum[0], sum[1], sum[2], sum[3]).unwrap_or(Color::TRANSPARENT)
    }

    fn shader(&self, brush: &Brush<'_>) -> Shader<'static> {
        let transform = self.transform();
        let flat = |color_stops: &[ColorStop]| Shader::SolidColor(self.mean(color_stops));
        match brush {
            Brush::Solid {
                palette_index,
                alpha,
            } => Shader::SolidColor(self.color(*palette_index, *alpha)),
            Brush::LinearGradient {
                p0,
                p1,
                color_stops,
                extend,
            } => LinearGradient::new(
                Point::from_xy(p0.x, p0.y),
                Point::from_xy(p1.x, p1.y),
                self.stops(color_stops),
                spread(*extend),
                transform,
            )
            .unwrap_or_else(|| flat(color_stops)),
            Brush::RadialGradient {
                c0,
                r0,
                c1,
                r1,
                color_stops,
                extend,
            } => {
                let mut stops = self.stops(color_stops);
                let concentric = (c0.x - c1.x).abs() < 0.5 && (c0.y - c1.y).abs() < 0.5;
                if concentric && *r0 > 0.0 && r1 > r0 {
                    // tiny-skia's gradient starts at a point: the same
                    // colours, moved out to where the inner circle is.
                    for (stop, color_stop) in stops.iter_mut().zip(color_stops.iter()) {
                        let offset = (r0 + color_stop.offset * (r1 - r0)) / r1;
                        *stop = GradientStop::new(
                            offset.clamp(0.0, 1.0),
                            self.color(color_stop.palette_index, color_stop.alpha),
                        );
                    }
                }
                RadialGradient::new(
                    Point::from_xy(c0.x, c0.y),
                    Point::from_xy(c1.x, c1.y),
                    *r1,
                    stops,
                    spread(*extend),
                    transform,
                )
                .unwrap_or_else(|| flat(color_stops))
            }
            Brush::SweepGradient { color_stops, .. } => flat(color_stops),
        }
    }

    /// Narrow the clip to `path` (in font units, under the transform now).
    fn push_clip(&mut self, path: Option<tiny_skia::Path>) {
        let (width, height) = (self.layers[0].width(), self.layers[0].height());
        let transform = self.transform();
        let mask = match (self.clips.last(), path) {
            // An empty outline clips everything away.
            (_, None) => Mask::new(width, height),
            (Some(Some(inside)), Some(path)) => {
                let mut mask = inside.clone();
                mask.intersect_path(&path, FillRule::Winding, true, transform);
                Some(mask)
            }
            (_, Some(path)) => Mask::new(width, height).map(|mut mask| {
                mask.fill_path(&path, FillRule::Winding, true, transform);
                mask
            }),
        };
        self.failed |= mask.is_none();
        self.clips.push(mask);
    }
}

impl ColorPainter for Painter<'_> {
    fn push_transform(&mut self, transform: Transform) {
        let pushed = tiny_skia::Transform::from_row(
            transform.xx,
            transform.yx,
            transform.xy,
            transform.yy,
            transform.dx,
            transform.dy,
        );
        self.transforms.push(self.transform().pre_concat(pushed));
    }

    fn pop_transform(&mut self) {
        if self.transforms.len() > 1 {
            self.transforms.pop();
        }
    }

    fn push_clip_glyph(&mut self, glyph_id: GlyphId) {
        let mut pen = PathPen(PathBuilder::new());
        let drawn = self
            .font
            .outline_glyphs()
            .get(glyph_id)
            .and_then(|outline| {
                let settings = DrawSettings::unhinted(Size::unscaled(), self.location);
                outline.draw(settings, &mut pen).ok()
            });
        let path = drawn.and_then(|_| pen.0.finish());
        self.push_clip(path);
    }

    fn push_clip_box(&mut self, clip_box: BoundingBox<f32>) {
        let rect = Rect::from_ltrb(
            clip_box.x_min,
            clip_box.y_min,
            clip_box.x_max,
            clip_box.y_max,
        );
        self.push_clip(rect.map(PathBuilder::from_rect));
    }

    fn pop_clip(&mut self) {
        self.clips.pop();
    }

    fn fill(&mut self, brush: Brush<'_>) {
        let paint = Paint {
            shader: self.shader(&brush),
            anti_alias: true,
            ..Paint::default()
        };
        let mask = self.clips.last().and_then(Option::as_ref);
        let Some(layer) = self.layers.last_mut() else {
            return;
        };
        if let Some(everything) =
            Rect::from_xywh(0.0, 0.0, layer.width() as f32, layer.height() as f32)
        {
            layer.fill_rect(everything, &paint, tiny_skia::Transform::identity(), mask);
        }
    }

    fn push_layer(&mut self, _composite_mode: CompositeMode) {
        match Pixmap::new(self.layers[0].width(), self.layers[0].height()) {
            Some(layer) => self.layers.push(layer),
            None => self.failed = true,
        }
    }

    fn pop_layer_with_mode(&mut self, composite_mode: CompositeMode) {
        if self.layers.len() < 2 {
            return;
        }
        let Some(layer) = self.layers.pop() else {
            return;
        };
        let paint = PixmapPaint {
            opacity: 1.0,
            blend_mode: blend(composite_mode),
            quality: FilterQuality::Nearest,
        };
        let mask = self.clips.last().and_then(Option::as_ref);
        if let Some(below) = self.layers.last_mut() {
            below.draw_pixmap(
                0,
                0,
                layer.as_ref(),
                &paint,
                tiny_skia::Transform::identity(),
                mask,
            );
        }
    }
}

/// A glyph's outline as a tiny-skia path.
struct PathPen(PathBuilder);

impl OutlinePen for PathPen {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to(x, y);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to(x, y);
    }

    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        self.0.quad_to(cx0, cy0, x, y);
    }

    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        self.0.cubic_to(cx0, cy0, cx1, cy1, x, y);
    }

    fn close(&mut self) {
        self.0.close();
    }
}

fn spread(extend: Extend) -> SpreadMode {
    match extend {
        Extend::Repeat => SpreadMode::Repeat,
        Extend::Reflect => SpreadMode::Reflect,
        _ => SpreadMode::Pad,
    }
}

fn blend(mode: CompositeMode) -> BlendMode {
    match mode {
        CompositeMode::Clear => BlendMode::Clear,
        CompositeMode::Src => BlendMode::Source,
        CompositeMode::Dest => BlendMode::Destination,
        CompositeMode::DestOver => BlendMode::DestinationOver,
        CompositeMode::SrcIn => BlendMode::SourceIn,
        CompositeMode::DestIn => BlendMode::DestinationIn,
        CompositeMode::SrcOut => BlendMode::SourceOut,
        CompositeMode::DestOut => BlendMode::DestinationOut,
        CompositeMode::SrcAtop => BlendMode::SourceAtop,
        CompositeMode::DestAtop => BlendMode::DestinationAtop,
        CompositeMode::Xor => BlendMode::Xor,
        CompositeMode::Plus => BlendMode::Plus,
        CompositeMode::Screen => BlendMode::Screen,
        CompositeMode::Overlay => BlendMode::Overlay,
        CompositeMode::Darken => BlendMode::Darken,
        CompositeMode::Lighten => BlendMode::Lighten,
        CompositeMode::ColorDodge => BlendMode::ColorDodge,
        CompositeMode::ColorBurn => BlendMode::ColorBurn,
        CompositeMode::HardLight => BlendMode::HardLight,
        CompositeMode::SoftLight => BlendMode::SoftLight,
        CompositeMode::Difference => BlendMode::Difference,
        CompositeMode::Exclusion => BlendMode::Exclusion,
        CompositeMode::Multiply => BlendMode::Multiply,
        CompositeMode::HslHue => BlendMode::Hue,
        CompositeMode::HslSaturation => BlendMode::Saturation,
        CompositeMode::HslColor => BlendMode::Color,
        CompositeMode::HslLuminosity => BlendMode::Luminosity,
        // Source over, and whatever a newer table names.
        _ => BlendMode::SourceOver,
    }
}
