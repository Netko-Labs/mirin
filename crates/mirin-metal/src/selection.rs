//! A field's selection between the renderer and the driver, and the
//! pointer selecting in it: a press places the caret or selects (by word,
//! by line), a drag extends it wherever the pointer goes until the button
//! lifts, and every change is reported to a driver that listens
//! (`onSelection`). A driver's `selection` prop sets it, as `value` sets the
//! text: a selection it echoes late (one the field reported) is not a reset.
//!
//! Every drawn field hears every pointer move and release, pressed or not:
//! a drag can be over before the frame after its press is drawn (a busy or
//! slow window), so listening only from that frame on would miss it. The
//! release ends a drag where the button lifted, moves heard or not.

use std::collections::VecDeque;

use gpui::{
    DispatchPhase, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point,
    WeakEntity, Window,
};

use crate::caret::{Drawn, DrawnCell};
use crate::events::EventSender;
use crate::field::{Field, Press};
use crate::tree::InputProps;
use crate::window::{driver_resets, RootView};

#[cfg(test)]
mod tests;

/// In the host binary while its fields have a caret and selection the
/// pointer and the driver can set (Dashi's check for a patched host).
pub(crate) const SELECTION_MARKER: &str = "MIRIN_METAL_SELECTION";

/// Selections reported and not yet echoed, kept per field.
const MAX_ECHOES: usize = 64;

/// A field's selection state beside its `Field`.
#[derive(Default)]
pub(crate) struct SelectionState {
    /// The field as the last painted frame drew it (`caret.rs`).
    pub(crate) drawn: DrawnCell,
    /// The press selecting, until the button lifts.
    pub(crate) pressing: Option<Press>,
    /// The driver listens (`onSelection`).
    listening: bool,
    /// The driver's `selection` the field was last set from.
    synced: Option<(usize, usize)>,
    /// Selections reported that the driver hasn't echoed back yet, oldest first.
    echoes: VecDeque<(usize, usize)>,
    /// What the driver last heard.
    reported: Option<(usize, usize)>,
}

impl SelectionState {
    /// A new field's state: its driver's selection applied, and nothing to report.
    pub(crate) fn new(field: &mut Field, props: &InputProps) -> Self {
        let mut state = Self {
            listening: props.on_selection,
            ..Self::default()
        };
        if let Some(range) = props.selection {
            field.set_selection_utf16(range.start, range.end);
            state.synced = Some((range.start, range.end));
        }
        state.reported = Some(field.selection_utf16());
        state
    }

    /// A new tree: select the driver's `selection` when it changed (and is
    /// not a late echo) or the buffer was just `reset`, and tell a listening
    /// driver where the selection is when that moved it.
    pub(crate) fn sync(
        &mut self,
        field: &mut Field,
        props: &InputProps,
        reset: bool,
        events: &EventSender,
    ) {
        self.listening = props.on_selection;
        let wanted = props.selection.map(|range| (range.start, range.end));
        let mut moved = reset;
        if let Some((start, end)) = wanted {
            let changed = self.synced != wanted;
            if reset || (changed && driver_resets(&mut self.echoes, &(start, end))) {
                self.echoes.clear();
                field.set_selection_utf16(start, end);
                moved = true;
            }
        }
        self.synced = wanted;
        if moved {
            self.report(&props.id, field, events);
        }
    }

    /// Tell a listening driver where the selection is, when that is news.
    pub(crate) fn report(&mut self, id: &str, field: &Field, events: &EventSender) {
        let now = field.selection_utf16();
        if !self.listening || self.reported == Some(now) {
            return;
        }
        self.reported = Some(now);
        if self.echoes.len() >= MAX_ECHOES {
            self.echoes.pop_front();
        }
        self.echoes.push_back(now);
        events.selection(id, now);
    }

    /// The pointer moved over char `at` (`None`: the field is not drawn
    /// yet), the button `held` or not. A press held selects to there; one
    /// let go of unheard ends. Says whether the selection moved.
    pub(crate) fn pointer_moved(
        &mut self,
        field: &mut Field,
        at: Option<usize>,
        held: bool,
        multiline: bool,
    ) -> bool {
        let Some(press) = self.pressing.as_ref() else {
            return false;
        };
        if !held {
            self.pressing = None;
            return false;
        }
        let before = (field.cursor, field.anchor);
        if let Some(at) = at {
            field.drag(press, at, multiline);
        }
        (field.cursor, field.anchor) != before
    }

