//! CEF engine: browser-process boot, app/client handlers, window/browser
//! lifecycle, and the command/event surface the FFI layer (lib.rs) exposes to
//! the Bun Worker. Handler structure adapted from cef-rs's cefsimple example
//! (Apache-2.0/MIT), reshaped for mirin-owned windows (docs/architecture.md §1).
//!
//! Close lifecycle (the M1 spike result, see docs/macos-mvp.md): a browser
//! parented into our NSWindow needs Alloy runtime + a non-force close that
//! detaches CEF's view from the superview in `do_close` for `on_before_close`
//! to fire. We never hold the handler lock across `close_browser`.

use cef::*;
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::ffi::{c_char, CString};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

#[cfg(target_os = "macos")]
use crate::mac;
#[cfg(target_os = "windows")]
use crate::win;

pub mod clipboard;
pub mod codec;
pub mod dialog;
pub mod menu;
pub mod osr;
pub mod shortcut;
pub mod tray;

pub use clipboard::{clipboard_read_text, clipboard_write_text};
pub use dialog::dialog_show;
pub use menu::{popup_menu, set_app_menu};
pub use shortcut::{shortcut_register, shortcut_unregister};
pub use tray::{tray_create, tray_destroy};

/// What `load_cef` returns and the caller holds for the process lifetime. On
/// macOS this is the framework loader (must outlive CEF). On Windows libcef.dll
/// is resolved by the OS loader (linked via cef-dll-sys's import lib), so there
/// is nothing to keep alive — the unit type stands in.
#[cfg(target_os = "macos")]
type Library = library_loader::LibraryLoader;
#[cfg(not(target_os = "macos"))]
type Library = ();

/// Startup options passed to `run_core` (parsed from the FFI `mirin_run` JSON,
/// or built directly by the m1-smoke test binary).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct CoreConfig {
    /// Writable CEF cache dir (required on recent macOS; cef-rs #287).
    pub cache_path: String,
    /// CEF subprocess executable. Derived from the bundle if empty.
    pub subprocess_path: String,
    /// If set, serve `app://` from this dir (production builds; empty in dev).
    pub resources_path: String,
    /// If set, open a window with this URL at startup (Bun-less m1-smoke test).
    pub startup_url: Option<String>,
    /// Development run (`mirin dev`): enables web-inspector context-menu items.
    #[serde(default)]
    pub dev: bool,
    /// App bundle identifier (e.g. "dev.netko.anko"). Keys the per-app CEF cache
    /// dir on Windows (which has no OS bundle id); empty falls back to "app".
    #[serde(default)]
    pub identifier: String,
    /// Single-instance app: a second launch focuses the running window and exits
    /// instead of opening another window (which would collide on CEF's cache
    /// singleton and show a bare Chromium window). Default true; set false to allow
    /// multiple instances (each gets its own cache dir).
    #[serde(default = "default_true")]
    pub single_instance: bool,
}

/// Per-window creation options (from the Bun Worker via `mirin_window_create`).
/// Unknown fields (e.g. the manifest's `show` paint hint) are ignored by serde.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowOpts {
    #[serde(default = "default_title")]
    pub title: String,
    #[serde(default = "default_width")]
    pub width: f64,
    #[serde(default = "default_height")]
    pub height: f64,
    /// Minimum window size; the OS won't resize below it (0 = no minimum).
    #[serde(default)]
    pub min_width: f64,
    #[serde(default)]
    pub min_height: f64,
    /// Screen position (bottom-left origin, points). Centered when absent.
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    pub url: String,
    /// "hidden" | "hiddenInset" | absent (standard title bar).
    #[serde(default)]
    pub title_bar_style: Option<String>,
    #[serde(default)]
    pub transparent: bool,
    /// Native background material behind the web UI (implies transparent/OSR).
    #[serde(default)]
    pub material: Option<WindowMaterial>,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default)]
    pub movable_by_background: bool,
    /// Custom traffic-light inset for a custom title bar (macOS).
    #[serde(default)]
    pub traffic_light_position: Option<TrafficLightPos>,
    /// Show the window at creation (false creates it hidden, e.g. a Spotlight panel).
    #[serde(default = "default_true")]
    pub visible: bool,
}

/// Custom traffic-light inset (the `trafficLightPosition` config option).
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct TrafficLightPos {
    pub x: f64,
    pub y: f64,
}

/// A window's native background material (the `material` config option,
/// normalized to object form by the TS runtime).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowMaterial {
    /// "liquidGlass" | a vibrancy name (sidebar/menu/popover/hud/…).
    #[serde(rename = "type", default)]
    pub kind: String,
    /// Optional Liquid Glass tint as a CSS hex color (#RGB/#RRGGBB/#RRGGBBAA).
    #[serde(default)]
    pub tint: Option<String>,
    /// Optional corner radius in points.
    #[serde(default)]
    pub corner_radius: Option<f64>,
}

impl WindowOpts {
    fn startup(url: String) -> Self {
        Self {
            title: default_title(),
            width: default_width(),
            height: default_height(),
            min_width: 0.0,
            min_height: 0.0,
            x: None,
            y: None,
            url,
            title_bar_style: None,
            transparent: false,
            material: None,
            always_on_top: false,
            movable_by_background: false,
            traffic_light_position: None,
            visible: true,
        }
    }
}

fn default_title() -> String {
    "mirin".into()
}
fn default_width() -> f64 {
    1024.0
}
fn default_height() -> f64 {
    768.0
}
fn default_true() -> bool {
    true
}

// ---- process-global state shared across the FFI boundary ----

static NEXT_WINDOW_ID: AtomicU32 = AtomicU32::new(1);
static READY: AtomicBool = AtomicBool::new(false);
/// True under `mirin dev`; gates the web-inspector context-menu item.
static IS_DEV: AtomicBool = AtomicBool::new(false);
static RPC_PORT: AtomicU16 = AtomicU16::new(0);
static RPC_TOKEN: Mutex<String> = Mutex::new(String::new());

