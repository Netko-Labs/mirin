//! The tree over AT-SPI, through AccessKit's Unix adapter: it joins the
//! accessibility bus when the session has accessibility on
//! (`org.a11y.Status.IsEnabled`), asks for the tree then, and turns each
//! update into the events Orca listens for (focus, the active descendant,
//! names, states). Its handlers run on its own thread.
//!
//! The tree lives on the window's thread, so the adapter is never handed
//! one from its own: asked for the first tree, it is told there is none
//! yet and the window is woken to publish it (`wake`). Until it asks, and
//! after accessibility is turned off again, nobody listens and the window
//! builds nothing.
//!
//! A shown window that has the keyboard announces itself (`window:activate`,
//! then the focused node: the vendored adapter, forks/accesskit_unix), and
//! one that goes (closed, or hidden by a resident host) deactivates first.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use accesskit::{
    Action, ActionHandler, ActionRequest, ActivationHandler, DeactivationHandler, NodeId,
    TreeUpdate,
};
use accesskit_unix::Adapter;

/// What the adapter's thread tells the window's. Both are set while the
/// adapter's state is locked, as is the update the window answers with, so
/// an adapter waiting for its first tree always gets a whole one.
#[derive(Default)]
struct Listening {
    /// The adapter is on the accessibility bus.
    active: AtomicBool,
    /// It has no tree: the next update is the whole tree.
    whole: AtomicBool,
}

struct Activation<W> {
    listening: Arc<Listening>,
    wake: W,
}

impl<W: Fn() + Send> ActivationHandler for Activation<W> {
    fn request_initial_tree(&mut self) -> Option<TreeUpdate> {
        self.listening.whole.store(true, Ordering::Release);
        self.listening.active.store(true, Ordering::Release);
        (self.wake)();
        None
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

struct Deactivation(Arc<Listening>);

impl DeactivationHandler for Deactivation {
    fn deactivate_accessibility(&mut self) {
        self.0.active.store(false, Ordering::Release);
    }
}

/// Name the application on the accessibility bus; only the first name, given
/// before the first tree is published, counts.
pub(crate) fn name_app(name: &str) {
    accesskit_unix::set_app_name(name);
}

pub(crate) struct Publisher {
    adapter: Adapter,
    listening: Arc<Listening>,
}

impl Drop for Publisher {
    /// The window goes: Orca hears it deactivate, so the next window shown
    /// (the same surface opened again) is a new activation, not a stale one.
    fn drop(&mut self) {
        self.adapter.update_window_focus_state(false);
    }
}

impl Publisher {
    /// `act` gets what a screen reader asked (a click or a focus) and its
    /// node; `wake` is called when the adapter wants the tree. Both run on
    /// the adapter's thread.
    pub(crate) fn new(
        act: impl Fn(Action, NodeId) + Send + 'static,
        wake: impl Fn() + Send + 'static,
    ) -> Self {
        let listening: Arc<Listening> = Arc::default();
        let adapter = Adapter::new(
            Activation {
                listening: Arc::clone(&listening),
                wake,
            },
            Actions(act),
            Deactivation(Arc::clone(&listening)),
        );
        Self { adapter, listening }
    }

    /// Whether the adapter is on the accessibility bus: while it is not,
    /// a tree would go nowhere.
    pub(crate) fn listening(&self) -> bool {
        self.listening.active.load(Ordering::Acquire)
    }

    /// Whether the adapter waits for its first tree.
    pub(crate) fn wants_whole(&self) -> bool {
        self.listening.whole.load(Ordering::Acquire)
    }

    /// Whether the window has the keyboard, for an adapter that is given no
    /// tree (it announces the window when a screen reader starts).
    pub(crate) fn window_active(&mut self, active: bool) {
        self.adapter.update_window_focus_state(active);
    }

    /// Hand the adapter what `build` makes, if it is listening: the whole
    /// tree when `build` is told so (the adapter has none), else what
    /// changed. Then whether the window has the keyboard.
    pub(crate) fn publish(&mut self, active: bool, build: impl FnOnce(bool) -> TreeUpdate) {
        let listening = &self.listening;
        self.adapter
            .update_if_active(|| build(listening.whole.swap(false, Ordering::AcqRel)));
        self.adapter.update_window_focus_state(active);
    }
}
