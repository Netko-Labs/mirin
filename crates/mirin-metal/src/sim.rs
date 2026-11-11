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

use crate::events::{EventSender, Modifiers as Held, PointerPhase};
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
    /// toggles maximized, `minimize` minimizes.
    Window { action: String },
    /// Scroll the scrollable node `id` down by `dy` pixels (negative scrolls
    /// up), clamped to its content, as a wheel turn over it would.
    Scroll { id: String, dy: f32 },
    /// Give the keyboard to field or `focusable` view `id`, pressing nothing
    /// (a screen reader's focus).
    Focus { id: String },
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
    nodes: HashMap<String, Entry>,
    /// Retained subtrees (`retain.rs`), by group id: a node recorded inside
    /// one stays painted while the subtree's last drawing is reused, though
    /// nothing records it again.
    groups: HashMap<u64, Group>,
    /// Bumped whenever a node's bounds change, one is painted anew, or one
    /// is forgotten: what the accessibility tree checks before rebuilding.
    revision: u64,
}

struct Entry {
    bounds: Bounds<Pixels>,
    /// The frame that last recorded it.
    frame: u64,
    /// The retained subtree it was recorded in, if any.
    group: Option<u64>,
}

/// A retained subtree's frames, and where it sits. Its nodes are recorded
/// when it is drawn anew; when its drawing is copied elsewhere, or left out
/// (nothing of it shows), they are where they were recorded plus how far it
/// has moved since.
#[derive(Clone, Copy)]
struct Group {
    /// The retained subtree around it when it was last drawn.
    parent: Option<u64>,
    /// The last frame it was visited in (drawn anew, copied, or left out).
    touched: u64,
    /// The last frame it was drawn anew (its nodes recorded).
    built: u64,
    /// Its top left when it was last visited, and when it was last drawn anew.
    origin: Point<Pixels>,
    built_origin: Point<Pixels>,
    /// Where the subtree around it was when this one was last visited: this
    /// one has moved with it since, if it was not visited again.
    parent_origin: Point<Pixels>,
}

/// How often grouped entries no longer painted are dropped (they are never
/// reported meanwhile).
const PRUNE_EVERY: u64 = 64;

impl LayoutState {
    /// Whether retained subtree `group` was drawn in `frame`: drawn itself,
    /// or inside one that reused a drawing it was part of.
    fn group_live(&self, group: u64, frame: u64) -> bool {
        let Some(info) = self.groups.get(&group) else {
            return false;
        };
        if info.touched == frame {
            return true;
        }
        info.parent.is_some_and(|parent| {
            self.groups
                .get(&parent)
                .is_some_and(|outer| info.touched >= outer.built)
                && self.group_live(parent, frame)
        })
    }

    /// Where retained subtree `group` sits now: where it was last visited,
    /// moved along with the subtrees around it that were copied since.
    fn origin(&self, group: u64) -> Option<Point<Pixels>> {
        let info = self.groups.get(&group)?;
        if info.touched == self.frame {
            return Some(info.origin);
        }
        let carried = info
            .parent
            .and_then(|parent| self.origin(parent))
            .map(|parent| parent - info.parent_origin);
        Some(match carried {
            Some(carried) => info.origin + carried,
            None => info.origin,
        })
    }

    /// The bounds of `entry` now: as recorded, moved with its subtree.
    fn bounds_of(&self, entry: &Entry) -> Bounds<Pixels> {
        let moved = entry.group.and_then(|group| {
            let built = self.groups.get(&group)?.built_origin;
            Some(self.origin(group)? - built)
        });
        match moved {
            Some(moved) if moved != Point::default() => Bounds {
                origin: entry.bounds.origin + moved,
                size: entry.bounds.size,
            },
            _ => entry.bounds,
        }
    }

    /// Whether `entry` was painted in `frame`.
    fn painted_in(&self, entry: &Entry, frame: u64) -> bool {
        entry.frame == frame
            || entry.group.is_some_and(|group| {
                self.groups
                    .get(&group)
                    .is_some_and(|info| entry.frame >= info.built)
                    && self.group_live(group, frame)
            })
    }
}