/// Events are buffered here and drained by the Worker via `mirin_poll_event`.
/// We poll rather than use a bun:ffi threadsafe callback: the host's main thread
/// is blocked inside `mirin_run` (the CEF loop), and a callback invoked from it
/// does not reach the Worker's event loop. Statics are shared across the host's
/// and Worker's `dlopen` of this dylib, so a queue is the simplest reliable
/// channel (docs/architecture.md §3 fallback).
static EVENT_QUEUE: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

thread_local! {
    /// Holds the most recently polled event so its C string stays valid until
    /// the next poll (the Worker copies it out synchronously before polling again).
    static CURRENT_EVENT: RefCell<Option<CString>> = const { RefCell::new(None) };
}

pub fn set_rpc_endpoint(port: u16, token: String) {
    RPC_PORT.store(port, Ordering::SeqCst);
    *RPC_TOKEN.lock().expect("rpc token lock") = token;
}

pub fn is_ready() -> bool {
    READY.load(Ordering::SeqCst)
}

/// Whether this is a `mirin dev` run (enables the Inspect Element context menu).
pub fn is_dev() -> bool {
    IS_DEV.load(Ordering::Relaxed)
}

/// Queue a JSON event for the Worker to drain.
pub fn emit_event(json: &str) {
    EVENT_QUEUE
        .lock()
        .expect("event queue")
        .push_back(json.to_string());
}

/// Queue a `window.<kind>` event for `id` (focus/blur/moved/resized/...).
pub fn emit_window_event(id: u32, kind: &str) {
    emit_event(&format!(r#"{{"type":"window.{kind}","id":{id}}}"#));
}

/// Queue a `window.<kind>` event carrying the window's frame + maximized state.
/// Frame coordinates are screen points with a bottom-left origin.
pub fn emit_window_frame(id: u32, kind: &str, x: f64, y: f64, w: f64, h: f64, maximized: bool) {
    emit_event(&format!(
        r#"{{"type":"window.{kind}","id":{id},"frame":{{"x":{x},"y":{y},"width":{w},"height":{h}}},"maximized":{maximized}}}"#
    ));
}

/// Pop the next queued event as a C string (valid until the next call), or null.
pub fn poll_event() -> *const c_char {
    let next = EVENT_QUEUE.lock().expect("event queue").pop_front();
    match next {
        Some(json) => {
            let cstr = CString::new(json).unwrap_or_default();
            let ptr = cstr.as_ptr();
            CURRENT_EVENT.with(|c| *c.borrow_mut() = Some(cstr));
            ptr
        }
        None => std::ptr::null(),
    }
}

// ---- boot ----

/// Run the browser process: load CEF, init, message loop, shutdown. Called on
/// the process main thread (the FFI `mirin_run`, or the m1-smoke binary). Does
/// not return until the app quits.
// `config` is mutated only under `#[cfg(windows)]` (per-instance cache path); on
// other targets the `mut` is correctly unused.
#[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
pub fn run_core(mut config: CoreConfig) -> i32 {
    IS_DEV.store(config.dev, Ordering::Relaxed);
    // Per-Monitor-v2 DPI awareness + an explicit AppUserModelID (so the taskbar
    // shows our icon, not Bun's) must be set before any window/CEF init.
    #[cfg(target_os = "windows")]
    {
        win::set_dpi_awareness();
        win::set_app_id(config.dev);
        if config.single_instance {
            if !win::acquire_single_instance(config.dev) {
                // A second launch: focus the running window and exit cleanly,
                // BEFORE CEF init — otherwise the locked cache singleton shows a
                // bare Chromium window.
                win::activate_existing_instance();
                return 0;
            }
        } else {
            // Multiple instances allowed → give this one its own cache dir so it
            // doesn't collide with another instance's CEF cache singleton.
            config.cache_path = format!(
                "{}-{}",
                config.cache_path.trim_end_matches(['/', '\\']),
                std::process::id()
            );
        }
    }
    let _library = load_cef();

    let args = cef::args::Args::new();
    let Some(cmd_line) = args.as_cmd_line() else {
        return 1;
    };
    let main_args = args.as_main_args();

    let type_switch = CefString::from("type");
    let is_browser_process = cmd_line.has_switch(Some(&type_switch)) != 1;
    let ret = execute_process(Some(main_args), None, std::ptr::null_mut());
    if !is_browser_process {
        return if ret >= 0 { 0 } else { 1 };
    }
    debug_assert_eq!(ret, -1, "cannot execute browser process");

    let cache_path = if config.cache_path.is_empty() {
        default_cache_dir(config.dev, &config.identifier)
    } else {
        config.cache_path.clone()
    };
    std::fs::create_dir_all(&cache_path).ok();

    let subprocess_path = if config.subprocess_path.is_empty() {
        derive_subprocess_path()
    } else {
        Some(config.subprocess_path.clone())
    };

    STARTUP_URL.with(|u| *u.borrow_mut() = config.startup_url.clone());
    RESOURCES_PATH.with(|p| *p.borrow_mut() = config.resources_path.clone());

    let mut app = MirinApp::new(RefCell::new(None));
    let mut settings = Settings {
        no_sandbox: !cfg!(feature = "sandbox") as _,
        root_cache_path: CefString::from(cache_path.as_str()),
        // Permit windowless (OSR) browsers, which transparent windows use; this
        // doesn't change windowed browsers.
        windowless_rendering_enabled: 1,
        ..Default::default()
    };
    if let Some(path) = subprocess_path {
        settings.browser_subprocess_path = CefString::from(path.as_str());
    }

    // CEF returns 0 here when another instance already owns this user-data-dir
    // ("Opening in existing browser session"). Exit cleanly instead of
    // panicking — a panic across the FFI boundary aborts with a crash report and
    // can leave a stray Chromium window. (Per-app `-dev` cache dirs mean this
    // normally only happens if the *same* app is launched twice.)
    if initialize(
        Some(main_args),
        Some(&settings),
        Some(&mut app),
        std::ptr::null_mut(),
    ) != 1
    {
        eprintln!(
            "[mirin] CEF did not initialize — another instance of this app is \
             likely already running (same cache dir). Exiting."
        );
        return 1;
    }

    #[cfg(target_os = "macos")]
    let _delegate = mac::setup_app_delegate();

    // Debug hook: quit programmatically after N ms. Lets CI/smoke runs exercise the
    // full graceful-close path (close_all_browsers → on_before_close →
    // quit_message_loop → shutdown) without a human clicking the close button.
    if let Ok(Ok(ms)) = std::env::var("MIRIN_AUTOQUIT_MS").map(|s| s.parse::<u64>()) {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            quit();
        });
    }

    run_message_loop();
    shutdown();
    0
}

