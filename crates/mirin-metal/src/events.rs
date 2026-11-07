//! Events out of the native UI, back to the driver — the return half of the
//! React Native-like loop (driver state → tree in, interactions → events out).

use std::sync::mpsc;

use crate::sim::{LayoutMap, LayoutNode};
use crate::titlebar::Chrome;

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
    /// A `view` with `onPress` was clicked (or pressed from the keyboard),
    /// with the modifiers held.
    Press(Modifiers),
    /// An `input`'s buffer changed; carries the full new value.
    Change { value: String },
    /// An `input` was submitted (Enter, or Ctrl/Cmd+Enter when multiline).
    Submit { value: String },
    /// A navigation key in an `input` with `onKey`: Escape, ArrowUp, ArrowDown.
    Key { value: String },
    /// An `input` with `onSelection` has a new caret or selection: UTF-16
    /// offsets into its text, `start <= end` (equal: the caret, nothing
    /// selected).
    Selection { start: usize, end: usize },
    /// A press on a styled run of an `input` that takes presses (`runs.rs`):
    /// the run's index in `runs`, the UTF-16 offset nearest the pointer, and
    /// the modifiers held. The caret didn't move.
    RunPress {
        run: usize,
        offset: usize,
        modifiers: Modifiers,
    },
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
    /// Right-click on a `view` with `onContextMenu`, in window coordinates,
    /// with the modifiers held.
    ContextMenu {
        x: f32,
        y: f32,
        modifiers: Modifiers,
    },
    /// A key went down in a `view` with `onKeyDown`.
    KeyDown(KeyDown),
    /// A key no focused control took, for the `view` with `onWindowKey`
    /// (`focus/`); Ctrl+V carries the clipboard's text.
    WindowKey {
        key: KeyDown,
        pasted: Option<String>,
    },
    /// The compositor says the window is out of sight (`false`: minimized,
    /// on another desktop) or seen again (`true`); node id is `"root"`.
    Visibility { visible: bool },
    /// A text field took the keyboard (`true`) or none has it any more
    /// (`false`); node id is `"root"`. An app whose menus have shortcuts
    /// hands a field the text keys (Select All, Copy) while one has it.
    Typing { typing: bool },
    /// The wheel or touchpad scrolled over a `view` with `onWheel`, in lines.
    Wheel { dx: f32, dy: f32 },
    /// A `view` with `onLayout` was painted with new bounds (in `bounds`).
    Resize,
    /// Files dragged over a `view` with `onDrop` (enter, over, leave), or
    /// dropped on it, in window coordinates, with the keyboard's modifiers.
    Drop(DropEvent),
    /// The window's chrome: its effective title bar style and the area the
    /// compositor's window controls cover. Sent when the window opens and on
    /// every change (node id is `"root"`).
    Chrome(Chrome),
    /// A newly opened window painted its first frame (node id is `"root"`),
    /// so a driver can time an open; sent once per open.
    Frame,
    /// Something outside asked the window to close (the close control, a
    /// shell's close or quit) and the window stayed, because the driver
    /// asked to answer closes itself (`ask_to_close`; node id is `"root"`).
    CloseRequest,
}

/// One key press for a view with `onKeyDown`: GPUI's key name ("a",
/// "enter", "left", "f5"), the text it types if any, and the modifiers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyDown {
    pub key: String,
    pub text: Option<String>,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub platform: bool,
    pub repeat: bool,
}

/// The modifier keys held during a press: Super is `platform`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub platform: bool,
}

impl From<gpui::Modifiers> for Modifiers {
    fn from(modifiers: gpui::Modifiers) -> Self {
        Self {
            shift: modifiers.shift,
            ctrl: modifiers.control,
            alt: modifiers.alt,
            platform: modifiers.platform,
        }
    }
}

