//! Simulated input for drivers and checks. A driver can send `sim` commands
//! next to trees; they are dispatched into the GPUI window exactly like real
//! input (hit-testing, focus, key handling), so a check exercises the same
//! paths a person does without touching the desktop. The layout query reports
//! the painted bounds of every id'd node so a driver can target nodes by id.

use serde::Deserialize;
use sumi::{
    point, px, App, Entity, FocusHandle, Keystroke, ListState, Modifiers, Pixels, Point,
    ScrollHandle, Window,
};

use crate::edit::FieldEdit;
use crate::events::{EventSender, Modifiers as Held, PointerPhase};
pub(crate) use crate::layout::LayoutMap;
use crate::tree::NodeSpec;
use crate::window::RootView;

/// What a driver may ask the window to simulate.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum SimCommand {
    /// Click the centre of node `id`, or the point (`x`, `y`) in window pixels.
    Click {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        x: Option<f32>,
        #[serde(default)]
        y: Option<f32>,
    },
    /// One keystroke in GPUI's syntax: `enter`, `ctrl-enter`, `shift-tab`, `a`.
    Key { keystroke: String },
    /// Type printable text into whatever has focus.
    Type { text: String },
    /// Report the painted bounds of every id'd node as a `layout` event.
    Layout,
    /// Press node `id` at fraction (`fromX`, `fromY`) of its bounds, move to
    /// (`toX`, `toY`), and release: the `pointer` events a drag produces.
    Drag {
        id: String,
        #[serde(rename = "fromX", default = "half")]
        from_x: f32,
        #[serde(rename = "fromY", default = "half")]
        from_y: f32,
        #[serde(rename = "toX", default = "half")]
        to_x: f32,
        #[serde(rename = "toY", default = "half")]
        to_y: f32,
    },
    /// Right-click the centre of node `id`.
    #[serde(rename = "contextmenu")]
    ContextMenu { id: String },
    /// Pointer enters (`true`) or leaves (`false`) node `id`.
    Hover { id: String, hovered: bool },
    /// Move the pointer to the centre of node `id`, or to the point (`x`,
    /// `y`) in window pixels, as a real pointer move: GPUI's hover styles
    /// (`hoverBackground`) and `onHover` respond to it.
    Move {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        x: Option<f32>,
        #[serde(default)]
        y: Option<f32>,
    },
    /// Window management the user would do with the title bar: `zoom`
    /// toggles maximized, `minimize` minimizes. And what the compositor
    /// would do: `deactivate` makes the window count as not the active one
    /// (another window took the keyboard) and `activate` as active again,
    /// so a check, whose window is otherwise always active, can see how an
    /// inactive one draws. A host that takes those two names
    /// `ACTIVATION_MARKER`.
    Window { action: String },
    /// Scroll the scrollable node `id` down by `dy` pixels (negative scrolls
    /// up) and right by `dx` (negative scrolls left; a virtualized list
    /// scrolls down only), clamped to its content, as a wheel turn over it
    /// would.
    Scroll {
        id: String,
        #[serde(default)]
        dy: f32,
        #[serde(default)]
        dx: f32,
    },
    /// Give the keyboard to field or `focusable` view `id`, pressing nothing
    /// (a screen reader's focus).
    Focus { id: String },
    /// Put `text` in field `id` in place of all it holds, as typing it
    /// would (`edit.rs`): the driver hears a `change`, the caret goes to the
    /// end, and the keyboard stays where it is. An agent's or a screen
    /// reader's `SetTextContents`. A host that takes it names
    /// `FIELD_TEXT_MARKER`.
    SetText { id: String, text: String },
    /// Put `text` in field `id` in place of its selection (at the caret
    /// when nothing is selected), as typing it would.
    InsertText { id: String, text: String },
    /// Select field `id`'s chars from `anchor` to `focus` (the caret): a
    /// screen reader's caret or selection, asked for in the field's text
    /// runs. Never a driver's (its selections are UTF-16, `selection` on
    /// the input).
    #[serde(skip)]
    SelectChars {
        id: String,
        anchor: usize,
        focus: usize,
    },
    /// Answer with a `settled` event once the window has settled: every
    /// tree, patch and simulation sent before this is applied, a frame with
    /// them is drawn, and the window waits for no other (no view is dirty,
    /// no animation asked for a frame). The window's driver handles it
    /// (`drive.rs`); a host that takes it names `SETTLE_MARKER`.
    Settle,
}

fn half() -> f32 {
    0.5
}

/// Named by a host binary that takes the `activate` and `deactivate` window
/// simulations; its `protocol` line says `"activation": true` too.
pub const ACTIVATION_MARKER: &str = "MIRIN_METAL_ACTIVATION";

