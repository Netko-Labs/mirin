//! The keyboard's focus in a window (docs/metal.md, "Focus"). Fields and
//! `focusable` views take it in document order with Tab and Shift+Tab
//! (`order.rs` says where it goes), the arrows move it inside a
//! `focusGroup`, and Space or Enter press the focused view as the key goes
//! down. A ring shows on the focused
//! view only after the keyboard moved focus there, as CSS `:focus-visible`
//! does; a press with the pointer hides it and gives the keyboard back to
//! the window.
//!
//! The window itself takes the keyboard (`root`) when no field, key-taking
//! view, or focusable view has it, so keys still arrive: the ones nobody
//! takes go to the last `onWindowKey` view as `windowkey` (Dashi's
//! KeySink). A pointer press never moves focus by itself: GPUI's automatic
//! focus on mouse down is turned off (`pointer.rs`), and fields and
//! key-taking views focus themselves when pressed.

mod order;

use std::collections::HashMap;

use gpui::{
    div, prelude::*, px, rgba, AnyElement, App, Context, Div, FocusHandle, KeyDownEvent, Stateful,
    Window,
};

use crate::events::{KeyDown, Modifiers};
use crate::tree::{NodeSpec, ViewProps};
use crate::window::RootView;

pub(crate) use order::Order;

/// Named by a host binary that has the focus model, press modifiers, and the
/// visibility event: a driver checks for it before it sends `focusable`,
/// `focusGroup`, `focusTrap`, `focusRingColor`, or `onWindowKey` (an older
/// host refuses a tree with them).
pub const FOCUS_MARKER: &str = "MIRIN_METAL_FOCUS";

/// The ring (design rule KB-2 in Dashi): 2 px wide, 2 px out from the view.
pub(crate) const RING_WIDTH: f32 = 2.0;
pub(crate) const RING_OFFSET: f32 = 2.0;

/// Renderer-owned focus state.
pub(crate) struct FocusState {
    pub(crate) order: Order,
    /// Focus handles of `focusable` views, by id (fields keep theirs in `InputState`).
    handles: HashMap<String, FocusHandle>,
    /// The window itself: it has the keyboard when no control does.
    pub(crate) root: FocusHandle,
    /// The keyboard moved focus last, so the ring shows (`:focus-visible`).
    pub(crate) visible: bool,
    /// The member of each group that last had the keyboard, where Tab enters it again.
    last: HashMap<String, String>,
    /// An `onWindowKey` view or a trap appeared: the keyboard goes back to the window.
    wants_root: bool,
    /// What the driver was last told: a field has the keyboard (`typing`).
    typing: Reported,
}

/// A yes-or-no the driver hears only when it changes; it starts at no.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Reported(bool);

impl Reported {
    /// `now`, when the driver hasn't heard it yet.
    pub(crate) fn change(&mut self, now: bool) -> Option<bool> {
        (self.0 != now).then(|| {
            self.0 = now;
            now
        })
    }
}

impl FocusState {
    pub(crate) fn new(cx: &mut App) -> Self {
        Self {
            order: Order::default(),
            handles: HashMap::new(),
            root: cx.focus_handle(),
            visible: false,
            last: HashMap::new(),
            wants_root: false,
            typing: Reported::default(),
        }
    }

    /// Follow a new tree: handles for new focusable views, none for gone ones.
    pub(crate) fn sync(&mut self, tree: &NodeSpec, cx: &mut App) {
        let order = Order::of(tree);
        let appeared = |old: &[String], new: &[String]| new.iter().any(|id| !old.contains(id));
        if appeared(&self.order.window_keys, &order.window_keys)
            || appeared(&self.order.traps, &order.traps)
        {
            self.wants_root = true;
        }
        for stop in order.stops.iter().filter(|stop| !stop.field) {
            self.handles
                .entry(stop.id.clone())
                .or_insert_with(|| cx.focus_handle());
        }
        self.handles
            .retain(|id, _| order.stop(id).is_some_and(|stop| !stop.field));
        self.order = order;
    }

    /// The focusable view with the keyboard.
    pub(crate) fn focused_view(&self, window: &Window) -> Option<&str> {
        self.handles
            .iter()
            .find(|(_, handle)| handle.is_focused(window))
            .map(|(id, _)| id.as_str())
    }

    /// The ring's color when `id` is to show one now.
    fn ring_on(&self, id: &str, window: &Window) -> Option<u32> {
        if !self.visible || !self.handles.get(id)?.is_focused(window) {
            return None;
        }
        self.order.stop(id).map(|stop| stop.ring)
    }
}

/// A `focusable` view: it can take the keyboard, and draws the ring when it
/// has it after the keyboard moved there.
pub(crate) fn track(
    mut element: Stateful<Div>,
    id: &str,
    props: &ViewProps,
    view: &RootView,
    window: &Window,
) -> Stateful<Div> {
    let Some(handle) = view.focus.handles.get(id) else {
        return element;
    };
    element = element.track_focus(handle);
    if let Some(color) = view.focus.ring_on(id, window) {
        let out = RING_OFFSET + RING_WIDTH;
        element = element.child(
            div()
                .absolute()
                .top(px(-out))
                .left(px(-out))
                .right(px(-out))
                .bottom(px(-out))
                .border_2()
                .border_color(rgba(color))
                .rounded(px(props.corner_radius + out)),
        );
    }
    element
}

/// The outermost element: it holds the window's own focus and hears every
/// key no field or key-taking view stopped.
pub(crate) fn key_root(
    content: AnyElement,
    view: &RootView,
    cx: &mut Context<RootView>,
) -> AnyElement {
    div()
        .id("mirin-focus")
        .size_full()
        .track_focus(&view.focus.root)
        .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
            view.window_key_down(event, window, cx);
        }))
        .child(content)
        .into_any_element()
}