impl LayoutMap {
    /// Start a frame: forget nodes the previous frame did not paint.
    pub(crate) fn begin_frame(&self) {
        let mut state = self.0.borrow_mut();
        state.frame += 1;
        let previous = state.frame - 1;
        let before = state.nodes.len();
        if state.frame.is_multiple_of(PRUNE_EVERY) {
            let dead: Vec<String> = state
                .nodes
                .iter()
                .filter(|(_, entry)| !state.painted_in(entry, previous))
                .map(|(id, _)| id.clone())
                .collect();
            for id in dead {
                state.nodes.remove(&id);
            }
            let dead: Vec<u64> = state
                .groups
                .keys()
                .copied()
                .filter(|group| !state.group_live(*group, previous))
                .collect();
            for group in dead {
                state.groups.remove(&group);
            }
        } else {
            state
                .nodes
                .retain(|_, entry| entry.group.is_some() || entry.frame >= previous);
        }
        if state.nodes.len() != before {
            state.revision += 1;
        }
    }

    /// Changes with any recorded bounds (see `LayoutState::revision`).
    pub(crate) fn revision(&self) -> u64 {
        self.0.borrow().revision
    }

    /// Record a node's bounds (`group`: the retained subtree it is drawn
    /// in); returns whether they changed since it was last painted (or it is
    /// newly painted).
    pub(crate) fn record(&self, id: &str, bounds: Bounds<Pixels>, group: Option<u64>) -> bool {
        let mut state = self.0.borrow_mut();
        let frame = state.frame;
        let changed = match state.nodes.get(id) {
            Some(entry) => {
                state.bounds_of(entry) != bounds
                    || !(entry.frame == frame || state.painted_in(entry, frame - 1))
            }
            None => true,
        };
        let entry = Entry {
            bounds,
            frame,
            group,
        };
        match state.nodes.get_mut(id) {
            Some(slot) => *slot = entry,
            None => {
                state.nodes.insert(id.to_string(), entry);
            }
        }
        if changed {
            state.revision += 1;
        }
        changed
    }

    /// A retained subtree was visited this frame inside `parent`, its top
    /// left at `origin`. `drew`: it is drawn anew, so its nodes are recorded
    /// again; otherwise its last drawing is copied there or left out, and
    /// its nodes are where they were recorded, moved as far as it has.
    pub(crate) fn touch_group(
        &self,
        group: u64,
        parent: Option<u64>,
        origin: Point<Pixels>,
        drew: bool,
    ) {
        let mut state = self.0.borrow_mut();
        let frame = state.frame;
        let moved = !drew && state.origin(group).is_some_and(|before| before != origin);
        let parent_origin = parent
            .and_then(|parent| state.origin(parent))
            .unwrap_or_default();
        let info = state.groups.entry(group).or_insert(Group {
            parent,
            touched: frame,
            built: frame,
            origin,
            built_origin: origin,
            parent_origin,
        });
        info.parent = parent;
        info.touched = frame;
        info.origin = origin;
        info.parent_origin = parent_origin;
        if drew {
            info.built = frame;
            info.built_origin = origin;
        }
        if moved {
            // Its nodes moved with it, though none is recorded again.
            state.revision += 1;
        }
    }

    /// Bounds painted in the latest frame.
    fn painted(&self) -> Vec<(String, Bounds<Pixels>)> {
        let state = self.0.borrow();
        state
            .nodes
            .iter()
            .filter(|(_, entry)| state.painted_in(entry, state.frame))
            .map(|(id, entry)| (id.clone(), state.bounds_of(entry)))
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
    /// A node's bounds, if it was painted in the current frame.
    pub(crate) fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        let state = self.0.borrow();
        state
            .nodes
            .get(id)
            .filter(|entry| state.painted_in(entry, state.frame))
            .map(|entry| state.bounds_of(entry))
    }

