use cef::Client;
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, Ordering};
use std::sync::Mutex;

pub(crate) static NEXT_WINDOW_ID: AtomicU32 = AtomicU32::new(1);
pub(crate) static READY: AtomicBool = AtomicBool::new(false);
/// Set as soon as any thread requests app termination. Creation tasks check it
/// before touching native UI so an early quit cannot race a new browser into life.
pub(crate) static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);
/// Browser creations accepted by the Worker but not yet observed by
/// `LifeSpanHandler::on_after_created`.
static PENDING_WINDOW_CREATIONS: AtomicU32 = AtomicU32::new(0);
/// True under `mirin dev`; gates the web-inspector context-menu item.
pub(crate) static IS_DEV: AtomicBool = AtomicBool::new(false);
pub(crate) static RPC_PORT: AtomicU16 = AtomicU16::new(0);
pub(crate) static RPC_TOKEN: Mutex<String> = Mutex::new(String::new());

thread_local! {
    /// The shared CEF client, created at context init and cloned per browser.
    /// UI-thread only (Client is not Send).
    pub(crate) static CLIENT: RefCell<Option<Client>> = const { RefCell::new(None) };
    /// Startup URL for the m1-smoke test, read at context init.
    pub(crate) static STARTUP_URL: RefCell<Option<String>> = const { RefCell::new(None) };
    /// Resources dir for the app:// scheme, read at context init.
    pub(crate) static RESOURCES_PATH: RefCell<String> = const { RefCell::new(String::new()) };
    /// Concrete app-icon PNG path, read at context init (Linux `_NET_WM_ICON`).
    pub(crate) static ICON_PATH: RefCell<String> = const { RefCell::new(String::new()) };
    /// App bundle id (e.g. "dev.netko.anko"), read at context init. Linux derives
    /// the window `WM_CLASS` from it so cosmic can identify/group the app.
    pub(crate) static IDENTIFIER: RefCell<String> = const { RefCell::new(String::new()) };
}

pub fn set_rpc_endpoint(port: u16, token: String) {
    RPC_PORT.store(port, Ordering::SeqCst);
    *RPC_TOKEN.lock().expect("rpc token lock") = token;
}

pub fn is_ready() -> bool {
    READY.load(Ordering::SeqCst)
}

pub(crate) fn request_quit() {
    QUIT_REQUESTED.store(true, Ordering::SeqCst);
}

pub(crate) fn quit_requested() -> bool {
    QUIT_REQUESTED.load(Ordering::SeqCst)
}

/// Reserve one asynchronous browser creation unless quit has already won the
/// race. A second check closes the window between the first load and increment.
pub(crate) fn begin_window_creation() -> bool {
    if quit_requested() {
        return false;
    }
    PENDING_WINDOW_CREATIONS.fetch_add(1, Ordering::SeqCst);
    if quit_requested() {
        finish_window_creation();
        return false;
    }
    true
}

/// Mark one accepted browser creation complete and return the remaining count.
pub(crate) fn finish_window_creation() -> u32 {
    let mut current = PENDING_WINDOW_CREATIONS.load(Ordering::SeqCst);
    loop {
        if current == 0 {
            return 0;
        }
        match PENDING_WINDOW_CREATIONS.compare_exchange(
            current,
            current - 1,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => return current - 1,
            Err(actual) => current = actual,
        }
    }
}

pub(crate) fn pending_window_creations() -> u32 {
    PENDING_WINDOW_CREATIONS.load(Ordering::SeqCst)
}

/// Whether this is a `mirin dev` run (enables the Inspect Element context menu).
pub fn is_dev() -> bool {
    IS_DEV.load(Ordering::Relaxed)
}

/// The app-icon PNG path from the init config (empty if none). Read on the UI
/// thread when creating a window to set the Linux taskbar/dock icon.
#[cfg(target_os = "linux")]
pub fn icon_path() -> String {
    ICON_PATH.with(|p| p.borrow().clone())
}

/// Stub on non-Linux targets so `engine::icon_path` remains re-exportable.
#[cfg(not(target_os = "linux"))]
pub fn icon_path() -> String {
    String::new()
}

/// The window `WM_CLASS` (`res_name`, `res_class`) derived from the app's bundle
/// id. Read on the UI thread when creating a Linux window.
#[cfg(target_os = "linux")]
pub fn wm_class() -> Option<(String, String)> {
    let id = IDENTIFIER.with(|p| p.borrow().clone());
    if id.is_empty() {
        return None;
    }
    let res_name = id.rsplit('.').next().unwrap_or(&id).to_lowercase();
    Some((res_name, id))
}

/// Stub on non-Linux targets so `engine::wm_class` remains re-exportable.
#[cfg(not(target_os = "linux"))]
pub fn wm_class() -> Option<(String, String)> {
    None
}
