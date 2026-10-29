//! Simulated input for drivers and checks. A driver can send `sim` commands
//! next to trees; they are dispatched into the GPUI window exactly like real
//! input (hit-testing, focus, key handling), so a check exercises the same
//! paths a person does without touching the desktop. The layout query reports
//! the painted bounds of every id'd node so a driver can target nodes by id.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{point, px, App, Bounds, FocusHandle, Keystroke, Modifiers, Pixels, Point, Window};
use serde::Deserialize;

use crate::events::{EventSender, PointerPhase};
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
}

fn half() -> f32 {
    0.5
}

/// Painted bounds of one id'd node, in window pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutNode {
    pub id: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Bounds recorded during the last paint, keyed by node id.
#[derive(Clone, Default)]
pub(crate) struct LayoutMap(Rc<RefCell<HashMap<String, Bounds<Pixels>>>>);

impl LayoutMap {
    pub(crate) fn record(&self, id: &str, bounds: Bounds<Pixels>) {
        self.0.borrow_mut().insert(id.to_string(), bounds);
    }

    /// The smallest painted node containing `point`.
    pub(crate) fn innermost_at(&self, point: Point<Pixels>) -> Option<String> {
        self.0
            .borrow()
            .iter()
            .filter(|(_, bounds)| bounds.contains(&point))
            .min_by(|(_, a), (_, b)| {
                let area = |b: &Bounds<Pixels>| f32::from(b.size.width) * f32::from(b.size.height);
                area(a).total_cmp(&area(b))
            })
            .map(|(id, _)| id.clone())
    }

    /// Painted bounds of one node.
    pub(crate) fn node(&self, id: &str) -> Option<LayoutNode> {
        self.0.borrow().get(id).map(|bounds| LayoutNode {
            id: id.to_string(),
            x: f32::from(bounds.origin.x),
            y: f32::from(bounds.origin.y),
            width: f32::from(bounds.size.width),
            height: f32::from(bounds.size.height),
        })
    }

    pub(crate) fn snapshot(&self) -> Vec<LayoutNode> {
        let mut nodes: Vec<LayoutNode> = self
            .0
            .borrow()
            .iter()
            .map(|(id, bounds)| LayoutNode {
                id: id.clone(),
                x: f32::from(bounds.origin.x),
                y: f32::from(bounds.origin.y),
                width: f32::from(bounds.size.width),
                height: f32::from(bounds.size.height),
            })
            .collect();
        nodes.sort_by(|a, b| a.id.cmp(&b.id));
        nodes
    }
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
        SimCommand::Key { keystroke } => match Keystroke::parse(keystroke) {
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
    }
}

/// Dispatch a resolved action with the window leased but not the view.
pub(crate) fn perform(action: SimAction, events: &EventSender, window: &mut Window, cx: &mut App) {
    match action {
        SimAction::Focus(handle) => window.focus(&handle),
        SimAction::Press(id) => events.press(&id),
        SimAction::Keystrokes(keystrokes) => {
            for keystroke in keystrokes {
                window.dispatch_keystroke(keystroke, cx);
            }
        }
        SimAction::Layout(nodes) => events.layout(nodes),
        SimAction::Drag(id, bounds, [(x0, y0), (x1, y1)]) => {
            events.pointer(&id, PointerPhase::Down, x0, y0, Some(bounds.clone()));
            events.pointer(&id, PointerPhase::Move, x1, y1, Some(bounds.clone()));
            events.pointer(&id, PointerPhase::Up, x1, y1, Some(bounds));
        }
        SimAction::ContextMenu(id, x, y) => events.context_menu(&id, x, y),
        SimAction::Hover(id, hovered) => events.hover(&id, hovered),
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