    pub(crate) fn node(&self, id: &str) -> Option<LayoutNode> {
        self.bounds(id)
            .map(|bounds| layout_node(id.to_string(), bounds))
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
    /// A pointer move to window coordinates.
    Move(Point<Pixels>),
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
        SimAction::Press(id) => events.press(&id, Held::default()),
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
        SimAction::ContextMenu(id, x, y) => events.context_menu(&id, x, y, Held::default()),
        SimAction::Hover(id, hovered) => events.hover(&id, hovered),
        SimAction::Move(position) => {
            let _ = window.dispatch_event(
                gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
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

#[cfg(test)]
mod layout_tests {
    use gpui::{point, px, size, Bounds};

    use super::LayoutMap;

    fn at(x: f32) -> Bounds<gpui::Pixels> {
        Bounds::new(point(px(x), px(0.)), size(px(10.), px(10.)))
    }

    #[test]
    fn the_revision_moves_only_when_bounds_do() {
        let layout = LayoutMap::default();
        layout.begin_frame();
        layout.record("a", at(0.), None);
        let first = layout.revision();
        layout.begin_frame();
        layout.record("a", at(0.), None);
        assert_eq!(layout.revision(), first, "the same bounds again");
        layout.begin_frame();
        layout.record("a", at(5.), None);
        assert!(layout.revision() > first, "a scroll or resize moved it");
        let moved = layout.revision();
        layout.begin_frame();
        layout.begin_frame();
        assert!(
            layout.revision() > moved,
            "a node no longer painted is forgotten"
        );
    }

    /// A retained subtree whose drawing is reused records nothing, and its
    /// nodes (and those of the subtrees inside it) are still painted.
    #[test]
    fn a_reused_subtree_keeps_its_nodes_painted() {
        let layout = LayoutMap::default();
        // Frame 1: row (group 1) and the card inside it (group 2) drawn anew.
        layout.begin_frame();
        layout.record("text", at(1.), Some(2));
        layout.touch_group(2, Some(1), at(1.).origin, true);
        layout.record("card", at(0.), Some(1));
        layout.touch_group(1, None, at(0.).origin, true);
        // Frame 2: the row is reused; nothing inside runs.
        layout.begin_frame();
        layout.touch_group(1, None, at(0.).origin, false);
        assert!(layout.node("card").is_some());
        assert!(layout.node("text").is_some(), "inside a reused subtree");
        // Frame 3: the row is drawn anew without the card.
        layout.begin_frame();
        layout.record("card", at(0.), Some(1));
        layout.touch_group(1, None, at(0.).origin, true);
        assert!(layout.node("card").is_some());
        assert!(layout.node("text").is_none(), "left the row");
        // Frame 4: the row is gone.
        layout.begin_frame();
        assert!(layout.node("card").is_none());
    }

    /// A retained subtree whose drawing is copied elsewhere (it scrolled),
    /// or left out, records nothing: its nodes, and those of the subtrees
    /// inside it, are where it is now.
    #[test]
    fn a_moved_subtree_takes_its_nodes_along() {
        let layout = LayoutMap::default();
        let x = |id: &str| layout.node(id).map(|node| node.x);
        // Frame 1: the row (group 1) at 10 with a card inside it, and the
        // card's subtree (group 2) at 12 with a text inside that.
        layout.begin_frame();
        layout.touch_group(1, None, at(10.).origin, true);
        layout.record("card", at(12.), Some(1));
        layout.touch_group(2, Some(1), at(12.).origin, true);
        layout.record("text", at(13.), Some(2));
        let drawn = layout.revision();
        // Frame 2: the row's drawing is copied 5 further; nothing inside runs.
        layout.begin_frame();
        layout.touch_group(1, None, at(15.).origin, false);
        assert_eq!(x("card"), Some(17.));
        assert_eq!(x("text"), Some(18.), "inside a subtree carried along");
        assert!(layout.revision() > drawn, "bounds changed");
        // Frame 3: left out, 100 further.
        layout.begin_frame();
        layout.touch_group(1, None, at(115.).origin, false);
        assert_eq!(x("text"), Some(118.));
        let moved = layout.revision();
        // Frame 4: where it was: nothing changed.
        layout.begin_frame();
        layout.touch_group(1, None, at(115.).origin, false);
        assert_eq!(layout.revision(), moved);
        // Frame 5: the row is drawn anew at 40 (its card recorded again),
        // and the card's subtree is copied to where it now is.
        layout.begin_frame();
        layout.touch_group(1, None, at(40.).origin, true);
        layout.record("card", at(42.), Some(1));
        layout.touch_group(2, Some(1), at(42.).origin, false);
        assert_eq!(x("card"), Some(42.));
        assert_eq!(x("text"), Some(43.));
        // Frame 6: the row copied back to 10; the card's subtree goes with it.
        layout.begin_frame();
        layout.touch_group(1, None, at(10.).origin, false);
        assert_eq!(x("card"), Some(12.));
        assert_eq!(x("text"), Some(13.));
    }
}

#[cfg(test)]
mod command_tests {
    use super::SimCommand;

    #[test]
    fn a_focus_names_its_element() {
        let command: SimCommand = serde_json::from_str(r#"{"kind":"focus","id":"save"}"#).unwrap();
        assert_eq!(command, SimCommand::Focus { id: "save".into() });
    }
}