#[cfg(target_os = "macos")]
fn load_cef() -> Library {
    let loader = library_loader::LibraryLoader::new(&std::env::current_exe().unwrap(), false);
    assert!(loader.load(), "failed to load Chromium Embedded Framework");
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    mac::setup_application();
    loader
}

/// Windows: libcef.dll is bound at load time via cef-dll-sys's import library and
/// resolved by the OS loader from the host-exe directory (where the dev bundle /
/// `mirin build` place it). No runtime framework loader exists; we only prime the
/// API hash so the cef crate's version negotiation matches the linked libcef.
#[cfg(target_os = "windows")]
fn load_cef() -> Library {
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
}

/// Whether to force software rendering (disable the GPU process). Opt-in via
/// `MIRIN_DISABLE_GPU`, and automatically in Windows remote (RDP) sessions, where
/// the GPU is virtualized and the GPU process crash-loops. Real-hardware,
/// local-session users keep hardware acceleration.
fn should_disable_gpu() -> bool {
    if std::env::var_os("MIRIN_DISABLE_GPU").is_some() {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        return win::is_remote_session();
    }
    #[allow(unreachable_code)]
    false
}

/// The ANGLE backend to force via `--use-angle`, or None to keep Chromium's
/// default. Explicit `MIRIN_ANGLE` wins; otherwise, on Windows, auto-select `gl`
/// when the default D3D11 backend can't initialize (some hybrid GPUs) — probed
/// before CEF init, so it's zero-config.
fn angle_backend() -> Option<String> {
    if let Some(angle) = std::env::var_os("MIRIN_ANGLE") {
        return angle.into_string().ok().filter(|s| !s.is_empty());
    }
    #[cfg(target_os = "windows")]
    if win::gpu::prefer_gl() {
        return Some("gl".to_string());
    }
    None
}

/// Per-app CEF cache dir, keyed on the bundle identifier so distinct mirin apps
/// (and `mirin dev` vs the installed build of the same app) never share one CEF
/// user-data-dir. Sharing it causes singleton-lock collisions: only one mirin app
/// could run at a time, and killing one stranded the other's `SingletonLock`.
/// The `-dev` suffix keeps a dev run separate from the installed app.
///
/// macOS reads the real bundle id from `NSBundle`; Windows has none, so it uses the
/// `identifier` passed from the app config (else "app" — shared, the pre-fix behavior).
fn default_cache_dir(dev: bool, identifier: &str) -> String {
    let id = app_bundle_id()
        .or_else(|| {
            let sanitized: String = identifier
                .chars()
                .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
                .collect();
            (!sanitized.is_empty()).then_some(sanitized)
        })
        .unwrap_or_else(|| "app".into());
    let suffix = if dev { "-dev" } else { "" };
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        format!("{home}/Library/Application Support/mirin/{id}{suffix}/cache")
    }
    #[cfg(target_os = "windows")]
    {
        // Per-user writable cache under %LOCALAPPDATA% (the Windows analogue of
        // ~/Library/Application Support). Keyed per-app to avoid CEF singleton-lock
        // collisions between distinct mirin apps and dev-vs-installed runs.
        let base = std::env::var("LOCALAPPDATA")
            .or_else(|_| std::env::var("TEMP"))
            .unwrap_or_else(|_| "C:\\Temp".into());
        format!("{base}\\mirin\\{id}{suffix}\\cache")
    }
}

/// The running app's bundle identifier (e.g. "dev.netko.anko"), sanitized to a
/// single path segment. `None` if unavailable (e.g. not running from a bundle).
#[cfg(target_os = "macos")]
fn app_bundle_id() -> Option<String> {
    let id = objc2_foundation::NSBundle::mainBundle().bundleIdentifier()?.to_string();
    if id.is_empty() {
        return None;
    }
    Some(id.replace(['/', '\\', ':'], "_"))
}

#[cfg(not(target_os = "macos"))]
fn app_bundle_id() -> Option<String> {
    None
}

/// Derive the CEF subprocess executable from the app bundle layout:
/// `<bundle>/Contents/Frameworks/<exe> Helper.app/Contents/MacOS/<exe> Helper`.
#[cfg(target_os = "macos")]
fn derive_subprocess_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let stem = exe.file_name()?.to_str()?.to_string();
    let macos_dir = exe.parent()?; // Contents/MacOS
    let contents = macos_dir.parent()?; // Contents
    let helper = contents
        .join("Frameworks")
        .join(format!("{stem} Helper.app"))
        .join("Contents/MacOS")
        .join(format!("{stem} Helper"));
    Some(helper.to_str()?.to_string())
}

/// Windows: the CEF subprocess is `mirin-helper.exe`, placed next to the host exe
/// by the dev bundle / `mirin build`.
#[cfg(target_os = "windows")]
fn derive_subprocess_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let helper = exe.parent()?.join("mirin-helper.exe");
    Some(helper.to_str()?.to_string())
}

// ---- commands (callable from the Bun Worker thread; post to the UI thread) ----