/// Painted bounds of one id'd node, in window pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutNode {
    pub id: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// What a command resolves to once the view has been consulted. Resolution
/// needs the view (layout, inputs, tree); dispatch must not hold the view,
/// because GPUI re-enters its listeners.
pub(crate) enum SimAction {
    Focus(FocusHandle),
    Press(String),
    Keystrokes(Vec<Keystroke>),
    Layout(Vec<LayoutNode>),
    /// Down/move/up at window coordinates, with the node's bounds.
    Drag(String, LayoutNode, [(f32, f32); 2]),
    ContextMenu(String, f32, f32),
    Hover(String, bool),
    /// A pointer move to window coordinates.
    Move(Point<Pixels>),
    Zoom,
    Minimize,
    /// The window counts as the active one, or as not.
    Activate(bool),
    /// A scroll by (across, down) pixels.
    Scroll(ScrollTarget, (f32, f32)),
    /// A field's text or selection set (`edit.rs`).
    Edit(String, FieldEdit),
}

/// What a simulated scroll moves: a plain scroll view or a virtualized list.
pub(crate) enum ScrollTarget {
    View(ScrollHandle),
    List(ListState),
}

/// Resolve a command against the view. Logs and returns `None` when it cannot
/// be applied (unknown node, bad keystroke).
///
/// Keys go through GPUI's real keystroke dispatch (focus, key listeners, the
/// input editing path). Clicks are resolved against the painted layout and
/// delivered at the handler level: inputs get focus, pressable views get their
/// `press` event. GPUI's mouse dispatch returns a crate-private type, so it
/// cannot be driven from outside; hit-testing is therefore approximated by the
/// recorded bounds (innermost node wins).
pub(crate) fn resolve(command: &SimCommand, view: &RootView) -> Option<SimAction> {
    match command {
        SimCommand::Click { id, x, y } => {
            let target = match (id, x, y) {
                (Some(id), _, _) => Some(id.clone()),
                (None, Some(x), Some(y)) => view.layout.innermost_at(point(px(*x), px(*y))),
                _ => {
                    eprintln!("[mirin-metal] sim click needs an id or x/y");
                    return None;
                }
            };
            let Some(id) = target else {
                eprintln!("[mirin-metal] sim click: nothing painted at that point");
                return None;
            };
            if let Some(state) = view.inputs.get(&id) {
                return Some(SimAction::Focus(state.focus.clone()));
            }
            if pressable(&view.tree, &id) {
                return Some(SimAction::Press(id));
            }
            eprintln!(
                "[mirin-metal] sim click: node {id:?} is not an input or pressable ({})",
                describe(&view.tree, &id)
            );
            None
        }
        SimCommand::Key { keystroke } => match parse_keystroke(keystroke) {
            Ok(keystroke) => Some(SimAction::Keystrokes(vec![keystroke.with_simulated_ime()])),
            Err(error) => {
                eprintln!("[mirin-metal] sim key {keystroke:?}: {error:?}");
                None
            }
        },
        SimCommand::Type { text } => {
            let keystrokes = text
                .chars()
                .map(|ch| {
                    let key = match ch {
                        ' ' => "space".to_string(),
                        '\n' => "enter".to_string(),
                        '\t' => "tab".to_string(),
                        other => other.to_lowercase().to_string(),
                    };
                    let mut keystroke = Keystroke {
                        modifiers: Modifiers {
                            shift: ch.is_uppercase(),
                            ..Modifiers::default()
                        },
                        key,
                        key_char: None,
                    };
                    if !matches!(ch, ' ' | '\n' | '\t') {
                        keystroke.key_char = Some(ch.to_string());
                    }
                    keystroke.with_simulated_ime()
                })
                .collect();
            Some(SimAction::Keystrokes(keystrokes))
        }
        SimCommand::Layout => Some(SimAction::Layout(view.layout.snapshot())),
        SimCommand::Drag {
            id,
            from_x,
            from_y,
            to_x,
            to_y,
        } => {
            let Some(bounds) = view.layout.node(id) else {
                eprintln!("[mirin-metal] sim drag: no painted node with id {id:?}");
                return None;
            };
            let at =
                |fx: f32, fy: f32| (bounds.x + bounds.width * fx, bounds.y + bounds.height * fy);
            let points = [at(*from_x, *from_y), at(*to_x, *to_y)];
            Some(SimAction::Drag(id.clone(), bounds, points))
        }
        SimCommand::ContextMenu { id } => {
            let Some(bounds) = view.layout.node(id) else {
                eprintln!("[mirin-metal] sim contextmenu: no painted node with id {id:?}");
                return None;
            };
            Some(SimAction::ContextMenu(
                id.clone(),
                bounds.x + bounds.width / 2.0,
                bounds.y + bounds.height / 2.0,
            ))
        }
        SimCommand::Hover { id, hovered } => Some(SimAction::Hover(id.clone(), *hovered)),
        SimCommand::Move { id, x, y } => match (id, x, y) {
            (Some(id), _, _) => {
                let Some(bounds) = view.layout.node(id) else {
                    eprintln!("[mirin-metal] sim move: no painted node with id {id:?}");
                    return None;
                };
                Some(SimAction::Move(point(
                    px(bounds.x + bounds.width / 2.0),
                    px(bounds.y + bounds.height / 2.0),
                )))
            }
            (None, Some(x), Some(y)) => Some(SimAction::Move(point(px(*x), px(*y)))),
            _ => {
                eprintln!("[mirin-metal] sim move needs an id or x/y");
                None
            }
        },
        SimCommand::Focus { id } => {
            let handle = match view.inputs.get(id) {
                Some(state) => Some(&state.focus),
                None => view.focus.handle(id),
            };
            let Some(handle) = handle else {
                eprintln!("[mirin-metal] sim focus: no field or focusable view with id {id:?}");
                return None;
            };
            Some(SimAction::Focus(handle.clone()))
        }
        SimCommand::Scroll { id, dy, dx } => {
            if let Some(list) = view.lists.get(id) {
                return Some(SimAction::Scroll(
                    ScrollTarget::List(list.state.clone()),
                    (0.0, *dy),
                ));
            }
            let Some(handle) = view.scrolls.get(id) else {
                eprintln!("[mirin-metal] sim scroll: no scrollable node with id {id:?}");
                return None;
            };
            Some(SimAction::Scroll(
                ScrollTarget::View(handle.clone()),
                (*dx, *dy),
            ))
        }
        SimCommand::SetText { id, text } => edit(view, id, FieldEdit::Set(text.clone())),
        SimCommand::InsertText { id, text } => edit(view, id, FieldEdit::Insert(text.clone())),
        SimCommand::SelectChars { id, anchor, focus } => {
            edit(view, id, FieldEdit::Select(*anchor, *focus))
        }
        // Never performed: the window's driver waits it out (`drive.rs`).
        SimCommand::Settle => None,
        SimCommand::Window { action } => match action.as_str() {
            "zoom" => Some(SimAction::Zoom),
            "minimize" => Some(SimAction::Minimize),
            "activate" => Some(SimAction::Activate(true)),
            "deactivate" => Some(SimAction::Activate(false)),
            other => {
                eprintln!("[mirin-metal] sim window: unknown action {other:?}");
                None
            }
        },
    }
}

