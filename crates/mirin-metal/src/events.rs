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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventKind {
    /// A `view` with `onPress` was clicked.
    Press,
    /// An `input`'s buffer changed; carries the full new value.
    Change { value: String },
    /// An `input` was submitted (Enter, or Ctrl/Cmd+Enter when multiline).
    Submit { value: String },
}

impl EventKind {
    /// Wire name used by the stdio host and the TypeScript side.
    pub fn name(&self) -> &'static str {
        match self {
            EventKind::Press => "press",
            EventKind::Change { .. } => "change",
            EventKind::Submit { .. } => "submit",
        }
    }

    pub fn value(&self) -> Option<&str> {
        match self {
            EventKind::Press => None,
            EventKind::Change { value } | EventKind::Submit { value } => Some(value),
        }
    }
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
        self.send(node_id, EventKind::Press);
    }

    pub(crate) fn change(&self, node_id: &str, value: &str) {
        self.send(
            node_id,
            EventKind::Change {
                value: value.to_string(),
            },
        );
    }

    pub(crate) fn submit(&self, node_id: &str, value: &str) {
        self.send(
            node_id,
            EventKind::Submit {
                value: value.to_string(),
            },
        );
    }

    fn send(&self, node_id: &str, kind: EventKind) {
        let _ = self.tx.send(NativeUiEvent {
            node_id: node_id.to_string(),
            kind,
        });
    }
}