thread_local! {
    /// The shared CEF client, created at context init and cloned per browser.
    /// UI-thread only (Client is not Send).
    static CLIENT: RefCell<Option<Client>> = const { RefCell::new(None) };
    /// Startup URL for the m1-smoke test, read at context init.
    static STARTUP_URL: RefCell<Option<String>> = const { RefCell::new(None) };
    /// Resources dir for the app:// scheme, read at context init.
    static RESOURCES_PATH: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Allocate a window id and request creation on the UI thread. Returns the id
/// synchronously (the NSWindow + browser are created asynchronously).
pub fn create_window(opts: WindowOpts) -> u32 {
    let id = NEXT_WINDOW_ID.fetch_add(1, Ordering::Relaxed);
    let mut task = CreateWindowTask::new(id, RefCell::new(Some(opts)));
    post_task(ThreadId::UI, Some(&mut task));
    id
}

pub fn close_window(id: u32) {
    let mut task = WindowCommandTask::new(id, WindowCommand::Close, RefCell::new(None));
    post_task(ThreadId::UI, Some(&mut task));
}

/// Initiate the CEF close of the browser owning `window_id` (non-force). Called
/// from the Windows `WndProc` on `WM_CLOSE`; runs on the UI thread already, so it
/// closes the matching browser directly rather than posting a task. CEF then drives
/// `do_close` → `on_before_close`, which destroys the HWND and quits when the last
/// browser goes.
#[cfg(target_os = "windows")]
pub fn request_window_close(window_id: u32) {
    if let Some(handler) = MirinHandler::instance() {
        MirinHandler::close_browser_for_window(&handler, window_id);
    }
}

pub fn load_url(id: u32, url: String) {
    let mut task = WindowCommandTask::new(id, WindowCommand::LoadUrl, RefCell::new(Some(url)));
    post_task(ThreadId::UI, Some(&mut task));
}

pub fn set_title(id: u32, title: String) {
    let mut task = WindowCommandTask::new(id, WindowCommand::SetTitle, RefCell::new(Some(title)));
    post_task(ThreadId::UI, Some(&mut task));
}

pub fn quit() {
    if let Some(handler) = MirinHandler::instance() {
        MirinHandler::close_all_browsers(&handler, false);
    } else {
        let mut task = QuitTask::new();
        post_task(ThreadId::UI, Some(&mut task));
    }
}

/// Show/hide the app's Dock icon (and menu-bar presence) on the UI thread.
pub fn set_dock_visible(visible: bool) {
    let mut task = SetDockVisibleTask::new(visible);
    post_task(ThreadId::UI, Some(&mut task));
}

/// Apply a window control verb (minimize/maximize/fullscreen/focus/…) on the UI thread.
pub fn window_control(id: u32, verb: String) {
    let mut task = WindowControlTask::new(id, RefCell::new(Some(verb)));
    post_task(ThreadId::UI, Some(&mut task));
}

/// Move a window's bottom-left origin to screen point (x, y) on the UI thread.
pub fn window_set_position(id: u32, x: f64, y: f64) {
    let mut task = WindowSetPositionTask::new(id, x, y);
    post_task(ThreadId::UI, Some(&mut task));
}

/// Maybe begin a native window-move for `id`: `(x, y)` are the viewport coords of a
/// left mousedown (CSS px, top-left). The Windows backend starts a move only if the
/// point is in a draggable title-bar region. macOS drags via its title-bar overlay,
/// so this is Windows-only.
pub fn window_maybe_start_drag(id: u32, x: i32, y: i32, detail: i32, ht: i32) {
    #[cfg(target_os = "windows")]
    {
        let mut task = WindowMaybeStartDragTask::new(id, x, y, detail, ht);
        post_task(ThreadId::UI, Some(&mut task));
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (id, x, y, detail, ht);
}

/// Change a window's native background material live. `spec_json` is the same
/// normalized `{ type, tint?, cornerRadius? }` shape as the create option, or
/// `null`/`{}`/`{"type":"none"}` to remove the material. Only affects OSR
/// (transparent) windows.
pub fn set_material(id: u32, spec_json: String) {
    let material: Option<WindowMaterial> = serde_json::from_str(&spec_json).ok().flatten();
    let mut task = SetMaterialTask::new(id, RefCell::new(Some(material)));
    post_task(ThreadId::UI, Some(&mut task));
}

/// Convert a parsed config material into the AppKit layer's option struct.
#[cfg(target_os = "macos")]
fn material_opts(m: &WindowMaterial) -> mac::osr::MaterialOpts {
    mac::osr::MaterialOpts {
        kind: m.kind.clone(),
        tint: m.tint.as_deref().and_then(parse_hex_rgba),
        corner_radius: m.corner_radius.unwrap_or(14.0),
    }
}

/// Parse a CSS hex color (#RGB, #RRGGBB, #RRGGBBAA) into sRGB rgba in 0..1.
fn parse_hex_rgba(hex: &str) -> Option<[f64; 4]> {
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

/// Build the per-window NSWindow + embedded CEF browser. UI thread only.
#[cfg(target_os = "macos")]
fn create_window_on_ui(id: u32, opts: WindowOpts) {
    let mtm = objc2::MainThreadMarker::new().expect("create_window must run on the main thread");
    let title_bar_style = match opts.title_bar_style.as_deref() {
        Some("hidden") => mac::TitleBarStyle::Hidden,
        Some("hiddenInset") => mac::TitleBarStyle::HiddenInset,
        _ => mac::TitleBarStyle::Default,
    };
    // A material implies a transparent (windowless/OSR) window: the native glass
    // or vibrancy view must show through the web content.
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

    // Transparent windows render windowless (OSR): a windowed CEF browser can't
    // be see-through, so CEF paints into a buffer we draw onto a transparent
    // NSView (mac::osr), optionally behind a native material. Opaque windows
    // embed the browser as a child view.
    //
    // Alloy runtime in both cases (embedding-friendly). extra_info carries the
    // RPC endpoint + window id to the renderer (mirin-helper injects
    // window.mirin from it).
    let window_info = if transparent {
        osr::mark_window(id);
        let osr_view = mac::osr::install(mtm, id, opts.width, opts.height, material);
        WindowInfo::default().set_as_windowless(osr_view)
    } else {
        let mut info = WindowInfo::default().set_as_child(content_view, &bounds);
        info.runtime_style = RuntimeStyle::ALLOY;
        info
    };

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

    // Transparent windows: ask CEF for a transparent backing color so the page's
    // own background (or lack of one) shows through.
    let browser_settings = BrowserSettings {
        background_color: if transparent { 0 } else { 0xFF_FF_FF_FF },
        ..Default::default()
    };

    let url = CefString::from(opts.url.as_str());
    browser_host_create_browser(
        Some(&window_info),
        client.as_mut(),
        Some(&url),
        Some(&browser_settings),
        extra_info.as_mut(),
        None,
    );
}

/// Build the per-window top-level HWND + CEF browser (Windows). UI thread only.
/// Mirrors the macOS `create_window_on_ui`: opaque windows embed CEF as a child
/// HWND (`set_as_child`); transparent/material windows render windowless (OSR) and
/// composite into a layered window so they're see-through.
#[cfg(target_os = "windows")]
fn create_window_on_ui(id: u32, opts: WindowOpts) {
    let title_bar_style = match opts.title_bar_style.as_deref() {
        Some("hidden") => win::TitleBarStyle::Hidden,
        Some("hiddenInset") => win::TitleBarStyle::HiddenInset,
        _ => win::TitleBarStyle::Default,
    };
    // A material implies a transparent (windowless/OSR) window — the see-through
    // backdrop must show through the web content.
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

    // Opaque: CEF owns a child HWND under our window. Transparent: windowless OSR,
    // the parent HWND identifies the monitor and is the layered paint target. Alloy
    // runtime in both; extra_info carries the RPC endpoint + window id.
    let parent = cef::sys::HWND(parent as *mut _);
    let mut window_info = if transparent {
        osr::mark_window(id);
        win::osr::install(id, opts.width, opts.height);
        // A material implies an acrylic blur backdrop behind the web content (the
        // Windows analogue of macOS vibrancy); a plain transparent window shows the
        // raw desktop.
        if let Some(material) = &opts.material {
            let tint = material.tint.as_deref().and_then(parse_hex_rgba);
            win::osr::set_material(id, true, tint);
        }
        WindowInfo::default().set_as_windowless(parent)
    } else {
        WindowInfo::default().set_as_child(parent, &bounds)
    };
    window_info.runtime_style = RuntimeStyle::ALLOY;

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

    // Transparent windows ask CEF for a transparent backing so the page composites
    // with per-pixel alpha.
    let browser_settings = BrowserSettings {
        background_color: if transparent { 0 } else { 0xFF_FF_FF_FF },
        ..Default::default()
    };

    let url = CefString::from(opts.url.as_str());
    browser_host_create_browser(
        Some(&window_info),
        client.as_mut(),
        Some(&url),
        Some(&browser_settings),
        extra_info.as_mut(),
        None,
    );
}

// ---- app + handlers ----

wrap_app! {
    pub struct MirinApp {
        browser_process_handler: RefCell<Option<BrowserProcessHandler>>,
    }

    impl App {
        /// Browser process only. The mock keychain avoids the "Chromium Safe
        /// Storage" prompt that ad-hoc re-signing triggers each build.
        fn on_before_command_line_processing(
            &self,
            process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            let is_browser = process_type.map(|t| t.to_string().is_empty()).unwrap_or(true);
            if let (true, Some(command_line)) = (is_browser, command_line) {
                command_line.append_switch(Some(&CefString::from("use-mock-keychain")));
                // app:// is a SECURE scheme (so pages get crypto.subtle,
                // navigator.clipboard, etc.). Let the secure origin still reach
                // its own loopback RPC: allow insecure localhost (matches
                // Electrobun) — loopback is potentially-trustworthy, so the
                // ws://127.0.0.1 connection isn't treated as mixed content.
                command_line.append_switch(Some(&CefString::from("allow-insecure-localhost")));
                // The app:// origin isn't "local" address space, so Chromium's
                // Local/Private Network Access checks block the RPC
                // ws://127.0.0.1 connection. Disable those features (a desktop
                // app talking to its own loopback is trusted). Feature names are
                // Chromium-version-sensitive; covers the LNA + legacy PNA set.
                command_line.append_switch_with_value(
                    Some(&CefString::from("disable-features")),
                    Some(&CefString::from(
                        "LocalNetworkAccessChecks,\
                         BlockInsecurePrivateNetworkRequests,\
                         PrivateNetworkAccessSendPreflights,\
                         PrivateNetworkAccessForNavigations,\
                         PrivateNetworkAccessForWorkers",
                    )),
                );
                // GPU fallback for headless/VM/RDP hosts where the GPU process
                // crash-loops ("Failed to create shared context for
                // virtualization"). Opt-in via env so real-hardware users keep
                // hardware acceleration. (W5: auto-detect instead of env-gating.)
                if should_disable_gpu() {
                    command_line.append_switch(Some(&CefString::from("disable-gpu")));
                    command_line
                        .append_switch(Some(&CefString::from("disable-gpu-compositing")));
                } else if let Some(angle) = angle_backend() {
                    // ANGLE backend (gl | d3d9 | d3d11 | vulkan | swiftshader),
                    // either forced via MIRIN_ANGLE or auto-selected when the
                    // default D3D11 backend can't initialize on this machine.
                    command_line.append_switch_with_value(
                        Some(&CefString::from("use-angle")),
                        Some(&CefString::from(angle.as_str())),
                    );
                }
            }
        }

        fn on_register_custom_schemes(&self, registrar: Option<&mut SchemeRegistrar>) {
            crate::scheme::register_app_scheme(registrar);
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            let mut handler = self.browser_process_handler.borrow_mut();
            if handler.is_none() {
                *handler = Some(MirinBrowserProcessHandler::new());
            }
            handler.clone()
        }
    }
}

wrap_browser_process_handler! {
    struct MirinBrowserProcessHandler {}

    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);

            let client = MirinHandlerClient::new(MirinHandler::new());
            CLIENT.with(|c| *c.borrow_mut() = Some(client));

            // Register the app:// handler factory (browser process, post-init).
            let resources = RESOURCES_PATH.with(|p| p.borrow().clone());
            if !resources.is_empty() {
                crate::scheme::register_app_factory(resources);
            }

            READY.store(true, Ordering::SeqCst);
            emit_event(r#"{"type":"core.ready"}"#);

            // m1-smoke (Bun-less) path: open the startup window directly.
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if let Some(url) = STARTUP_URL.with(|u| u.borrow().clone()) {
                let id = NEXT_WINDOW_ID.fetch_add(1, Ordering::Relaxed);
                let mut opts = WindowOpts::startup(url);
                // Smoke-test hook for the windowless/transparent path.
                if std::env::var_os("MIRIN_SMOKE_TRANSPARENT").is_some() {
                    opts.transparent = true;
                    if std::env::var_os("MIRIN_SMOKE_MATERIAL").is_some() {
                        opts.material = Some(WindowMaterial {
                            kind: "acrylic".into(),
                            tint: None,
                            corner_radius: None,
                        });
                    }
                }
                create_window_on_ui(id, opts);
            }
        }
    }
}

static MIRIN_HANDLER_INSTANCE: OnceLock<Weak<Mutex<MirinHandler>>> = OnceLock::new();

/// Tracks live browsers and their window ids; quits the message loop when the
/// last browser closes.
pub struct MirinHandler {
    browser_list: Vec<Browser>,
    /// browser identifier -> mirin window id, for routing close events.
    window_ids: HashMap<i32, u32>,
    is_closing: bool,
}

impl MirinHandler {
    pub fn instance() -> Option<Arc<Mutex<Self>>> {
        MIRIN_HANDLER_INSTANCE.get().and_then(|weak| weak.upgrade())
    }

    pub fn new() -> Arc<Mutex<Self>> {
        Arc::new_cyclic(|weak| {
            if let Err(instance) = MIRIN_HANDLER_INSTANCE.set(weak.clone()) {
                assert_eq!(instance.strong_count(), 0, "replacing a viable instance");
            }
            Mutex::new(Self {
                browser_list: Vec::new(),
                window_ids: HashMap::new(),
                is_closing: false,
            })
        })
    }

    fn on_after_created(&mut self, browser: Option<&mut Browser>) {
        debug_assert_ne!(currently_on(ThreadId::UI), 0);
        let browser = browser.cloned().expect("browser is None");

        #[cfg(target_os = "macos")]
        if let Some(host) = browser.host() {
            let view = host.window_handle();
            if let Some(window_id) = mac::window_id_for_view(view) {
                self.window_ids.insert(browser.identifier(), window_id);
                if osr::is_osr_window(window_id) {
                    // Windowless: no embedded view to size; register for paint +
                    // input, then prime CEF with the initial view size.
                    osr::register(window_id, browser.clone());
                    host.was_resized();
                } else {
                    unsafe { mac::make_view_autoresizing(view) };
                    mac::add_titlebar_drag(window_id);
                }
                emit_event(&format!(r#"{{"type":"window.created","id":{window_id}}}"#));
            }
        }

        // Windows: CEF created its browser as a child HWND of our top-level window.
        // Map it back via the HWND's root ancestor, then size the child to the
        // client area (CEF doesn't auto-fit the parent on creation).
        #[cfg(target_os = "windows")]
        if let Some(host) = browser.host() {
            // For a windowed browser, window_handle() is CEF's child HWND (a
            // descendant of our window); for a windowless (OSR) one it's the parent
            // HWND we passed — both resolve to our top-level via the root ancestor.
            if let Some(window_id) = win::window_id_for_cef_handle(host.window_handle().0 as *mut _) {
                self.window_ids.insert(browser.identifier(), window_id);
                if osr::is_osr_window(window_id) {
                    // Windowless: register for paint/input and prime the view size.
                    osr::register(window_id, browser.clone());
                    host.was_resized();
                } else {
                    win::resize_browser_to_client(window_id);
                }
                emit_event(&format!(r#"{{"type":"window.created","id":{window_id}}}"#));
            }
        }

        self.browser_list.push(browser);
    }

    fn do_close(&mut self, browser: Option<&mut Browser>) -> bool {
        debug_assert_ne!(currently_on(ThreadId::UI), 0);
        if self.browser_list.len() == 1 {
            self.is_closing = true;
        }
        // Detach CEF's view from our content view: with the host view torn down,
        // returning false makes CEF destroy the browser and fire on_before_close.
        // Windowless (OSR) browsers have no embedded child view, so they close
        // straightforwardly and must NOT have their content view removed.
        #[cfg(target_os = "macos")]
        if let Some(browser) = browser {
            let is_osr = self
                .window_ids
                .get(&browser.identifier())
                .map(|wid| osr::is_osr_window(*wid))
                .unwrap_or(false);
            if !is_osr {
                if let Some(host) = browser.host() {
                    unsafe { mac::detach_browser_view(host.window_handle()) };
                }
            }
        }
        // Windows: record that CEF acknowledged this browser's close, so the
        // window's WndProc lets the next WM_CLOSE actually DestroyWindow — that
        // tears down the CEF child and fires on_before_close (CEF's documented
        // set_as_child close contract). No macOS-style view-detach hack needed.
        #[cfg(target_os = "windows")]
        if let Some(b) = browser.as_deref() {
            if let Some(&window_id) = self.window_ids.get(&b.identifier()) {
                win::mark_window_closing(window_id);
            }
        }
        false
    }

    fn on_before_close(&mut self, browser: Option<&mut Browser>) {
        debug_assert_ne!(currently_on(ThreadId::UI), 0);
        let mut browser = browser.cloned().expect("browser is None");
        let ident = browser.identifier();

        osr::unregister(ident);
        if let Some(window_id) = self.window_ids.remove(&ident) {
            emit_event(&format!(r#"{{"type":"window.closed","id":{window_id}}}"#));
            #[cfg(target_os = "macos")]
            mac::close_window(window_id);
            #[cfg(target_os = "windows")]
            win::close_window(window_id);
        }

        if let Some(index) = self
            .browser_list
            .iter()
            .position(move |elem| elem.is_same(Some(&mut browser)) != 0)
        {
            self.browser_list.remove(index);
        }

        if self.browser_list.is_empty() {
            emit_event(r#"{"type":"window.all-closed"}"#);
            quit_message_loop();
        }
    }

    /// Close every live browser. Takes the `Arc` (not `&mut self`): close_browser
    /// re-enters on_before_close (same mutex) synchronously on the UI thread, so
    /// we snapshot under a short lock, release, then close.
    pub fn close_all_browsers(this: &Arc<Mutex<Self>>, force_close: bool) {
        if currently_on(ThreadId::UI) == 0 {
            let mut task = CloseAllBrowsers::new(this.clone(), force_close);
            post_task(ThreadId::UI, Some(&mut task));
            return;
        }
        let browsers: Vec<Browser> = {
            let handler = this.lock().expect("failed to lock MirinHandler");
            handler.browser_list.clone()
        };
        for browser in browsers {
            if let Some(host) = browser.host() {
                host.close_browser(force_close.into());
            }
        }
    }

    pub fn is_closing(&self) -> bool {
        self.is_closing
    }

    /// Close the single browser mapped to `window_id` (non-force). Snapshots the
    /// browser under a short lock, then closes outside it — `close_browser`
    /// re-enters `on_before_close` (same mutex) synchronously on the UI thread.
    #[cfg(target_os = "windows")]
    pub fn close_browser_for_window(this: &Arc<Mutex<Self>>, window_id: u32) {
        let browser = {
            let handler = this.lock().expect("failed to lock MirinHandler");
            handler
                .window_ids
                .iter()
                .find(|(_, &wid)| wid == window_id)
                .map(|(&ident, _)| ident)
                .and_then(|ident| {
                    handler
                        .browser_list
                        .iter()
                        .find(|b| b.identifier() == ident)
                        .cloned()
                })
        };
        if let Some(browser) = browser {
            if let Some(host) = browser.host() {
                host.close_browser(0);
            }
        }
    }
}

wrap_client! {
    pub struct MirinHandlerClient {
        inner: Arc<Mutex<MirinHandler>>,
    }

    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(MirinLifeSpanHandler::new(self.inner.clone()))
        }
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(MirinDisplayHandler::new())
        }
        /// Reports `-webkit-app-region` regions so custom title bars can drag
        /// from declared areas while leaving controls clickable.
        fn drag_handler(&self) -> Option<DragHandler> {
            Some(MirinDragHandler::new(self.inner.clone()))
        }
        /// Adds an "Inspect Element" item to the native context menu in dev runs.
        fn context_menu_handler(&self) -> Option<ContextMenuHandler> {
            Some(MirinContextMenuHandler::new())
        }
        /// CEF only invokes this for windowless (OSR) browsers; windowed ones
        /// ignore it. Transparent windows are the OSR case.
        fn render_handler(&self) -> Option<RenderHandler> {
            Some(osr::render_handler())
        }
    }
}

wrap_drag_handler! {
    struct MirinDragHandler {
        inner: Arc<Mutex<MirinHandler>>,
    }

    impl DragHandler {
        /// A page's `-webkit-app-region` regions changed. Forward them to the
        /// hosting window's drag overlay (macOS, windowed). Called on the UI
        /// thread, so AppKit work here is safe.
        fn on_draggable_regions_changed(
            &self,
            browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            regions: Option<&[DraggableRegion]>,
        ) {
            #[cfg(target_os = "macos")]
            {
                let Some(browser) = browser else {
                    return;
                };
                let window_id = {
                    let handler = self.inner.lock().expect("failed to lock MirinHandler");
                    handler.window_ids.get(&browser.identifier()).copied()
                };
                let Some(window_id) = window_id else {
                    return;
                };
                let regions = regions
                    .unwrap_or(&[])
                    .iter()
                    .map(|r| mac::DragRegion {
                        x: r.bounds.x as f64,
                        y: r.bounds.y as f64,
                        w: r.bounds.width as f64,
                        h: r.bounds.height as f64,
                        draggable: r.draggable != 0,
                    })
                    .collect();
                mac::set_draggable_regions(window_id, regions);
            }
            #[cfg(target_os = "windows")]
            {
                let Some(browser) = browser else {
                    return;
                };
                let window_id = {
                    let handler = self.inner.lock().expect("failed to lock MirinHandler");
                    handler.window_ids.get(&browser.identifier()).copied()
                };
                let Some(window_id) = window_id else {
                    return;
                };
                let regions = regions
                    .unwrap_or(&[])
                    .iter()
                    .map(|r| win::DragRegion {
                        x: r.bounds.x as f64,
                        y: r.bounds.y as f64,
                        w: r.bounds.width as f64,
                        h: r.bounds.height as f64,
                        draggable: r.draggable != 0,
                    })
                    .collect();
                win::set_draggable_regions(window_id, regions);
            }
        }
    }
}

/// Context-menu command id for "Inspect Element" (CEF user range 26500..28500).
const MENU_ID_INSPECT: i32 = 26600;

wrap_context_menu_handler! {
    struct MirinContextMenuHandler {}

    impl ContextMenuHandler {
        /// Append an "Inspect Element" entry to the page's native context menu,
        /// dev runs only. The default menu items (passed in `model`) are kept.
        fn on_before_context_menu(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _params: Option<&mut ContextMenuParams>,
            model: Option<&mut MenuModel>,
        ) {
            if !is_dev() {
                return;
            }
            if let Some(model) = model {
                model.add_separator();
                model.add_item(MENU_ID_INSPECT, Some(&CefString::from("Inspect Element")));
            }
        }

        /// Open DevTools at the clicked element when "Inspect Element" is chosen.
        fn on_context_menu_command(
            &self,
            browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            params: Option<&mut ContextMenuParams>,
            command_id: i32,
            _event_flags: EventFlags,
        ) -> i32 {
            if command_id != MENU_ID_INSPECT {
                return 0;
            }
            if let Some(host) = browser.and_then(|b| b.host()) {
                let at = params.map(|p| Point {
                    x: p.xcoord(),
                    y: p.ycoord(),
                });
                host.show_dev_tools(None, None, None, at.as_ref());
            }
            1
        }
    }
}

wrap_display_handler! {
    struct MirinDisplayHandler {}

    impl DisplayHandler {
        /// Surface webview console messages to the host's stderr — useful in dev
        /// and for diagnosing the bundled app.
        fn on_console_message(
            &self,
            _browser: Option<&mut Browser>,
            level: LogSeverity,
            message: Option<&CefString>,
            source: Option<&CefString>,
            line: i32,
        ) -> i32 {
            let msg = message.map(|m| m.to_string()).unwrap_or_default();
            let src = source.map(|s| s.to_string()).unwrap_or_default();
            eprintln!("[webview console] {level:?} {src}:{line} {msg}");
            0
        }
    }
}

wrap_life_span_handler! {
    struct MirinLifeSpanHandler {
        inner: Arc<Mutex<MirinHandler>>,
    }

    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            self.inner.lock().expect("lock").on_after_created(browser);
        }
        fn do_close(&self, browser: Option<&mut Browser>) -> i32 {
            self.inner.lock().expect("lock").do_close(browser).into()
        }
        fn on_before_close(&self, browser: Option<&mut Browser>) {
            self.inner.lock().expect("lock").on_before_close(browser);
        }
    }
}

// ---- UI-thread tasks ----

wrap_task! {
    struct CreateWindowTask {
        id: u32,
        opts: RefCell<Option<WindowOpts>>,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if let Some(opts) = self.opts.borrow_mut().take() {
                create_window_on_ui(self.id, opts);
            }
        }
    }
}

#[derive(Clone)]
enum WindowCommand {
    Close,
    LoadUrl,
    SetTitle,
}

wrap_task! {
    struct WindowCommandTask {
        id: u32,
        command: WindowCommand,
        arg: RefCell<Option<String>>,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            let _id = self.id;
            match self.command {
                WindowCommand::Close => {
                    // Route through CEF's close path so teardown fires correctly.
                    if let Some(handler) = MirinHandler::instance() {
                        MirinHandler::close_all_browsers(&handler, false);
                    }
                }
                WindowCommand::LoadUrl => {
                    if let Some(_url) = self.arg.borrow().as_ref() {
                        // M2: load_url on a specific browser; needs window->browser map.
                        // Deferred until multi-window navigation is exercised.
                    }
                }
                WindowCommand::SetTitle => {
                    #[cfg(target_os = "macos")]
                    if let Some(title) = self.arg.borrow().as_ref() {
                        mac::set_window_title(_id, title);
                    }
                    #[cfg(target_os = "windows")]
                    if let Some(title) = self.arg.borrow().as_ref() {
                        win::set_window_title(_id, title);
                    }
                }
            }
        }
    }
}

wrap_task! {
    struct CloseAllBrowsers {
        inner: Arc<Mutex<MirinHandler>>,
        force_close: bool,
    }
    impl Task {
        fn execute(&self) {
            MirinHandler::close_all_browsers(&self.inner, self.force_close);
        }
    }
}

wrap_task! {
    struct QuitTask {}
    impl Task {
        fn execute(&self) {
            #[cfg(target_os = "macos")]
            mac::close_all_windows();
            #[cfg(target_os = "windows")]
            win::close_all_windows();
        }
    }
}

wrap_task! {
    struct SetDockVisibleTask {
        visible: bool,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            #[cfg(target_os = "macos")]
            mac::app::set_dock_visible(self.visible);
        }
    }
}