/// An edit of field `id`, when there is one.
fn edit(view: &RootView, id: &str, edit: FieldEdit) -> Option<SimAction> {
    if !view.inputs.contains_key(id) {
        eprintln!("[mirin-metal] sim edit: no field with id {id:?}");
        return None;
    }
    Some(SimAction::Edit(id.to_owned(), edit))
}

/// Dispatch a resolved action with the window leased but not the view;
/// `root` is the view, for what changes it (an edit).
pub(crate) fn perform(
    action: SimAction,
    events: &EventSender,
    root: Option<&Entity<RootView>>,
    window: &mut Window,
    cx: &mut App,
) {
    match action {
        SimAction::Edit(id, edit) => {
            if let Some(root) = root {
                root.update(cx, |view, cx| view.edit_field(&id, edit, cx));
            }
        }
        SimAction::Focus(handle) => window.focus(&handle, cx),
        SimAction::Press(id) => events.press(&id, Held::default()),
        SimAction::Keystrokes(keystrokes) => {
            for keystroke in keystrokes {
                window.dispatch_keystroke(keystroke, cx);
            }
        }
        SimAction::Layout(nodes) => events.layout(nodes),
        SimAction::Drag(id, bounds, [(x0, y0), (x1, y1)]) => {
            let none = Held::default();
            events.pointer(&id, PointerPhase::Down, x0, y0, Some(bounds.clone()), none);
            events.pointer(&id, PointerPhase::Move, x1, y1, Some(bounds.clone()), none);
            events.pointer(&id, PointerPhase::Up, x1, y1, Some(bounds), none);
        }
        SimAction::ContextMenu(id, x, y) => events.context_menu(&id, x, y, Held::default()),
        SimAction::Hover(id, hovered) => events.hover(&id, hovered),
        SimAction::Move(position) => {
            let _ = window.dispatch_event(
                sumi::PlatformInput::MouseMove(sumi::MouseMoveEvent {
                    position,
                    pressed_button: None,
                    modifiers: Modifiers::default(),
                }),
                cx,
            );
        }
        SimAction::Zoom => {
            crate::trace::log(format_args!("zoom requested"));
            window.zoom_window();
        }
        SimAction::Minimize => window.minimize_window(),
        SimAction::Activate(active) => window.simulate_active_status(active, cx),
        SimAction::Scroll(ScrollTarget::View(handle), (dx, dy)) => {
            // GPUI offsets are negative once scrolled: content moves up.
            let offset = handle.offset();
            let max = handle.max_offset();
            let x = (offset.x - px(dx)).clamp(-max.x, px(0.0));
            let y = (offset.y - px(dy)).clamp(-max.y, px(0.0));
            handle.set_offset(point(x, y));
            window.refresh();
        }
        SimAction::Scroll(ScrollTarget::List(state), (_, dy)) => {
            state.scroll_by(px(dy));
            window.refresh();
        }
    }
}

