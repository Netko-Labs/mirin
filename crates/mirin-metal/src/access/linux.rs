//! The tree over AT-SPI, through AccessKit's Unix adapter: it joins the
//! accessibility bus when a screen reader is running, asks for the tree
//! then, and turns each update into the events Orca listens for (focus, the
//! active descendant, names, states). Its handlers run on its own thread.
//!
//! A shown window that has the keyboard announces itself (`window:activate`,
//! then the focused node: the vendored adapter, vendor/accesskit_unix), and
//! one that goes (closed, or hidden by a resident host) deactivates first.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use accesskit::{
    Action, ActionHandler, ActionRequest, ActivationHandler, DeactivationHandler, NodeId,
    TreeUpdate,
};
use accesskit_unix::Adapter;

/// The newest tree, for a screen reader that starts listening later.
type Latest = Arc<Mutex<Option<TreeUpdate>>>;

/// Whether a screen reader is listening (the adapter asked for the tree and
/// hasn't let it go since); set from the adapter's thread.
type Listening = Arc<AtomicBool>;

struct Activation(Latest, Listening);

impl ActivationHandler for Activation {
    fn request_initial_tree(&mut self) -> Option<TreeUpdate> {
        self.1.store(true, Ordering::Relaxed);
        self.0.lock().ok().and_then(|latest| latest.clone())
    }
}

struct Actions<F>(F);

impl<F: Fn(Action, NodeId) + Send> ActionHandler for Actions<F> {
    fn do_action(&mut self, request: ActionRequest) {
        // A press, or moving the keyboard; the targets decide what each one
        // does to which node (`tree::Targets::request`).
        if matches!(request.action, Action::Click | Action::Focus) {
            (self.0)(request.action, request.target_node);
        }
    }
}

struct Deactivation(Listening);

impl DeactivationHandler for Deactivation {
    fn deactivate_accessibility(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

/// Name the application on the accessibility bus; only the first name, given
/// before the first tree is published, counts.
pub(crate) fn name_app(name: &str) {
    accesskit_unix::set_app_name(name);
}

pub(crate) struct Publisher {
    adapter: Adapter,
    latest: Latest,
    listening: Listening,
}

impl Drop for Publisher {
    /// The window goes: Orca hears it deactivate, so the next window shown
    /// (the same surface opened again) is a new activation, not a stale one.
    fn drop(&mut self) {
        self.adapter.update_window_focus_state(false);
    }
}

impl Publisher {
    /// `press` gets what a screen reader asked (a click or a focus) and its node.
    pub(crate) fn new(press: impl Fn(Action, NodeId) + Send + 'static) -> Self {
        let latest: Latest = Arc::default();
        let listening: Listening = Arc::default();
        let adapter = Adapter::new(
            Activation(Arc::clone(&latest), Arc::clone(&listening)),
            Actions(press),
            Deactivation(Arc::clone(&listening)),
        );
        Self {
            adapter,
            latest,
            listening,
        }
    }

    /// Whether a screen reader is listening to this window's tree.
    pub(crate) fn listening(&self) -> bool {
        self.listening.load(Ordering::Relaxed)
    }

    /// Hand the adapter a full tree, and whether the window has the keyboard.
    pub(crate) fn publish(&mut self, update: TreeUpdate, window_active: bool) {
        if let Ok(mut latest) = self.latest.lock() {
            *latest = Some(update.clone());
        }
        self.adapter.update_if_active(|| update);
        self.adapter.update_window_focus_state(window_active);
    }
}
