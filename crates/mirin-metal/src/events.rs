//! Events out of the native UI, back to the driver — the return half of the
//! React Native-like loop (driver state → tree in, interactions → events out).

use std::sync::mpsc;

/// An interaction event emitted by a rendered node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeUiEvent {
    /// The `id` prop of the node that emitted the event.
    pub node_id: String,
    pub kind: EventKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    Press,
}

/// Cloneable sender handed into render closures; dropped receivers are fine
/// (the UI outliving its driver just stops reporting).
#[derive(Clone)]
pub(crate) struct EventSender {
    tx: mpsc::Sender<NativeUiEvent>,
}

impl EventSender {
    pub(crate) fn new(tx: mpsc::Sender<NativeUiEvent>) -> Self {
        Self { tx }
    }

    pub(crate) fn press(&self, node_id: &str) {
        let _ = self.tx.send(NativeUiEvent {
            node_id: node_id.to_string(),
            kind: EventKind::Press,
        });
    }
}
