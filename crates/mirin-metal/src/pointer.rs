//! Pointer capture for draggable nodes (sliders, resize handles). A press on
//! a node with `onPointer` starts a capture; moves and the release are then
//! reported wherever the pointer goes, until the button lifts. That includes
//! outside the window: while a button is held the compositor keeps sending
//! the pointer to the surface it was pressed on, so the listeners are
//! window-wide, not tied to the root's hitbox (which stops at the window's
//! edge, and left a drag that ended outside it stuck).

use gpui::{
    canvas, div, prelude::*, AnyElement, Context, DispatchPhase, DragMoveEvent, ExternalPaths,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point,
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
    let view = cx.weak_entity();
    // Window-wide listeners have to be registered while painting; a canvas
    // with nothing to draw is the place.
    let listeners = canvas(
        |_, _, _| {},
        move |_, _, window, _| {
            // Each press starts unclaimed; the capture phase runs before any
            // node's listener (a drag region asks whether a descendant took
            // the press, and only the innermost handler takes it: press.rs).
            let presses = view.clone();
            window.on_mouse_event(move |event: &MouseDownEvent, phase, _, cx| {
                if phase != DispatchPhase::Capture {
                    return;
                }
                let _ = presses.update(cx, |view, _| match event.button {
                    MouseButton::Left => {
                        view.press_claimed = false;
                        view.claims.begin_left();
                    }
                    MouseButton::Right => view.claims.begin_right(),
                    _ => {}
                });
            });
            let moves = view.clone();
            window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                let _ = moves.update(cx, |view, _| {
                    if let Some(id) = view.dragging.clone() {
                        view.emit_pointer(&id, "move", event.position);
                    }
                    view.drag_moved(
                        event.position,
                        event.pressed_button == Some(MouseButton::Left),
                        window,
                    );
                });
            });
            let releases = view;
            window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                if phase != DispatchPhase::Bubble || event.button != MouseButton::Left {
                    return;
                }
                let _ = releases.update(cx, |view, _| {
                    view.drag_released();
                    if let Some(id) = view.dragging.take() {
                        view.emit_pointer(&id, "up", event.position);
                    }
                });
            });
        },
    )
    .absolute()
    .size_0();
    div()
        .id("mirin-root")
        .size_full()
        .font_family(crate::render::sans_family())
        .on_drag_move::<ExternalPaths>(cx.listener(
            |view, event: &DragMoveEvent<ExternalPaths>, window, cx| {
                let paths = event.drag(cx).clone();
                view.files_over(event.event.position, &paths, window);
            },
        ))
        .on_drop::<ExternalPaths>(cx.listener(|view, paths: &ExternalPaths, window, _cx| {
            view.files_dropped(window.mouse_position(), paths, window);
        }))
        .child(content)
        .child(listeners)
        .into_any_element()
}
