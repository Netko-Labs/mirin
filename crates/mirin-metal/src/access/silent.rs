//! Where no adapter publishes the tree yet (macOS, Windows): nobody
//! listens, so nothing is built.

use accesskit::{Action, NodeId, TreeUpdate};

pub(crate) fn name_app(_name: &str) {}

pub(crate) struct Publisher;

impl Publisher {
    pub(crate) fn new(
        _act: impl Fn(Action, NodeId) + Send + 'static,
        _wake: impl Fn() + Send + 'static,
    ) -> Self {
        Self
    }

    pub(crate) fn listening(&self) -> bool {
        false
    }

    pub(crate) fn wants_whole(&self) -> bool {
        false
    }

    pub(crate) fn window_active(&mut self, _active: bool) {}

    pub(crate) fn publish(&mut self, _active: bool, _build: impl FnOnce(bool) -> TreeUpdate) {}
}
