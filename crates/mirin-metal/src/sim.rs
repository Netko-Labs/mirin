//! Simulated input for drivers and checks. A driver can send `sim` commands
//! next to trees; they are dispatched into the GPUI window exactly like real
//! input (hit-testing, focus, key handling), so a check exercises the same
//! paths a person does without touching the desktop. The layout query reports
//! the painted bounds of every id'd node so a driver can target nodes by id.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{
    point, px, App, Bounds, FocusHandle, Keystroke, ListState, Modifiers, Pixels, Point,
    ScrollHandle, Window,
};
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
    /// Window management the user would do with the title bar: `zoom`
    /// toggles maximized, `minimize` minimizes.
    Window { action: String },
    /// Scroll the scrollable node `id` down by `dy` pixels (negative scrolls
    /// up), clamped to its content, as a wheel turn over it would.
    Scroll { id: String, dy: f32 },
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

/// Bounds recorded during the last paint, keyed by node id. Entries carry the
/// frame that painted them; lookups only see the latest frame, so nodes that
/// left the tree or scrolled out of a virtualized list are not reported at
/// stale positions.
#[derive(Clone, Default)]
pub(crate) struct LayoutMap(Rc<RefCell<LayoutState>>);

#[derive(Default)]
pub(crate) struct LayoutState {
    frame: u64,
    nodes: HashMap<String, (Bounds<Pixels>, u64)>,
}

impl LayoutMap {
    /// Start a frame: forget nodes the previous frame did not paint.
    pub(crate) fn begin_frame(&self) {
        let mut state = self.0.borrow_mut();
        state.frame += 1;
        let previous = state.frame - 1;
        state.nodes.retain(|_, (_, frame)| *frame >= previous);
    }

    /// Record a node's bounds; returns whether they changed since it was last
    /// painted (or it is newly painted).
    pub(crate) fn record(&self, id: &str, bounds: Bounds<Pixels>) -> bool {
        let mut state = self.0.borrow_mut();
        let frame = state.frame;
        match state.nodes.get_mut(id) {
            Some(entry) => {
                let changed = entry.0 != bounds;
                *entry = (bounds, frame);
                changed
            }
            None => {
                state.nodes.insert(id.to_string(), (bounds, frame));
                true
            }
        }
    }

    /// Bounds painted in the latest frame.
    fn painted(&self) -> Vec<(String, Bounds<Pixels>)> {
        let state = self.0.borrow();
        state
            .nodes
            .iter()
            .filter(|(_, (_, frame))| *frame == state.frame)
            .map(|(id, (bounds, _))| (id.clone(), *bounds))
            .collect()
    }

    /// The smallest painted node containing `point`.
    pub(crate) fn innermost_at(&self, point: Point<Pixels>) -> Option<String> {
        self.painted()
            .into_iter()
            .filter(|(_, bounds)| bounds.contains(&point))
            .min_by(|(_, a), (_, b)| {
                let area = |b: &Bounds<Pixels>| f32::from(b.size.width) * f32::from(b.size.height);
                area(a).total_cmp(&area(b))
            })
            .map(|(id, _)| id)
    }

    /// Painted bounds of one node.
    pub(crate) fn node(&self, id: &str) -> Option<LayoutNode> {
        let state = self.0.borrow();
        state
            .nodes
            .get(id)
            .filter(|(_, frame)| *frame == state.frame)
            .map(|(bounds, _)| layout_node(id.to_string(), *bounds))
    }

    pub(crate) fn snapshot(&self) -> Vec<LayoutNode> {
        let mut nodes: Vec<LayoutNode> = self
            .painted()
            .into_iter()
            .map(|(id, bounds)| layout_node(id, bounds))
            .collect();
        nodes.sort_by(|a, b| a.id.cmp(&b.id));
        nodes
    }
}

fn layout_node(id: String, bounds: Bounds<Pixels>) -> LayoutNode {
    LayoutNode {
        id,
        x: f32::from(bounds.origin.x),
        y: f32::from(bounds.origin.y),
        width: f32::from(bounds.size.width),
        height: f32::from(bounds.size.height),
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
    Zoom,
    Minimize,
    Scroll(ScrollTarget, f32),
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
        SimCommand::Scroll { id, dy } => {
            if let Some(list) = view.lists.get(id) {
                return Some(SimAction::Scroll(
                    ScrollTarget::List(list.state.clone()),
                    *dy,
                ));
            }
            let Some(handle) = view.scrolls.get(id) else {
                eprintln!("[mirin-metal] sim scroll: no scrollable node with id {id:?}");
                return None;
            };
            Some(SimAction::Scroll(ScrollTarget::View(handle.clone()), *dy))
        }
        SimCommand::Window { action } => match action.as_str() {
            "zoom" => Some(SimAction::Zoom),
            "minimize" => Some(SimAction::Minimize),
            other => {
                eprintln!("[mirin-metal] sim window: unknown action {other:?}");
                None
            }
        },
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
        SimAction::Zoom => {
            crate::trace::log(format_args!("zoom requested"));
            window.zoom_window();
        }
        SimAction::Minimize => window.minimize_window(),
        SimAction::Scroll(ScrollTarget::View(handle), dy) => {
            // GPUI offsets are negative once scrolled: content moves up.
            let offset = handle.offset();
            let max = handle.max_offset();
            let y = (offset.y - px(dy)).clamp(-max.height, px(0.0));
            handle.set_offset(point(offset.x, y));
            window.refresh();
        }
        SimAction::Scroll(ScrollTarget::List(state), dy) => {
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
