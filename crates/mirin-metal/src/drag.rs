//! Files dragged out of a window (`dragFiles`) and dropped on it (`onDrop`).
//!
//! A left press on a view with `dragFiles`, then a move of a few pixels with
//! the button held, starts a Wayland drag (GPUI's `start_file_drag`): the
//! compositor takes the pointer, and any window that takes files gets them,
//! this one included. Files dragged over this window arrive as GPUI's
//! external paths; the deepest `onDrop` view under the pointer, inside every
//! scrolling or clipping ancestor, hears `enter`, `over`, `leave`, and `drop`.

use std::path::{Path, PathBuf};

use gpui::{ExternalPaths, Pixels, Point, Window};

use crate::events::{DropEvent, DropPhase};
use crate::tree::{DragFiles, NodeSpec};
use crate::window::RootView;

/// How far the pointer moves with the button held before a press becomes a drag.
const THRESHOLD: f32 = 6.0;
const ICON_SIZE: u32 = 48;

impl RootView {
    /// A left press on `id`, a view with `dragFiles`.
    pub(crate) fn press_draggable(&mut self, id: &str, at: Point<Pixels>) {
        self.drag_candidate = Some((id.to_string(), at));
    }

    /// The pointer moved with the left button `held`: start the drag once it is far enough.
    pub(crate) fn drag_moved(&mut self, at: Point<Pixels>, held: bool, window: &Window) {
        let Some((id, start)) = &self.drag_candidate else {
            return;
        };
        if !held {
            self.drag_candidate = None;
            return;
        }
        let (dx, dy) = (f32::from(at.x - start.x), f32::from(at.y - start.y));
        if dx.hypot(dy) < THRESHOLD {
            return;
        }
        let id = id.clone();
        self.drag_candidate = None;
        let Some(files) = find_drag_files(&self.tree, &id) else {
            return;
        };
        let paths: Vec<PathBuf> = files
            .paths
            .iter()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .collect();
        if paths.is_empty() {
            return;
        }
        let icon = files.icon.as_deref().map(Path::new);
        if !crate::gpui_api::start_file_drag(
            window,
            &paths,
            icon,
            files.icon_size.unwrap_or(ICON_SIZE),
        ) {
            eprintln!("[mirin-metal] dragFiles: this platform can't start a drag");
        }
    }

    /// The button went up: no drag from this press.
    pub(crate) fn drag_released(&mut self) {
        self.drag_candidate = None;
    }

    /// Files over the window at `at`.
    pub(crate) fn files_over(&mut self, at: Point<Pixels>, paths: &ExternalPaths, window: &Window) {
        let target = self.drop_target_at(at);
        if target != self.drop_target {
            if let Some(old) = self.drop_target.take() {
                self.send_drop(&old, DropPhase::Leave, at, &[], window);
            }
            if let Some(new) = &target {
                self.send_drop(new, DropPhase::Enter, at, paths.paths(), window);
            }
            self.drop_target = target;
        } else if let Some(current) = &self.drop_target {
            self.send_drop(current, DropPhase::Over, at, paths.paths(), window);
        }
    }

    /// Files dropped on the window at `at`.
    pub(crate) fn files_dropped(
        &mut self,
        at: Point<Pixels>,
        paths: &ExternalPaths,
        window: &Window,
    ) {
        let target = self.drop_target_at(at);
        if let Some(old) = self.drop_target.take() {
            if Some(&old) != target.as_ref() {
                self.send_drop(&old, DropPhase::Leave, at, &[], window);
            }
        }
        if let Some(target) = target {
            self.send_drop(&target, DropPhase::Drop, at, paths.paths(), window);
        }
    }

    /// The drag left the window, or ended elsewhere.
    pub(crate) fn files_gone(&mut self, window: &Window) {
        if let Some(old) = self.drop_target.take() {
            self.send_drop(&old, DropPhase::Leave, Point::default(), &[], window);
        }
    }

    fn send_drop(
        &self,
        id: &str,
        phase: DropPhase,
        at: Point<Pixels>,
        paths: &[PathBuf],
        window: &Window,
    ) {
        let modifiers = window.modifiers();
        self.events.drop_event(
            id,
            DropEvent {
                phase,
                x: f32::from(at.x),
                y: f32::from(at.y),
                paths: paths
                    .iter()
                    .filter_map(|path| path.to_str().map(str::to_string))
                    .collect(),
                ctrl: modifiers.control,
                alt: modifiers.alt,
                shift: modifiers.shift,
            },
        );
    }

    /// The deepest painted `onDrop` view under `at`, inside every scrolling or clipping ancestor.
    fn drop_target_at(&self, at: Point<Pixels>) -> Option<String> {
        let mut found = None;
        self.find_drop_target(&self.tree, at, &mut found);
        found
    }

    fn find_drop_target(&self, node: &NodeSpec, at: Point<Pixels>, found: &mut Option<String>) {
        let NodeSpec::View { props, children } = node else {
            return;
        };
        let bounds = props.id.as_deref().and_then(|id| self.layout.bounds(id));
        let inside = bounds.is_some_and(|bounds| bounds.contains(&at));
        if (props.scroll || props.scroll_x || props.clip) && bounds.is_some() && !inside {
            // Nothing scrolled or clipped out of view takes the drop.
            return;
        }
        if props.on_drop && inside {
            *found = props.id.clone();
        }
        for child in children {
            self.find_drop_target(child, at, found);
        }
    }
}

/// The `dragFiles` of the view `id`.
fn find_drag_files(node: &NodeSpec, id: &str) -> Option<DragFiles> {
    let NodeSpec::View { props, children } = node else {
        return None;
    };
    if props.id.as_deref() == Some(id) {
        return props.drag_files.clone();
    }
    children.iter().find_map(|child| find_drag_files(child, id))
}
