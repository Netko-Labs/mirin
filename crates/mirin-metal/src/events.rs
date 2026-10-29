//! Events out of the native UI, back to the driver — the return half of the
//! React Native-like loop (driver state → tree in, interactions → events out).

use std::sync::mpsc;

use crate::sim::{LayoutMap, LayoutNode};

/// An interaction event emitted by a rendered node.
#[derive(Debug, Clone, PartialEq)]
pub struct NativeUiEvent {
    /// The `id` prop of the node that emitted the event.
    pub node_id: String,
    pub kind: EventKind,
    /// The node's painted bounds when the event fired, so drivers can anchor
    /// popups to the element that was pressed or hovered.
    pub bounds: Option<LayoutNode>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EventKind {
    /// A `view` with `onPress` was clicked.
    Press,
    /// An `input`'s buffer changed; carries the full new value.
    Change { value: String },
    /// An `input` was submitted (Enter, or Ctrl/Cmd+Enter when multiline).
    Submit { value: String },
    /// Reply to a `layout` simulation query (node id is `"root"`).
    Layout { nodes: Vec<LayoutNode> },
    /// The pointer entered (`true`) or left (`false`) a `view` with `onHover`.
    Hover { hovered: bool },
    /// Pointer down on a `view` with `onPointer`, then every move and the
    /// release until the button goes up. Window coordinates plus the node's
    /// painted bounds, so the driver can compute relative positions.
    Pointer {
        phase: PointerPhase,
        x: f32,
        y: f32,
        bounds: Option<LayoutNode>,
    },
    /// Right-click on a `view` with `onContextMenu`, in window coordinates.
    ContextMenu { x: f32, y: f32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerPhase {
    Down,
    Move,
    Up,
}

impl PointerPhase {
    pub fn name(self) -> &'static str {
        match self {
            PointerPhase::Down => "down",
            PointerPhase::Move => "move",
            PointerPhase::Up => "up",
        }
    }
}

impl EventKind {
    /// Wire name used by the stdio host and the TypeScript side.
    pub fn name(&self) -> &'static str {
        match self {
            EventKind::Press => "press",
            EventKind::Change { .. } => "change",
            EventKind::Submit { .. } => "submit",
            EventKind::Layout { .. } => "layout",
            EventKind::Hover { .. } => "hover",
            EventKind::Pointer { .. } => "pointer",
            EventKind::ContextMenu { .. } => "contextmenu",
        }
    }

    pub fn value(&self) -> Option<&str> {
        match self {
            EventKind::Press
            | EventKind::Layout { .. }
            | EventKind::Hover { .. }
            | EventKind::Pointer { .. }
            | EventKind::ContextMenu { .. } => None,
            EventKind::Change { value } | EventKind::Submit { value } => Some(value),
        }
    }
}

/// Cloneable sender handed into render closures; dropped receivers are fine
/// (the UI outliving its driver just stops reporting).
#[derive(Clone)]
pub(crate) struct EventSender {
    tx: mpsc::Sender<NativeUiEvent>,
    layout: LayoutMap,
}

impl EventSender {
    pub(crate) fn new(tx: mpsc::Sender<NativeUiEvent>, layout: LayoutMap) -> Self {
        Self { tx, layout }
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

    pub(crate) fn hover(&self, node_id: &str, hovered: bool) {
        self.send(node_id, EventKind::Hover { hovered });
    }

    pub(crate) fn pointer(
        &self,
        node_id: &str,
        phase: PointerPhase,
        x: f32,
        y: f32,
        bounds: Option<LayoutNode>,
    ) {
        self.send(
            node_id,
            EventKind::Pointer {
                phase,
                x,
                y,
                bounds,
            },
        );
    }

    pub(crate) fn context_menu(&self, node_id: &str, x: f32, y: f32) {
        self.send(node_id, EventKind::ContextMenu { x, y });
    }

    pub(crate) fn layout(&self, nodes: Vec<LayoutNode>) {
        self.send("root", EventKind::Layout { nodes });
    }

    fn send(&self, node_id: &str, kind: EventKind) {
        let _ = self.tx.send(NativeUiEvent {
            node_id: node_id.to_string(),
            bounds: self.layout.node(node_id),
            kind,
        });
    }
}
