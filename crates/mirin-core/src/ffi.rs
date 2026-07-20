//! The C ABI consumed by the Bun host/Worker via `bun:ffi` (docs/architecture.md
//! §3, AGENTS.md). Thin: each function parses its C input, calls an `engine::`
//! function, and returns. No logic here.
//!
//! Two callers share these process-global functions: the host's main thread runs
//! `mirin_run` (blocks in the CEF loop); the Worker calls everything else. Both
//! `dlopen` the same dylib, so Rust statics are shared between them.

use crate::engine::{self, CoreConfig, WindowOpts};
use std::ffi::{c_char, c_int, CStr};

fn cstr(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    // SAFETY: bun:ffi passes a live, NUL-terminated buffer for the duration of
    // each synchronous call. Copying prevents a raw-pointer lifetime escaping.
    unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned()
}

// ---- lifecycle ----

/// Host entry point — call on the process main thread. Does not return until quit.
#[no_mangle]
pub extern "C" fn mirin_run(config_json: *const c_char) -> c_int {
    let config: CoreConfig = serde_json::from_str(&cstr(config_json)).unwrap_or_default();
    engine::run_core(config)
}

/// Drain the next queued event as a JSON C string (valid until the next call), or
/// null. The Worker polls this (see engine::poll_event for why we poll).
#[no_mangle]
pub extern "C" fn mirin_poll_event() -> *const c_char {
    engine::poll_event()
}

#[no_mangle]
pub extern "C" fn mirin_set_rpc_endpoint(port: u16, token: *const c_char) {
    engine::set_rpc_endpoint(port, cstr(token));
}

#[no_mangle]
pub extern "C" fn mirin_is_ready() -> c_int {
    engine::is_ready() as c_int
}

#[no_mangle]
pub extern "C" fn mirin_app_quit() {
    engine::quit();
}

/// Show (1) or hide (0) the app's Dock icon / menu-bar presence (macOS).
#[no_mangle]
pub extern "C" fn mirin_app_set_dock_visible(visible: c_int) {
    engine::set_dock_visible(visible != 0);
}

// ---- windows ----

/// Create a window from JSON opts; returns the window id synchronously.
#[no_mangle]
pub extern "C" fn mirin_window_create(opts_json: *const c_char) -> u32 {
    match serde_json::from_str::<WindowOpts>(&cstr(opts_json)) {
        Ok(opts) => engine::create_window(opts),
        Err(_) => 0,
    }
}

#[no_mangle]
pub extern "C" fn mirin_window_close(id: u32) {
    engine::close_window(id);
}

#[no_mangle]
pub extern "C" fn mirin_window_load_url(id: u32, url: *const c_char) {
    engine::load_url(id, cstr(url));
}

#[no_mangle]
pub extern "C" fn mirin_window_set_title(id: u32, title: *const c_char) {
    engine::set_title(id, cstr(title));
}

/// Window control verbs: "minimize" | "maximize" | "restore" | "fullscreen" |
/// "focus" | "show" | "hide" | "center" | "alwaysOnTop:on" | "alwaysOnTop:off".
#[no_mangle]
pub extern "C" fn mirin_window_control(id: u32, verb: *const c_char) {
    engine::window_control(id, cstr(verb));
}

/// Change a window's native background material live (OSR windows only). JSON is
/// `{ type, tint?, cornerRadius? }`, or `null`/`{"type":"none"}` to remove it.
#[no_mangle]
pub extern "C" fn mirin_window_set_material(id: u32, spec_json: *const c_char) {
    engine::set_material(id, cstr(spec_json));
}

/// Move a window's bottom-left origin to screen point (x, y), in points.
#[no_mangle]
pub extern "C" fn mirin_window_set_position(id: u32, x: f64, y: f64) {
    engine::window_set_position(id, x, y);
}

/// Maybe begin a native window-move/resize for `id`: the preload forwards a left
/// mousedown's viewport coords (CSS px, top-left) + click count, plus a Win32
/// resize hit-test code `ht` (0 when not on an edge). `ht != 0` resizes from that
/// edge/corner; otherwise, over a `-webkit-app-region: drag` area the core starts a
/// move (or toggles maximize on a double-click). Windows; no-op on macOS.
#[no_mangle]
pub extern "C" fn mirin_window_maybe_start_drag(
    id: u32,
    x: c_int,
    y: c_int,
    detail: c_int,
    ht: c_int,
) {
    engine::window_maybe_start_drag(id, x, y, detail, ht);
}

