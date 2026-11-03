//! A drag's icon (mirin): a PNG, JPEG, or SVG file drawn into a shm buffer,
//! the pixels Wayland's ARGB8888 wants (premultiplied, little-endian BGRA).

use std::path::Path;

/// `path` drawn to fit `size` × `size` device pixels, or None if it can't be read.
pub(crate) fn rasterize(path: &Path, size: u32) -> Option<(Vec<u8>, u32, u32)> {
    let size = size.clamp(8, 512);
    let rgba = if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
    {
        let data = std::fs::read(path).ok()?;
        let tree = resvg::usvg::Tree::from_data(&data, &resvg::usvg::Options::default()).ok()?;
        let fit = tree
            .size()
            .to_int_size()
            .scale_to(resvg::tiny_skia::IntSize::from_wh(size, size)?);
        let mut pixmap = resvg::tiny_skia::Pixmap::new(fit.width(), fit.height())?;
        let transform = resvg::tiny_skia::Transform::from_scale(
            fit.width() as f32 / tree.size().width(),
            fit.height() as f32 / tree.size().height(),
        );
        resvg::render(&tree, transform, &mut pixmap.as_mut());
        // tiny-skia's pixels are premultiplied RGBA already.
        let (width, height) = (pixmap.width(), pixmap.height());
        return Some((to_bgra(pixmap.take(), false), width, height));
    } else {
        image::open(path).ok()?.thumbnail(size, size).into_rgba8()
    };
    let (width, height) = rgba.dimensions();
    Some((to_bgra(rgba.into_raw(), true), width, height))
}

/// RGBA → premultiplied BGRA (premultiplying when `straight`).
fn to_bgra(mut pixels: Vec<u8>, straight: bool) -> Vec<u8> {
    for px in pixels.chunks_exact_mut(4) {
        let a = px[3] as u16;
        let (mut r, mut g, mut b) = (px[0] as u16, px[1] as u16, px[2] as u16);
        if straight {
            r = r * a / 255;
            g = g * a / 255;
            b = b * a / 255;
        }
        px[0] = b as u8;
        px[1] = g as u8;
        px[2] = r as u8;
    }
    pixels
}
