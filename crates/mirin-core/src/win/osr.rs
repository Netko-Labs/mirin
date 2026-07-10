//! Off-screen (windowless) rendering target for transparent windows — the Windows
//! analogue of `mac/osr/mod.rs`. A windowed CEF browser is always opaque, so
//! transparent / material windows render windowless: CEF paints a premultiplied
//! BGRA frame (`engine::osr` → `paint`) that we composite, with per-pixel alpha,
//! into a layered top-level window via `UpdateLayeredWindow` (the electrobun
//! approach). Input is forwarded from the window's WndProc back into CEF
//! (`engine::osr`), since there's no child window to receive it.
//!
//! DPI: OSR windows render at scale 1 (window pixels == buffer pixels) for the
//! MVP — they're typically small panels (command palettes, HUDs).

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;

use windows_sys::Win32::Foundation::{HWND, POINT, RECT, SIZE};
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
    AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowRect, UpdateLayeredWindow, ULW_ALPHA};

use crate::win::window::hwnd_for;

/// Logical (== physical, scale 1) size of each OSR window's render surface.
struct OsrState {
    width: i32,
    height: i32,
}

thread_local! {
    static OSR: RefCell<HashMap<u32, OsrState>> = RefCell::new(HashMap::new());
}

/// Register an OSR render surface for `window_id` at its initial size.
pub fn install(window_id: u32, width: f64, height: f64) {
    OSR.with(|m| {
        m.borrow_mut().insert(
            window_id,
            OsrState {
                width: width.max(1.0) as i32,
                height: height.max(1.0) as i32,
            },
        );
    });
}

pub fn remove(window_id: u32) {
    OSR.with(|m| {
        m.borrow_mut().remove(&window_id);
    });
}

// --- material backdrop (acrylic blur-behind) ---
//
// `SetWindowCompositionAttribute` is undocumented but stable and widely used
// (Electron, etc.) for the Windows-10/11 acrylic blur. windows-sys doesn't expose
// it, so it's declared by name from user32. On a layered (OSR) window the blur
// fills the backdrop, and the page's transparent regions reveal it — the closest
// Windows analogue of macOS vibrancy.

#[repr(C)]
struct AccentPolicy {
    accent_state: u32,
    accent_flags: u32,
    gradient_color: u32,
    animation_id: u32,
}

#[repr(C)]
struct WinCompAttrData {
    attrib: u32,
    pv_data: *mut c_void,
    cb_data: usize,
}

const WCA_ACCENT_POLICY: u32 = 19;
const ACCENT_ENABLE_ACRYLICBLURBEHIND: u32 = 4;
const ACCENT_DISABLED: u32 = 0;

type SetWindowCompositionAttributeFn = unsafe extern "system" fn(HWND, *mut WinCompAttrData) -> i32;

/// `SetWindowCompositionAttribute` is exported by user32.dll but not in its import
/// library (undocumented), so resolve it at runtime via GetProcAddress.
fn set_window_composition_attribute() -> Option<SetWindowCompositionAttributeFn> {
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    let module_name: Vec<u16> = "user32.dll"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: user32 is always loaded; GetProcAddress with a literal name.
    unsafe {
        let user32 = GetModuleHandleW(module_name.as_ptr());
        if user32.is_null() {
            return None;
        }
        GetProcAddress(
            user32,
            c"SetWindowCompositionAttribute".as_ptr() as *const u8,
        )
        .map(|p| std::mem::transmute::<_, SetWindowCompositionAttributeFn>(p))
    }
}