wrap_task! {
    struct WindowControlTask {
        id: u32,
        verb: RefCell<Option<String>>,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            #[cfg(target_os = "macos")]
            if let Some(verb) = self.verb.borrow_mut().take() {
                mac::window::control(self.id, &verb);
            }
            #[cfg(target_os = "windows")]
            if let Some(verb) = self.verb.borrow_mut().take() {
                win::control(self.id, &verb);
            }
        }
    }
}

wrap_task! {
    struct WindowSetPositionTask {
        id: u32,
        x: f64,
        y: f64,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            #[cfg(target_os = "macos")]
            mac::window::set_position(self.id, self.x, self.y);
            #[cfg(target_os = "windows")]
            win::set_position(self.id, self.x, self.y);
        }
    }
}

#[cfg(target_os = "windows")]
wrap_task! {
    struct WindowMaybeStartDragTask {
        id: u32,
        x: i32,
        y: i32,
        detail: i32,
        ht: i32,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            win::maybe_start_drag(self.id, self.x, self.y, self.detail, self.ht);
        }
    }
}

wrap_task! {
    struct SetMaterialTask {
        id: u32,
        material: RefCell<Option<Option<WindowMaterial>>>,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            #[cfg(target_os = "macos")]
            if let Some(material) = self.material.borrow_mut().take() {
                let mtm = objc2::MainThreadMarker::new().expect("UI thread");
                mac::osr::set_material(mtm, self.id, material.as_ref().map(material_opts));
            }
            #[cfg(target_os = "windows")]
            if let Some(material) = self.material.borrow_mut().take() {
                match material {
                    Some(m) if m.kind != "none" && !m.kind.is_empty() => {
                        let tint = m.tint.as_deref().and_then(parse_hex_rgba);
                        win::osr::set_material(self.id, true, tint);
                    }
                    _ => win::osr::set_material(self.id, false, None),
                }
            }
        }
    }
}
