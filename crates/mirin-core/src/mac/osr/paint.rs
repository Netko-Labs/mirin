use objc2::{msg_send, runtime::AnyObject};
use objc2_core_foundation::{CFData, CFRetained};
use objc2_core_graphics::{
    CGBitmapInfo, CGColorRenderingIntent, CGColorSpace, CGDataProvider, CGImage,
    CGImageByteOrderInfo,
};

use super::state;

/// Paint CEF's BGRA buffer (physical pixels) into the view's layer. Main thread.
///
/// # Safety
/// `buffer` must point to `width * height * 4` readable BGRA bytes for the
/// duration of the call (CEF upholds this for the `on_paint` buffer).
pub unsafe fn paint(window_id: u32, buffer: *const u8, width: i32, height: i32) {
    if buffer.is_null() || width <= 0 || height <= 0 {
        return;
    }
    let Some(len) = pixel_buffer_len(width, height) else {
        return;
    };
    // SAFETY: the caller guarantees `buffer` covers the checked pixel length.
    let bytes = unsafe { std::slice::from_raw_parts(buffer, len) };
    let Some(image) = bgra_to_cgimage(bytes, width as usize, height as usize) else {
        return;
    };
    state::with_view(window_id, |view| unsafe {
        let layer: *mut AnyObject = msg_send![view, layer];
        if !layer.is_null() {
            let contents: *const CGImage = &*image;
            let _: () = msg_send![layer, setContents: contents as *const AnyObject];
        }
    });
}

fn pixel_buffer_len(width: i32, height: i32) -> Option<usize> {
    usize::try_from(width)
        .ok()?
        .checked_mul(usize::try_from(height).ok()?)?
        .checked_mul(4)
}

/// Build a CGImage from a tightly-packed BGRA (premultiplied) pixel buffer.
fn bgra_to_cgimage(bytes: &[u8], width: usize, height: usize) -> Option<CFRetained<CGImage>> {
    let data = CFData::from_bytes(bytes);
    let provider = CGDataProvider::with_cf_data(Some(&data))?;
    let color_space = CGColorSpace::new_device_rgb()?;
    // BGRA premultiplied = 32-bit little-endian byte order, alpha first.
    let bitmap_info = CGBitmapInfo(
        CGImageByteOrderInfo::Order32Little.0
            | objc2_core_graphics::CGImageAlphaInfo::PremultipliedFirst.0,
    );
    unsafe {
        CGImage::new(
            width,
            height,
            8,
            32,
            width * 4,
            Some(&color_space),
            bitmap_info,
            Some(&provider),
            std::ptr::null(),
            false,
            CGColorRenderingIntent::RenderingIntentDefault,
        )
    }
}
