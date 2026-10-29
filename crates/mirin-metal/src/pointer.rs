//! Pointer capture for draggable nodes (sliders, resize handles). A press on
//! a node with `onPointer` starts a capture; moves and the release are then
//! reported from the root, wherever the pointer goes, until the button lifts.

use gpui::{
    div, prelude::*, AnyElement, Context, MouseButton, MouseMoveEvent, MouseUpEvent, Pixels, Point,
};

use crate::events::PointerPhase;
use crate::window::RootView;

impl RootView {
    /// Report a pointer phase for `node_id` with its last painted bounds.
    pub(crate) fn emit_pointer(&self, node_id: &str, phase: &str, position: Point<Pixels>) {
        let phase = match phase {
            "down" => PointerPhase::Down,
            "move" => PointerPhase::Move,
            _ => PointerPhase::Up,
        };
        self.events.pointer(
            node_id,
            phase,
            f32::from(position.x),
            f32::from(position.y),
            self.layout.node(node_id),
        );
    }
}

/// Wrap the rendered tree so moves and the release reach an active capture.
pub(crate) fn capture_root(content: AnyElement, cx: &mut Context<RootView>) -> AnyElement {
    div()
        .size_full()
        .on_mouse_move(cx.listener(|view, event: &MouseMoveEvent, _window, _cx| {
            if let Some(id) = view.dragging.clone() {
                view.emit_pointer(&id, "move", event.position);
            }
        }))
        .on_mouse_up(
            MouseButton::Left,
            cx.listener(|view, event: &MouseUpEvent, _window, _cx| {
                if let Some(id) = view.dragging.take() {
                    view.emit_pointer(&id, "up", event.position);
                }
            }),
        )
        .child(content)
        .into_any_element()
}