impl RootView {
    /// Give the keyboard to a field or a focusable view, from the keyboard (the ring shows).
    pub(crate) fn focus_stop(&mut self, id: &str, window: &mut Window) {
        let handle = match self.inputs.get(id) {
            Some(state) => state.focus.clone(),
            None => match self.focus.handles.get(id) {
                Some(handle) => handle.clone(),
                None => return,
            },
        };
        if let Some(group) = self
            .focus
            .order
            .stop(id)
            .and_then(|stop| stop.group.clone())
        {
            self.focus.last.insert(group, id.to_owned());
        }
        self.focus.visible = true;
        window.focus(&handle);
    }

    /// Tab (or Shift+Tab, `back`) from `from`, a field or a view; none: the window.
    pub(crate) fn tab_from(&mut self, from: Option<&str>, back: bool, window: &mut Window) {
        if let Some(id) = self.focus.order.tab(from, back, &self.focus.last) {
            self.focus_stop(&id, window);
        }
    }

    /// A pointer press: the ring goes, and a focused view gives the keyboard
    /// back to the window (a field keeps it; one pressed takes it itself).
    pub(crate) fn pointer_pressed(&mut self, window: &mut Window) {
        self.focus.visible = false;
        if self.focus.focused_view(window).is_some() {
            window.focus(&self.focus.root);
        }
    }

    /// A field or a key-taking view has the keyboard: its keys are its own.
    fn text_focused(&self, window: &Window) -> bool {
        self.inputs
            .values()
            .any(|state| state.focus.is_focused(window))
            || self
                .key_targets
                .values()
                .any(|target| target.focus.is_focused(window))
    }

    /// Tell the driver when a text field takes the keyboard or the last one
    /// lets it go (`typing`), so its menus' text keys can go to the field.
    /// A key-taking view (a terminal's grid) is not typing: its keys are raw.
    pub(crate) fn report_typing(&mut self, window: &Window) {
        let now = self
            .inputs
            .values()
            .any(|state| state.focus.is_focused(window));
        if let Some(typing) = self.focus.typing.change(now) {
            self.events.typing(typing);
        }
    }

    /// Before a new tree's autofocus: an `onWindowKey` view or a trap
    /// appeared, so the keyboard goes back to the window (a field that asks
    /// for it takes it after).
    pub(crate) fn focus_window_if_asked(&mut self, window: &mut Window) {
        if std::mem::take(&mut self.focus.wants_root) {
            window.focus(&self.focus.root);
        }
    }

    /// After a new tree's autofocus: what had the keyboard went away, or is
    /// behind the trap now, so the window takes it.
    pub(crate) fn settle_focus(&mut self, window: &mut Window) {
        let lost = match self.focus.focused_view(window) {
            Some(id) => !self.focus.order.reachable(id),
            None => !self.text_focused(window),
        };
        if lost {
            window.focus(&self.focus.root);
        }
    }

    /// A key that reached the window: Tab and the arrows move focus, Space
    /// and Enter are the focused view's, and the rest go to `onWindowKey`.
    fn window_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A field's or a key-taking view's keys are its own, taken or not.
        if self.text_focused(window) {
            return;
        }
        let keystroke = &event.keystroke;
        let held = keystroke.modifiers;
        let plain = !held.control && !held.alt && !held.platform && !held.function;
        let focused = self.focus.focused_view(window).map(str::to_owned);
        let key = keystroke.key.as_str();
        match key {
            "tab" if plain => {
                self.tab_from(focused.as_deref(), held.shift, window);
                cx.stop_propagation();
                cx.notify();
                return;
            }
            "left" | "up" | "right" | "down" if plain && !held.shift => {
                let group = focused
                    .as_deref()
                    .and_then(|id| self.focus.order.stop(id))
                    .and_then(|stop| stop.group.clone());
                if let (Some(from), Some(group)) = (focused.as_deref(), group) {
                    let step = if matches!(key, "left" | "up") { -1 } else { 1 };
                    if let Some(to) = self.focus.order.arrow(from, step) {
                        self.focus_stop(&to, window);
                        if self.focus.order.selects(&group) {
                            self.events.press(&to, Modifiers::default());
                        }
                    }
                    cx.stop_propagation();
                    cx.notify();
                    return;
                }
            }
            // The focused view's: pressed once as the key goes down, not again while it repeats.
            "enter" | "space" if plain && !held.shift => {
                if let Some(id) = focused.as_deref() {
                    if !event.is_held {
                        self.events.press(id, Modifiers::default());
                    }
                    cx.stop_propagation();
                    return;
                }
            }
            _ => {}
        }
        let Some(target) = self.focus.order.window_key().map(str::to_owned) else {
            return;
        };
        let paste = held.control && !held.alt && !held.platform && key == "v";
        let pasted = paste
            .then(|| cx.read_from_clipboard().and_then(|item| item.text()))
            .flatten();
        self.events.window_key(
            &target,
            KeyDown {
                key: keystroke.key.clone(),
                text: keystroke.key_char.clone(),
                ctrl: held.control,
                alt: held.alt,
                shift: held.shift,
                platform: held.platform,
                repeat: event.is_held,
            },
            pasted,
        );
        cx.stop_propagation();
    }
}

#[cfg(test)]
mod tests {
    use super::Reported;

    #[test]
    fn typing_is_reported_only_when_it_changes() {
        let mut typing = Reported::default();
        // A window opens with no field typing: nothing to say.
        assert_eq!(typing.change(false), None);
        assert_eq!(typing.change(true), Some(true));
        // Another field taking the keyboard is still typing.
        assert_eq!(typing.change(true), None);
        assert_eq!(typing.change(false), Some(false));
        assert_eq!(typing.change(false), None);
    }
}