/// Files over, or dropped on, a view with `onDrop`.
#[derive(Debug, Clone, PartialEq)]
pub struct DropEvent {
    pub phase: DropPhase,
    pub x: f32,
    pub y: f32,
    pub paths: Vec<String>,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropPhase {
    Enter,
    Over,
    Leave,
    Drop,
}

impl DropPhase {
    pub fn name(self) -> &'static str {
        match self {
            DropPhase::Enter => "enter",
            DropPhase::Over => "over",
            DropPhase::Leave => "leave",
            DropPhase::Drop => "drop",
        }
    }
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
            EventKind::Press(_) => "press",
            EventKind::Change { .. } => "change",
            EventKind::Submit { .. } => "submit",
            EventKind::Key { .. } => "key",
            EventKind::Selection { .. } => "selection",
            EventKind::RunPress { .. } => "runpress",
            EventKind::Layout { .. } => "layout",
            EventKind::Hover { .. } => "hover",
            EventKind::Pointer { .. } => "pointer",
            EventKind::ContextMenu { .. } => "contextmenu",
            EventKind::KeyDown(_) => "keydown",
            EventKind::WindowKey { .. } => "windowkey",
            EventKind::Visibility { .. } => "visibility",
            EventKind::Typing { .. } => "typing",
            EventKind::Wheel { .. } => "wheel",
            EventKind::Resize => "resize",
            EventKind::Drop(_) => "drop",
            EventKind::Chrome(_) => "chrome",
            EventKind::Frame => "frame",
            EventKind::CloseRequest => "close-request",
        }
    }

    pub fn value(&self) -> Option<&str> {
        match self {
            EventKind::Press(_)
            | EventKind::Selection { .. }
            | EventKind::RunPress { .. }
            | EventKind::WindowKey { .. }
            | EventKind::Visibility { .. }
            | EventKind::Typing { .. }
            | EventKind::Layout { .. }
            | EventKind::Hover { .. }
            | EventKind::Pointer { .. }
            | EventKind::ContextMenu { .. }
            | EventKind::KeyDown(_)
            | EventKind::Wheel { .. }
            | EventKind::Resize
            | EventKind::Drop(_)
            | EventKind::Chrome(_)
            | EventKind::Frame
            | EventKind::CloseRequest => None,
            EventKind::Change { value }
            | EventKind::Submit { value }
            | EventKind::Key { value } => Some(value),
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

    pub(crate) fn press(&self, node_id: &str, modifiers: Modifiers) {
        self.send(node_id, EventKind::Press(modifiers));
    }

    pub(crate) fn window_key(&self, node_id: &str, key: KeyDown, pasted: Option<String>) {
        self.send(node_id, EventKind::WindowKey { key, pasted });
    }

    pub(crate) fn visibility(&self, visible: bool) {
        self.send("root", EventKind::Visibility { visible });
    }

    pub(crate) fn typing(&self, typing: bool) {
        self.send("root", EventKind::Typing { typing });
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

    pub(crate) fn key(&self, node_id: &str, key: &str) {
        self.send(
            node_id,
            EventKind::Key {
                value: key.to_string(),
            },
        );
    }

    pub(crate) fn selection(&self, node_id: &str, (start, end): (usize, usize)) {
        self.send(node_id, EventKind::Selection { start, end });
    }

    pub(crate) fn run_press(&self, node_id: &str, run: usize, offset: usize, modifiers: Modifiers) {
        self.send(
            node_id,
            EventKind::RunPress {
                run,
                offset,
                modifiers,
            },
        );
    }

    pub(crate) fn key_down(&self, node_id: &str, key: KeyDown) {
        self.send(node_id, EventKind::KeyDown(key));
    }

    pub(crate) fn wheel(&self, node_id: &str, dx: f32, dy: f32) {
        self.send(node_id, EventKind::Wheel { dx, dy });
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

    pub(crate) fn drop_event(&self, node_id: &str, event: DropEvent) {
        self.send(node_id, EventKind::Drop(event));
    }

    pub(crate) fn resize(&self, node_id: &str) {
        self.send(node_id, EventKind::Resize);
    }

    pub(crate) fn context_menu(&self, node_id: &str, x: f32, y: f32, modifiers: Modifiers) {
        self.send(node_id, EventKind::ContextMenu { x, y, modifiers });
    }

    pub(crate) fn chrome(&self, chrome: Chrome) {
        self.send("root", EventKind::Chrome(chrome));
    }

    pub(crate) fn frame(&self) {
        self.send("root", EventKind::Frame);
    }

    pub(crate) fn close_request(&self) {
        self.send("root", EventKind::CloseRequest);
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