    /// The button lifted over char `at`: a press ends, selecting to there
    /// whether or not a move was heard on the way. Says whether the
    /// selection moved.
    pub(crate) fn released(
        &mut self,
        field: &mut Field,
        at: Option<usize>,
        multiline: bool,
    ) -> bool {
        let Some(press) = self.pressing.take() else {
            return false;
        };
        let before = (field.cursor, field.anchor);
        if let Some(at) = at {
            field.drag(&press, at, multiline);
        }
        (field.cursor, field.anchor) != before
    }

    /// The char of `field` under window point `position`, from the field as
    /// last drawn; `None` before it was drawn.
    fn char_at(&self, field: &Field, position: Point<Pixels>) -> Option<usize> {
        let drawn = self.drawn.borrow();
        let drawn: &Drawn = drawn.as_ref()?;
        let at = drawn.char_at(position);
        // A click ends a composition before it arrives (GPUI on Wayland):
        // the composition drawn is text now, before what followed it.
        let committed = match (&drawn.field.preedit, &field.preedit) {
            (Some(composed), None) if at > drawn.field.cursor => composed.chars().count(),
            _ => 0,
        };
        Some(at + committed)
    }
}

impl RootView {
    /// Tell the driver where field `id`'s selection is, if it listens and that is news.
    pub(crate) fn report_selection(&mut self, id: &str) {
        if let Some(state) = self.inputs.get_mut(id) {
            state.selection.report(id, &state.field, &self.events);
        }
    }

    /// A left press in field `id`: place the caret, or select by the press's clicks.
    pub(crate) fn press_field(&mut self, id: &str, event: &MouseDownEvent, props: &PressProps) {
        let Some(state) = self.inputs.get_mut(id) else {
            return;
        };
        let at = state
            .selection
            .char_at(&state.field, event.position)
            .unwrap_or(state.field.cursor);
        let (press, changed) = state.field.press(
            at,
            event.click_count,
            event.modifiers.shift,
            props.multiline,
        );
        state.selection.pressing = Some(press);
        trace_once();
        if changed && props.on_change {
            self.report_change(id);
        }
        self.report_selection(id);
    }

    /// The pointer moved, the button held or not: field `id`'s press, if it
    /// has one, follows it. Says whether its selection moved.
    fn drag_field(
        &mut self,
        id: &str,
        position: Point<Pixels>,
        held: bool,
        multiline: bool,
    ) -> bool {
        let Some(state) = self.inputs.get_mut(id) else {
            return false;
        };
        if state.selection.pressing.is_none() {
            return false;
        }
        let at = state.selection.char_at(&state.field, position);
        let moved = state
            .selection
            .pointer_moved(&mut state.field, at, held, multiline);
        if moved {
            self.report_selection(id);
        }
        moved
    }

    /// The left button lifted: field `id`'s press, if it has one, ends there.
    fn release_field(&mut self, id: &str, position: Point<Pixels>, multiline: bool) -> bool {
        let Some(state) = self.inputs.get_mut(id) else {
            return false;
        };
        if state.selection.pressing.is_none() {
            return false;
        }
        let at = state.selection.char_at(&state.field, position);
        let moved = state.selection.released(&mut state.field, at, multiline);
        if moved {
            self.report_selection(id);
        }
        moved
    }
}

/// What a press in a field is applied with.
pub(crate) struct PressProps {
    pub(crate) multiline: bool,
    pub(crate) on_change: bool,
}

/// Follow the pointer anywhere in the window (and past its edge, where the
/// compositor keeps sending it) for field `id`: while a press in it is
/// held, the selection follows, until the button lifts. Registered while
/// painting every frame the field is drawn in, pressed or not.
pub(crate) fn follow_drag(
    view: WeakEntity<RootView>,
    id: String,
    multiline: bool,
    window: &mut Window,
) {
    let moves = (view.clone(), id.clone());
    window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
        if phase != DispatchPhase::Bubble {
            return;
        }
        let held = event.pressed_button == Some(MouseButton::Left);
        let _ = moves.0.update(cx, |view, cx| {
            if view.drag_field(&moves.1, event.position, held, multiline) {
                cx.notify();
            }
        });
    });
    window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
        if phase != DispatchPhase::Bubble || event.button != MouseButton::Left {
            return;
        }
        let _ = view.update(cx, |view, cx| {
            if view.release_field(&id, event.position, multiline) {
                cx.notify();
            }
        });
    });
}

fn trace_once() {
    thread_local!(static TRACED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
    if !TRACED.with(|traced| traced.replace(true)) {
        crate::trace::log(format_args!(
            "{SELECTION_MARKER}: the pointer selected in a field"
        ));
    }
}