/// Debug description of the node with `id`, for the log line above.
fn describe(node: &NodeSpec, id: &str) -> String {
    match node {
        NodeSpec::View { props, children } => {
            if props.id.as_deref() == Some(id) {
                return format!(
                    "view onPress={} children={} first_text={:?}",
                    props.on_press,
                    children.len(),
                    children.iter().find_map(|child| match child {
                        NodeSpec::Text { children, .. } => Some(children.concat()),
                        _ => None,
                    })
                );
            }
            children
                .iter()
                .map(|child| describe(child, id))
                .find(|text| text != "absent")
                .unwrap_or_else(|| "absent".to_string())
        }
        NodeSpec::Text { .. } | NodeSpec::Svg { .. } | NodeSpec::Image { .. } => {
            "absent".to_string()
        }
        NodeSpec::Input { props } => {
            if props.id == id {
                "input".to_string()
            } else {
                "absent".to_string()
            }
        }
    }
}

/// Whether the node with `id` is a view with `onPress`.
fn pressable(node: &NodeSpec, id: &str) -> bool {
    match node {
        NodeSpec::View { props, children } => {
            (props.id.as_deref() == Some(id) && props.on_press)
                || children.iter().any(|child| pressable(child, id))
        }
        NodeSpec::Text { .. }
        | NodeSpec::Input { .. }
        | NodeSpec::Svg { .. }
        | NodeSpec::Image { .. } => false,
    }
}

/// A keystroke from its text (`"cmd-a"`), as the host's platform names its
/// keys (the engine's `Keystroke::parse` takes only a `&'static str`).
fn parse_keystroke(source: &str) -> Result<sumi::Keystroke, impl std::fmt::Debug> {
    let os = if cfg!(target_os = "macos") {
        sumi::OperatingSystem::Mac
    } else if cfg!(target_os = "windows") {
        sumi::OperatingSystem::Windows
    } else {
        sumi::OperatingSystem::Linux
    };
    sumi::Keystroke::parse_with_os(source, os)
}

#[cfg(test)]
mod command_tests {
    use super::SimCommand;

    #[test]
    fn a_window_is_made_inactive_and_active_by_name() {
        for action in ["deactivate", "activate"] {
            let command: SimCommand =
                serde_json::from_str(&format!(r#"{{"kind":"window","action":"{action}"}}"#))
                    .unwrap();
            assert_eq!(
                command,
                SimCommand::Window {
                    action: action.into()
                }
            );
        }
    }

    #[test]
    fn a_focus_names_its_element() {
        let command: SimCommand = serde_json::from_str(r#"{"kind":"focus","id":"save"}"#).unwrap();
        assert_eq!(command, SimCommand::Focus { id: "save".into() });
    }

    #[test]
    fn a_field_is_set_or_inserted_into_by_name_but_never_selected_in_chars() {
        let set: SimCommand =
            serde_json::from_str(r#"{"kind":"settext","id":"name","text":"Alex"}"#).unwrap();
        assert_eq!(
            set,
            SimCommand::SetText {
                id: "name".into(),
                text: "Alex".into()
            }
        );
        let insert: SimCommand =
            serde_json::from_str(r#"{"kind":"inserttext","id":"name","text":" Kim"}"#).unwrap();
        assert!(matches!(insert, SimCommand::InsertText { .. }));
        let chars = r#"{"kind":"selectchars","id":"name","anchor":0,"focus":1}"#;
        assert!(serde_json::from_str::<SimCommand>(chars).is_err());
    }

    #[test]
    fn a_settle_is_a_command_of_its_own() {
        let command: SimCommand = serde_json::from_str(r#"{"kind":"settle"}"#).unwrap();
        assert_eq!(command, SimCommand::Settle);
    }
}