/// Enable (or disable) the acrylic blur backdrop for a material window. `tint` is
/// the material's tint as sRGB rgba in 0..1 (the acrylic gradient color/opacity);
/// `None` uses a subtle mostly-blur default.
pub fn set_material(window_id: u32, enabled: bool, tint: Option<[f64; 4]>) {
    let Some(hwnd) = hwnd_for(window_id) else {
        return;
    };
    // Acrylic gradient color is 0xAABBGGRR; the alpha is the tint opacity over the blur.
    let gradient_color = match tint {
        Some([r, g, b, a]) => {
            let to8 = |v: f64| (v.clamp(0.0, 1.0) * 255.0) as u32;
            (to8(a) << 24) | (to8(b) << 16) | (to8(g) << 8) | to8(r)
        }
        None => 0x3300_0000, // ~20% black tint → mostly blur
    };
    let mut accent = AccentPolicy {
        accent_state: if enabled {
            ACCENT_ENABLE_ACRYLICBLURBEHIND
        } else {
            ACCENT_DISABLED
        },
        accent_flags: 0,
        gradient_color,
        animation_id: 0,
    };
    let mut data = WinCompAttrData {
        attrib: WCA_ACCENT_POLICY,
        pv_data: &mut accent as *mut _ as *mut c_void,
        cb_data: std::mem::size_of::<AccentPolicy>(),
    };
    if let Some(set_attr) = set_window_composition_attribute() {
        // SAFETY: hwnd is live; the accent policy + attr data are valid for the call.
        unsafe { set_attr(hwnd, &mut data) };
    }
}

/// Logical view size for CEF's `view_rect`.
pub fn view_size(window_id: u32) -> Option<(i32, i32)> {
    OSR.with(|m| m.borrow().get(&window_id).map(|s| (s.width, s.height)))
}

/// Device scale factor reported to CEF. OSR windows render at 1.0 for the MVP.
pub fn scale(_window_id: u32) -> Option<f32> {
    Some(1.0)
}

/// Composite CEF's premultiplied-BGRA frame (`buffer`, physical px) into the
/// layered window with per-pixel alpha. UI thread only.
///
/// # Safety
/// `buffer` must point to `width * height * 4` readable bytes for the call.
pub unsafe fn paint(window_id: u32, buffer: *const u8, width: i32, height: i32) {
    if buffer.is_null() || width <= 0 || height <= 0 {
        return;
    }
    let Some(hwnd) = hwnd_for(window_id) else {
        return;
    };
    let Some(len) = pixel_buffer_len(width, height) else {
        return;
    };

    let screen_dc = GetDC(std::ptr::null_mut());
    let mem_dc = CreateCompatibleDC(screen_dc);

    let mut bmi: BITMAPINFO = std::mem::zeroed();
    bmi.bmiHeader.biSize =
        std::mem::size_of::<windows_sys::Win32::Graphics::Gdi::BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = width;
    bmi.bmiHeader.biHeight = -height; // top-down to match CEF's buffer
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;

    let mut bits: *mut c_void = std::ptr::null_mut();
    let dib = CreateDIBSection(
        mem_dc,
        &bmi,
        DIB_RGB_COLORS,
        &mut bits,
        std::ptr::null_mut(),
        0,
    );

    if !dib.is_null() && !bits.is_null() {
        std::ptr::copy_nonoverlapping(buffer, bits as *mut u8, len);

        let old = SelectObject(mem_dc, dib);

        let mut wr = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        GetWindowRect(hwnd, &mut wr);
        let pos = POINT {
            x: wr.left,
            y: wr.top,
        };
        let size = SIZE {
            cx: width,
            cy: height,
        };
        let src = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        UpdateLayeredWindow(
            hwnd, screen_dc, &pos, &size, mem_dc, &src, 0, &blend, ULW_ALPHA,
        );

        SelectObject(mem_dc, old);
        DeleteObject(dib);
    }

    DeleteDC(mem_dc);
    ReleaseDC(std::ptr::null_mut(), screen_dc);
}

fn pixel_buffer_len(width: i32, height: i32) -> Option<usize> {
    usize::try_from(width)
        .ok()?
        .checked_mul(usize::try_from(height).ok()?)?
        .checked_mul(4)
}
