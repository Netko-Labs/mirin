use cef::Client;
use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};

pub(crate) static NEXT_WINDOW_ID: AtomicU32 = AtomicU32::new(1);
pub(crate) static READY: AtomicBool = AtomicBool::new(false);
/// Set as soon as any thread requests app termination. Creation tasks check it
/// before touching native UI so an early quit cannot race a new browser into life.
pub(crate) static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);
/// Mirin window ids accepted by the Worker but not yet observed by
/// `LifeSpanHandler::on_after_created` or explicitly failed/canceled.
static PENDING_WINDOW_CREATIONS: LazyLock<Mutex<WindowCreationReservations>> =
    LazyLock::new(|| Mutex::new(WindowCreationReservations::default()));
/// True under `mirin dev`; gates the web-inspector context-menu item.
pub(crate) static IS_DEV: AtomicBool = AtomicBool::new(false);
pub(crate) static RPC_PORT: AtomicU16 = AtomicU16::new(0);
pub(crate) static RPC_TOKEN: Mutex<String> = Mutex::new(String::new());

#[derive(Default)]
struct WindowCreationReservations {
    ids: HashSet<u32>,
}

impl WindowCreationReservations {
    fn reserve(&mut self, id: u32) -> bool {
        self.ids.insert(id)
    }

    fn release(&mut self, id: u32) -> bool {
        self.ids.remove(&id)
    }

    fn len(&self) -> usize {
        self.ids.len()
    }
}

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
/// race. The second check closes the window between reservation and return.
pub(crate) fn begin_window_creation(id: u32) -> bool {
    if quit_requested() {
        return false;
    }
    {
        let mut pending = PENDING_WINDOW_CREATIONS
            .lock()
            .expect("pending window creation lock");
        if quit_requested() || !pending.reserve(id) {
            return false;
        }
    }
    if quit_requested() {
        finish_window_creation(id);
        return false;
    }
    true
}

/// Release the exact accepted browser creation. Returns whether that id existed.
pub(crate) fn finish_window_creation(id: u32) -> bool {
    PENDING_WINDOW_CREATIONS
        .lock()
        .expect("pending window creation lock")
        .release(id)
}

/// Release an accepted browser creation and queue its correlated failure exactly
/// once. This also works before CEF installs the shared browser handler.
pub(crate) fn fail_window_creation(id: u32, error: &str) -> bool {
    if !finish_window_creation(id) {
        return false;
    }
    super::events::emit_event(
        &serde_json::json!({
            "type": "window.create-failed",
            "id": id,
            "error": error,
        })
        .to_string(),
    );
    true
}

pub(crate) fn pending_window_creations() -> usize {
    PENDING_WINDOW_CREATIONS
        .lock()
        .expect("pending window creation lock")
        .len()
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

#[cfg(test)]
mod tests {
    use super::{begin_window_creation, fail_window_creation, WindowCreationReservations};
    use crate::engine::events::take_event_for_test;

    #[test]
    fn creation_reservations_release_only_the_matching_window() {
        let mut reservations = WindowCreationReservations::default();
        assert!(reservations.reserve(1));
        assert!(reservations.reserve(2));
        assert_eq!(reservations.len(), 2);

        assert!(!reservations.release(99));
        assert_eq!(reservations.len(), 2);
        assert!(reservations.release(2));
        assert_eq!(reservations.len(), 1);
        assert!(!reservations.release(2));
        assert_eq!(reservations.len(), 1);
        assert!(reservations.release(1));
        assert_eq!(reservations.len(), 0);
    }

    #[test]
    fn creation_reservations_reject_duplicate_ids() {
        let mut reservations = WindowCreationReservations::default();
        assert!(reservations.reserve(7));
        assert!(!reservations.reserve(7));
        assert_eq!(reservations.len(), 1);
    }

    #[test]
    fn failed_creation_without_a_handler_emits_its_correlated_result_once() {
        while take_event_for_test().is_some() {}
        let id = u32::MAX - 1;
        assert!(begin_window_creation(id));
        assert!(fail_window_creation(
            id,
            "native handler unavailable before window creation"
        ));
        let event: serde_json::Value =
            serde_json::from_str(&take_event_for_test().expect("missing failure event")).unwrap();
        assert_eq!(event["type"], "window.create-failed");
        assert_eq!(event["id"], id);
        assert_eq!(
            event["error"],
            "native handler unavailable before window creation"
        );
        assert!(!fail_window_creation(id, "duplicate failure"));
        assert!(take_event_for_test().is_none());
    }
}
