use cef::*;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock, Weak};

mod app;
mod client;
mod context_menu;
mod display;
mod drag;
mod lifespan;

pub use app::MirinApp;

use super::events::emit_event;
use super::{state, tasks};
use crate::engine::osr;

#[cfg(target_os = "linux")]
use crate::linux;
#[cfg(target_os = "macos")]
use crate::mac;
#[cfg(target_os = "windows")]
use crate::win;

static MIRIN_HANDLER_INSTANCE: OnceLock<Weak<Mutex<MirinHandler>>> = OnceLock::new();

struct BeforeCloseOutcome {
    window_id: Option<u32>,
    should_finish: bool,
}

/// Tracks live browsers and their window ids; quits the message loop when the
/// last browser closes.
pub struct MirinHandler {
    browser_list: Vec<Browser>,
    /// browser identifier -> mirin window id, for routing close events.
    window_ids: HashMap<i32, u32>,
    /// Mirin windows whose CEF browser has acknowledged native closure.
    closing_windows: HashSet<u32>,
    quit_requested: bool,
    did_finish: bool,
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
                closing_windows: HashSet::new(),
                quit_requested: false,
                did_finish: false,
            })
        })
    }

    /// Register a newly created browser and return a clone that must be force-closed
    /// after releasing the handler lock when quit won or its reservation was canceled.
    fn on_after_created(&mut self, browser: Option<&mut Browser>) -> Option<Browser> {
        debug_assert_ne!(currently_on(ThreadId::UI), 0);
        let browser = browser.cloned().expect("browser is None");

        #[cfg(target_os = "macos")]
        let window_id = browser
            .host()
            .and_then(|host| mac::window_id_for_view(host.window_handle()));

        #[cfg(target_os = "windows")]
        let window_id = browser
            .host()
            .and_then(|host| win::window_id_for_cef_handle(host.window_handle().0 as *mut _));

        #[cfg(target_os = "linux")]
        let window_id = {
            let mut mapped = browser.clone();
            linux::window_id_for_browser(&mut mapped)
        };

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        let window_id = None;

        let claimed_window_id = window_id.filter(|id| state::finish_window_creation(*id));
        if let Some(window_id) = claimed_window_id {
            self.window_ids.insert(browser.identifier(), window_id);

            #[cfg(target_os = "macos")]
            if let Some(host) = browser.host() {
                let view = host.window_handle();
                if osr::is_osr_window(window_id) {
                    osr::register(window_id, browser.clone());
                    host.was_resized();
                } else {
                    // SAFETY: CEF owns this live NSView and invokes the handler
                    // on the UI thread before the browser can be destroyed.
                    unsafe { mac::make_view_autoresizing(view) };
                    mac::add_titlebar_drag(window_id);
                }
            }

            #[cfg(target_os = "windows")]
            if let Some(host) = browser.host() {
                if osr::is_osr_window(window_id) {
                    osr::register(window_id, browser.clone());
                    host.was_resized();
                } else {
                    win::resize_browser_to_client(window_id);
                }
            }

            emit_event(&format!(r#"{{"type":"window.created","id":{window_id}}}"#));
        }

        self.browser_list.push(browser.clone());
        let reservation_was_canceled = window_id.is_some() && claimed_window_id.is_none();
        (reservation_was_canceled || self.quit_requested || state::quit_requested())
            .then_some(browser)
    }

    fn do_close(&mut self, browser: Option<&mut Browser>) -> bool {
        debug_assert_ne!(currently_on(ThreadId::UI), 0);
        let window_id = browser
            .as_ref()
            .and_then(|browser| self.window_ids.get(&browser.identifier()).copied());
        if let Some(window_id) = window_id {
            self.closing_windows.insert(window_id);
        }

        #[cfg(target_os = "linux")]
        let _ = &browser;
        #[cfg(target_os = "macos")]
        if let Some(browser) = browser {
            let is_osr = window_id.map(osr::is_osr_window).unwrap_or(false);
            if !is_osr {
                if let Some(host) = browser.host() {
                    // SAFETY: this UI-thread callback receives CEF's live NSView;
                    // detaching it is the required non-OSR close handshake.
                    unsafe { mac::detach_browser_view(host.window_handle()) };
                }
            }
        }
        #[cfg(target_os = "windows")]
        if let Some(window_id) = window_id {
            win::mark_window_closing(window_id);
        }
        false
    }

    fn on_before_close(&mut self, browser: Option<&mut Browser>) -> BeforeCloseOutcome {
        debug_assert_ne!(currently_on(ThreadId::UI), 0);
        let mut browser = browser.cloned().expect("browser is None");
        let ident = browser.identifier();

        osr::unregister(ident);
        let window_id = self.window_ids.remove(&ident);

        if let Some(index) = self
            .browser_list
            .iter()
            .position(move |elem| elem.is_same(Some(&mut browser)) != 0)
        {
            self.browser_list.remove(index);
        }

        BeforeCloseOutcome {
            window_id,
            should_finish: self.take_should_finish(),
        }
    }

    fn complete_before_close(this: &Arc<Mutex<Self>>, outcome: BeforeCloseOutcome) {
        if let Some(window_id) = outcome.window_id {
            emit_event(&format!(r#"{{"type":"window.closed","id":{window_id}}}"#));
            #[cfg(target_os = "macos")]
            mac::close_window(window_id);
            #[cfg(target_os = "windows")]
            win::close_window(window_id);
            #[cfg(target_os = "linux")]
            linux::close_window(window_id);

            this.lock()
                .expect("failed to lock MirinHandler")
                .closing_windows
                .remove(&window_id);
        }
        if outcome.should_finish {
            Self::finish_message_loop();
        }
    }

    fn take_should_finish(&mut self) -> bool {
        let should_finish = can_finish(
            self.browser_list.len(),
            state::pending_window_creations(),
            self.did_finish,
        );
        if should_finish {
            self.did_finish = true;
        }
        should_finish
    }

    fn finish_message_loop() {
        #[cfg(target_os = "macos")]
        mac::close_all_windows();
        #[cfg(target_os = "windows")]
        win::close_all_windows();
        #[cfg(target_os = "linux")]
        linux::close_all_windows();
        emit_event(r#"{"type":"window.all-closed"}"#);
        quit_message_loop();
    }

    /// Release a failed/canceled creation, notify the Worker, and re-check an
    /// explicit quit after the exact reservation disappears.
    pub fn fail_window_creation(this: &Arc<Mutex<Self>>, window_id: u32, error: &str) {
        debug_assert_ne!(currently_on(ThreadId::UI), 0);
        if !state::finish_window_creation(window_id) {
            return;
        }
        emit_event(
            &serde_json::json!({
                "type": "window.create-failed",
                "id": window_id,
                "error": error,
            })
            .to_string(),
        );
        Self::finish_quit_if_idle(this);
    }

    /// Close every live browser. Snapshot the browser list under a short lock,
    /// release, then close, because `close_browser` can re-enter this handler.
    pub fn close_all_browsers(this: &Arc<Mutex<Self>>, force_close: bool) {
        if currently_on(ThreadId::UI) == 0 {
            tasks::post_close_all_browsers(this.clone(), force_close);
            return;
        }
        let (browsers, force_close): (Vec<Browser>, bool) = {
            let handler = this.lock().expect("failed to lock MirinHandler");
            (
                handler.browser_list.clone(),
                should_force_close(force_close, handler.quit_requested, state::quit_requested()),
            )
        };
        if browsers.is_empty() {
            quit_message_loop();
            return;
        }
        for browser in browsers {
            if let Some(host) = browser.host() {
                host.close_browser(force_close.into());
            }
        }
    }

    /// Request monotonic application termination. Every current and late browser
    /// is force-closed so beforeunload cancellation cannot poison the quit state.
    pub fn request_quit(this: &Arc<Mutex<Self>>) {
        state::request_quit();
        if currently_on(ThreadId::UI) == 0 {
            tasks::post_request_quit(this.clone());
            return;
        }

        this.lock()
            .expect("failed to lock MirinHandler")
            .quit_requested = true;
        Self::close_all_browsers(this, true);
        Self::finish_quit_if_idle(this);
    }

    /// Complete an explicit zero-window quit after a queued creation is canceled.
    pub fn finish_quit_if_idle(this: &Arc<Mutex<Self>>) {
        if !state::quit_requested() {
            return;
        }
        if currently_on(ThreadId::UI) == 0 {
            tasks::post_finish_quit_if_idle(this.clone());
            return;
        }
        let should_finish = {
            let mut handler = this.lock().expect("failed to lock MirinHandler");
            handler.take_should_finish()
        };
        if should_finish {
            Self::finish_message_loop();
        }
    }

    pub fn is_window_closing(&self, window_id: u32) -> bool {
        self.closing_windows.contains(&window_id)
    }

    /// The live browser mapped to `window_id`, if any. Caller must hold the lock.
    fn browser_for_window(&self, window_id: u32) -> Option<Browser> {
        self.window_ids
            .iter()
            .find(|(_, &wid)| wid == window_id)
            .map(|(&ident, _)| ident)
            .and_then(|ident| {
                self.browser_list
                    .iter()
                    .find(|browser| browser.identifier() == ident)
                    .cloned()
            })
    }

    /// Close only the browser mapped to `window_id`. Snapshot under a short lock,
    /// then call CEF outside it because close can synchronously re-enter handlers.
    pub fn close_browser_for_window(this: &Arc<Mutex<Self>>, window_id: u32) {
        let (browser, force_close) = {
            let handler = this.lock().expect("failed to lock MirinHandler");
            (
                handler.browser_for_window(window_id),
                should_force_close(false, handler.quit_requested, state::quit_requested()),
            )
        };
        if let Some(browser) = browser {
            if let Some(host) = browser.host() {
                host.close_browser(force_close.into());
            }
        }
    }

    /// Navigate only the browser mapped to `window_id`. Snapshot under a short
    /// lock, then call CEF outside it because navigation can re-enter handlers.
    pub fn load_url_for_window(this: &Arc<Mutex<Self>>, window_id: u32, url: &str) {
        let browser = {
            let handler = this.lock().expect("failed to lock MirinHandler");
            handler.browser_for_window(window_id)
        };
        if let Some(browser) = browser {
            if let Some(frame) = browser.main_frame() {
                frame.load_url(Some(&CefString::from(url)));
            }
        }
    }
}

fn can_finish(live_browsers: usize, pending_creations: usize, did_finish: bool) -> bool {
    !did_finish && live_browsers == 0 && pending_creations == 0
}

fn should_force_close(requested: bool, handler_quit: bool, process_quit: bool) -> bool {
    requested || handler_quit || process_quit
}

#[cfg(test)]
mod tests {
    use super::{can_finish, should_force_close, MirinHandler};
    use std::collections::{HashMap, HashSet};

    fn empty_handler() -> MirinHandler {
        MirinHandler {
            browser_list: Vec::new(),
            window_ids: HashMap::new(),
            closing_windows: HashSet::new(),
            quit_requested: false,
            did_finish: false,
        }
    }

    #[test]
    fn waits_for_live_and_pending_browsers_before_finishing() {
        assert!(!can_finish(1, 0, false));
        assert!(!can_finish(0, 1, false));
        assert!(can_finish(0, 0, false));
        assert!(!can_finish(0, 0, true));
    }

    #[test]
    fn closing_state_is_scoped_to_one_window() {
        let mut handler = empty_handler();
        handler.closing_windows.insert(3);
        assert!(handler.is_window_closing(3));
        assert!(!handler.is_window_closing(4));
        handler.closing_windows.remove(&3);
        assert!(!handler.is_window_closing(3));
    }

    #[test]
    fn quit_force_cannot_be_downgraded() {
        assert!(!should_force_close(false, false, false));
        assert!(should_force_close(true, false, false));
        assert!(should_force_close(false, true, false));
        assert!(should_force_close(false, false, true));
    }
}
