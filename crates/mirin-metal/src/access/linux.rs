//! The tree over AT-SPI, through AccessKit's Unix adapter: it joins the
//! accessibility bus when a screen reader is running, asks for the tree
//! then, and turns each update into the events Orca listens for (focus, the
//! active descendant, names, states). Its handlers run on its own thread.

use std::sync::{Arc, Mutex};

use accesskit::{
    Action, ActionHandler, ActionRequest, ActivationHandler, DeactivationHandler, NodeId,
    TreeUpdate,
};
use accesskit_unix::Adapter;

/// The newest tree, for a screen reader that starts listening later.
type Latest = Arc<Mutex<Option<TreeUpdate>>>;

struct Activation(Latest);

impl ActivationHandler for Activation {
    fn request_initial_tree(&mut self) -> Option<TreeUpdate> {
        self.0.lock().ok().and_then(|latest| latest.clone())
    }
}

struct Actions<F>(F);

impl<F: Fn(NodeId) + Send> ActionHandler for Actions<F> {
    fn do_action(&mut self, request: ActionRequest) {
        // A press, or moving the keyboard to a field: both are a click on it.
        if matches!(request.action, Action::Click | Action::Focus) {
            (self.0)(request.target_node);
        }
    }
}

struct Deactivation;

impl DeactivationHandler for Deactivation {
    fn deactivate_accessibility(&mut self) {}
}

pub(crate) struct Publisher {
    adapter: Adapter,
    latest: Latest,
}

impl Publisher {
    /// `press` gets the node a screen reader pressed or focused.
    pub(crate) fn new(press: impl Fn(NodeId) + Send + 'static) -> Self {
        let latest: Latest = Arc::default();
        let adapter = Adapter::new(
            Activation(Arc::clone(&latest)),
            Actions(press),
            Deactivation,
        );
        Self { adapter, latest }
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
