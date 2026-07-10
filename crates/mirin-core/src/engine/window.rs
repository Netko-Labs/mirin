use cef::*;
#[cfg(target_os = "linux")]
use std::cell::RefCell;
use std::sync::atomic::Ordering;

#[cfg(target_os = "macos")]
use super::config::WindowMaterial;
use super::config::WindowOpts;
use super::state::{CLIENT, RPC_PORT, RPC_TOKEN};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use crate::engine::osr;

#[cfg(target_os = "linux")]
use crate::linux;
#[cfg(target_os = "macos")]
use crate::mac;
#[cfg(target_os = "windows")]
use crate::win;

#[cfg(target_os = "macos")]
pub(crate) fn material_opts(m: &WindowMaterial) -> mac::osr::MaterialOpts {
    mac::osr::MaterialOpts {
        kind: m.kind.clone(),
        tint: m.tint.as_deref().and_then(parse_hex_rgba),
        corner_radius: m.corner_radius.unwrap_or(14.0),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn parse_hex_rgba(hex: &str) -> Option<[f64; 4]> {
    let h = hex.strip_prefix('#').unwrap_or(hex);
    let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    let (r, g, b, a) = match h.len() {
        3 => {
            let d = |c: char| c.to_digit(16).map(|v| (v * 17) as u8);
            let mut it = h.chars();
            (d(it.next()?)?, d(it.next()?)?, d(it.next()?)?, 255)
        }
        6 => (byte(0)?, byte(2)?, byte(4)?, 255),
        8 => (byte(0)?, byte(2)?, byte(4)?, byte(6)?),
        _ => return None,
    };
    Some([
        r as f64 / 255.0,
        g as f64 / 255.0,
        b as f64 / 255.0,
        a as f64 / 255.0,
    ])
}

#[cfg(target_os = "macos")]
pub(crate) fn create_window_on_ui(id: u32, opts: WindowOpts) {
    let mtm = objc2::MainThreadMarker::new().expect("create_window must run on the main thread");
    let title_bar_style = match opts.title_bar_style.as_deref() {
        Some("hidden") => mac::TitleBarStyle::Hidden,
        Some("hiddenInset") => mac::TitleBarStyle::HiddenInset,
        _ => mac::TitleBarStyle::Default,
    };
    let material = opts.material.as_ref().map(material_opts);
    let transparent = opts.transparent || material.is_some();
    let params = mac::WindowParams {
        id,
        title: &opts.title,
        width: opts.width,
        height: opts.height,
        x: opts.x,
        y: opts.y,
        title_bar_style,
        transparent,
        always_on_top: opts.always_on_top,
        movable_by_background: opts.movable_by_background,
        show: opts.visible,
    };
    let (content_view, bounds) = mac::create_window(mtm, &params);

    if let Some(pos) = opts.traffic_light_position {
        mac::set_traffic_light_position(id, pos.x, pos.y);
    }

    let mut client = CLIENT.with(|c| c.borrow().clone());
    let window_info = if transparent {
        osr::mark_window(id);
        let osr_view = mac::osr::install(mtm, id, opts.width, opts.height, material);
        WindowInfo::default().set_as_windowless(osr_view)
    } else {
        let mut info = WindowInfo::default().set_as_child(content_view, &bounds);
        info.runtime_style = RuntimeStyle::ALLOY;
        info
    };

    create_browser(id, &opts.url, window_info, client.as_mut(), transparent);
}

#[cfg(target_os = "windows")]
pub(crate) fn create_window_on_ui(id: u32, opts: WindowOpts) {
    let title_bar_style = match opts.title_bar_style.as_deref() {
        Some("hidden") => win::TitleBarStyle::Hidden,
        Some("hiddenInset") => win::TitleBarStyle::HiddenInset,
        _ => win::TitleBarStyle::Default,
    };
    let transparent = opts.transparent || opts.material.is_some();
    let params = win::WindowParams {
        id,
        title: opts.title.clone(),
        width: opts.width,
        height: opts.height,
        min_width: opts.min_width,
        min_height: opts.min_height,
        x: opts.x,
        y: opts.y,
        title_bar_style,
        always_on_top: opts.always_on_top,
        transparent,
        show: opts.visible,
    };
    let (parent, bounds) = win::create_window(&params);
    let mut client = CLIENT.with(|c| c.borrow().clone());

    let parent = cef::sys::HWND(parent as *mut _);
    let mut window_info = if transparent {
        osr::mark_window(id);
        win::osr::install(id, opts.width, opts.height);
        if let Some(material) = &opts.material {
            let tint = material.tint.as_deref().and_then(parse_hex_rgba);
            win::osr::set_material(id, true, tint);
        }
        WindowInfo::default().set_as_windowless(parent)
    } else {
        WindowInfo::default().set_as_child(parent, &bounds)
    };
    window_info.runtime_style = RuntimeStyle::ALLOY;

    create_browser(id, &opts.url, window_info, client.as_mut(), transparent);
}

#[cfg(target_os = "linux")]
pub(crate) fn create_window_on_ui(id: u32, opts: WindowOpts) {
    let mut client = CLIENT.with(|c| c.borrow().clone());
    let mut extra_info = browser_extra_info(id);
    let url = CefString::from(opts.url.as_str());
    let browser_settings = BrowserSettings {
        background_color: 0xFF_FF_FF_FF,
        ..Default::default()
    };

    let mut bv_delegate = linux::MirinBrowserViewDelegate::new();
    let browser_view = browser_view_create(
        client.as_mut(),
        Some(&url),
        Some(&browser_settings),
        extra_info.as_mut(),
        None,
        Some(&mut bv_delegate),
    );
    if let Some(bv) = browser_view.as_ref() {
        linux::tag_browser_view(bv, id);
    }

    let frameless = matches!(
        opts.title_bar_style.as_deref(),
        Some("hidden") | Some("hiddenInset")
    );
    let mut win_delegate = linux::MirinWindowDelegate::new(
        RefCell::new(browser_view),
        opts.title.clone(),
        opts.width as i32,
        opts.height as i32,
        opts.visible,
        opts.always_on_top,
        frameless,
    );
    if let Some(window) = window_create_top_level(Some(&mut win_delegate)) {
        linux::register_window(id, window);
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn create_browser(
    id: u32,
    url: &str,
    window_info: WindowInfo,
    client: Option<&mut Client>,
    transparent: bool,
) {
    let mut extra_info = browser_extra_info(id);
    let browser_settings = BrowserSettings {
        background_color: if transparent { 0 } else { 0xFF_FF_FF_FF },
        ..Default::default()
    };
    let url = CefString::from(url);
    browser_host_create_browser(
        Some(&window_info),
        client,
        Some(&url),
        Some(&browser_settings),
        extra_info.as_mut(),
        None,
    );
}

fn browser_extra_info(id: u32) -> Option<DictionaryValue> {
    let mut extra_info = dictionary_value_create();
    if let Some(dict) = extra_info.as_mut() {
        dict.set_int(
            Some(&CefString::from("rpcPort")),
            RPC_PORT.load(Ordering::SeqCst) as i32,
        );
        let token = RPC_TOKEN.lock().expect("rpc token").clone();
        dict.set_string(
            Some(&CefString::from("rpcToken")),
            Some(&CefString::from(token.as_str())),
        );
        dict.set_int(Some(&CefString::from("windowId")), id as i32);
    }
    extra_info
}
