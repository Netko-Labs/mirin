//! Simulated input for drivers and checks. A driver can send `sim` commands
//! next to trees; they are dispatched into the GPUI window exactly like real
//! input (hit-testing, focus, key handling), so a check exercises the same
//! paths a person does without touching the desktop. The layout query reports
//! the painted bounds of every id'd node so a driver can target nodes by id.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{point, px, App, Bounds, Keystroke, Modifiers, Pixels, Point, Window};
use serde::Deserialize;

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

    pub(crate) fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.0.borrow().get(id).copied()
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

/// Dispatch a command into the window. Returns `false` when it could not be
/// applied (unknown node, bad keystroke), after logging why.
///
/// Keys go through GPUI's real keystroke dispatch (focus, key listeners, the
/// input editing path). Clicks are resolved against the painted layout and
/// delivered at the handler level: inputs get focus, pressable views get their
/// `press` event. GPUI's mouse dispatch returns a crate-private type, so it
/// cannot be driven from outside; hit-testing is therefore approximated by the
/// recorded bounds (innermost node wins).
pub(crate) fn apply(
    command: &SimCommand,
    view: &mut RootView,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    match command {
        SimCommand::Click { id, x, y } => {
            let target = match (id, x, y) {
                (Some(id), _, _) => Some(id.clone()),
                (None, Some(x), Some(y)) => view.layout.innermost_at(point(px(*x), px(*y))),
                _ => {
                    eprintln!("[mirin-metal] sim click needs an id or x/y");
                    return false;
                }
            };
            let Some(id) = target else {
                eprintln!("[mirin-metal] sim click: nothing painted at that point");
                return false;
            };
            if let Some(state) = view.inputs.get(&id) {
                window.focus(&state.focus);
                return true;
            }
            if pressable(&view.tree, &id) {
                view.events.press(&id);
                return true;
            }
            eprintln!("[mirin-metal] sim click: node {id:?} is not an input or pressable");
            false
        }
        SimCommand::Key { keystroke } => match Keystroke::parse(keystroke) {
            Ok(keystroke) => {
                window.dispatch_keystroke(keystroke.with_simulated_ime(), cx);
                true
            }
            Err(error) => {
                eprintln!("[mirin-metal] sim key {keystroke:?}: {error:?}");
                false
            }
        },
        SimCommand::Type { text } => {
            for ch in text.chars() {
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
                window.dispatch_keystroke(keystroke.with_simulated_ime(), cx);
            }
            true
        }
        SimCommand::Layout => true,
    }
}

/// Whether the node with `id` is a view with `onPress`.
fn pressable(node: &NodeSpec, id: &str) -> bool {
    match node {
        NodeSpec::View { props, children } => {
            (props.id.as_deref() == Some(id) && props.on_press)
                || children.iter().any(|child| pressable(child, id))
        }
        NodeSpec::Text { .. } | NodeSpec::Input { .. } => false,
    }
}