// ---- menus ----

#[no_mangle]
pub extern "C" fn mirin_set_app_menu(template_json: *const c_char) {
    engine::set_app_menu(cstr(template_json));
}

#[no_mangle]
pub extern "C" fn mirin_popup_menu(template_json: *const c_char) {
    engine::popup_menu(cstr(template_json));
}

// ---- tray ----

/// Create/replace a tray item from JSON `{ id, title?, tooltip?, menu? }`.
#[no_mangle]
pub extern "C" fn mirin_tray_create(spec_json: *const c_char) {
    engine::tray_create(cstr(spec_json));
}

#[no_mangle]
pub extern "C" fn mirin_tray_destroy(id: u32) {
    engine::tray_destroy(id);
}

// ---- global shortcuts ----

/// Register a global hotkey; on press, emits `shortcut.trigger` with `id`.
/// Returns 1 on success.
#[no_mangle]
pub extern "C" fn mirin_shortcut_register(id: u32, accelerator: *const c_char) -> c_int {
    engine::shortcut_register(id, cstr(accelerator)) as c_int
}

#[no_mangle]
pub extern "C" fn mirin_shortcut_unregister(id: u32) {
    engine::shortcut_unregister(id);
}

// ---- clipboard ----

/// Read clipboard text as a C string (valid until the next clipboard call), or null.
#[no_mangle]
pub extern "C" fn mirin_clipboard_read_text() -> *const c_char {
    engine::clipboard_read_text()
}

#[no_mangle]
pub extern "C" fn mirin_clipboard_write_text(text: *const c_char) {
    engine::clipboard_write_text(cstr(text));
}

// ---- dialogs ----

/// Show a dialog described by JSON `{ requestId, kind, ... }`. The result is
/// delivered asynchronously as a `dialog.result` event carrying `requestId`.
#[no_mangle]
pub extern "C" fn mirin_dialog_show(spec_json: *const c_char) {
    engine::dialog_show(cstr(spec_json));
}

// ---- notifications ----

/// Show a desktop notification described by JSON `{ title, body?, appName? }`.
/// Returns 1 when the host notification service accepted it.
#[no_mangle]
pub extern "C" fn mirin_notification_show(spec_json: *const c_char) -> c_int {
    engine::notification_show(cstr(spec_json)) as c_int
}

// ---- updater codec (zstd + bsdiff; file-path; 0 = ok, non-zero = error) ----

#[no_mangle]
pub extern "C" fn mirin_zstd_compress_file(
    src: *const c_char,
    dst: *const c_char,
    level: c_int,
) -> c_int {
    match engine::codec::zstd_compress_file(&cstr(src), &cstr(dst), level) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

#[no_mangle]
pub extern "C" fn mirin_zstd_decompress_file(src: *const c_char, dst: *const c_char) -> c_int {
    match engine::codec::zstd_decompress_file(&cstr(src), &cstr(dst)) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

#[no_mangle]
pub extern "C" fn mirin_zstd_decompress_file_bounded(
    src: *const c_char,
    dst: *const c_char,
    max_output_bytes: u64,
) -> c_int {
    match engine::codec::zstd_decompress_file_bounded(&cstr(src), &cstr(dst), max_output_bytes) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

#[no_mangle]
pub extern "C" fn mirin_bsdiff_file(
    old: *const c_char,
    new: *const c_char,
    patch: *const c_char,
) -> c_int {
    match engine::codec::bsdiff_file(&cstr(old), &cstr(new), &cstr(patch)) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

#[no_mangle]
pub extern "C" fn mirin_bspatch_file(
    old: *const c_char,
    patch: *const c_char,
    new: *const c_char,
) -> c_int {
    match engine::codec::bspatch_file(&cstr(old), &cstr(patch), &cstr(new)) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

#[no_mangle]
pub extern "C" fn mirin_bspatch_file_bounded(
    old: *const c_char,
    patch: *const c_char,
    new: *const c_char,
    max_old_bytes: u64,
    max_patch_bytes: u64,
    max_output_bytes: u64,
) -> c_int {
    match engine::codec::bspatch_file_bounded(
        &cstr(old),
        &cstr(patch),
        &cstr(new),
        max_old_bytes,
        max_patch_bytes,
        max_output_bytes,
    ) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}
