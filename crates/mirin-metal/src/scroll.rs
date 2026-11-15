//! A scroll view's position, read and written by the driver.
//!
//! Read: a view with `onScroll` (a scroll view or a virtualized list) tells
//! the driver how far it is scrolled whenever that changes, whoever moved
//! it (the wheel, its scroll bar, a key, the driver): `{"type":"scroll",
//! "nodeId","x","y","contentWidth","contentHeight","width","height"}`. It
//! is looked at as the view is drawn (`scrollbar.rs` reads the same
//! geometry), so there is at most one event a frame, and at most one every
//! `scrollThrottle` ms when the view says so: the offset it ends on is
//! always told, when the wait is over.
//!
//! Written: `{"scrollTo":{"id","x","y"}}` puts a view at an offset (an axis
//! left out stays; the view keeps it in its range), and
//! `{"scrollIntoView":{"id"}}` scrolls every view around a node the least
//! that shows it whole. A node's place is what the last frame painted, so a
//! node that came with the newest tree is shown once a frame has drawn it,
//! and a row a virtualized list has not laid out is first brought in by its
//! index.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use sumi::{point, px, App, Bounds, Context, Pixels, Window};

use crate::events::EventSender;
use crate::scrollbar::{Geometry, Scrolled};
use crate::tree::{NodeSpec, ViewProps};
use crate::window::RootView;

/// In the host binary while a scroll view reports its offset and takes one
/// from the driver; its `protocol` line says `"scroll":true`.
pub const SCROLL_MARKER: &str = "MIRIN_METAL_SCROLL";

/// How many frames a `scrollIntoView` lasts at most: it waits for one that
/// drew its tree (`WAIT_FRAMES` at most: a tree that changes every frame is
/// not waited out), then looks until a look moves nothing (a list brings a
/// row in on one, and the views around it follow on the next).
const REVEAL_FRAMES: u8 = 6;
const WAIT_FRAMES: u8 = 2;

/// Offsets nearer than this are the same place.
const SAME: f32 = 0.01;

/// What a driver asks of a scroll view.
#[derive(Debug, Clone, PartialEq)]
pub enum ScrollCommand {
    /// Scroll view `id` to (`x`, `y`) from its content's start; an axis left
    /// out stays where it is.
    To {
        id: String,
        x: Option<f32>,
        y: Option<f32>,
    },
    /// Scroll the views around node `id` the least that shows it whole.
    IntoView { id: String },
}

/// Where a scroll view stands: how far it is scrolled, how large its
/// content is, and how large it is itself.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScrollPosition {
    pub x: f32,
    pub y: f32,
    pub content_width: f32,
    pub content_height: f32,
    pub width: f32,
    pub height: f32,
}

impl ScrollPosition {
    fn of(geometry: &Geometry) -> Self {
        let (width, height) = (
            f32::from(geometry.viewport.size.width),
            f32::from(geometry.viewport.size.height),
        );
        Self {
            x: geometry.scrolled.0.max(0.0),
            y: geometry.scrolled.1.max(0.0),
            content_width: width + geometry.overflow.0.max(0.0),
            content_height: height + geometry.overflow.1.max(0.0),
            width,
            height,
        }
    }

    fn is_at(&self, (x, y): (f32, f32)) -> bool {
        (self.x - x).abs() < SAME && (self.y - y).abs() < SAME
    }
}

/// What one view's driver last heard, kept between frames.
#[derive(Default)]
struct Told {
    /// The offset last told; a view starts at its content's start.
    offset: (f32, f32),
    at: Option<Instant>,
    /// A timer is out for an offset that changed too soon after the last told.
    waits: bool,
}

/// One view's reports, kept by id in the root view while it listens.
#[derive(Clone, Default)]
pub(crate) struct Reports(Rc<RefCell<Told>>);

/// How long a report must still wait: `None` when it may go now.
fn wait(now: Instant, told_at: Option<Instant>, throttle: Duration) -> Option<Duration> {
    let since = now.saturating_duration_since(told_at?);
    (since < throttle).then(|| throttle - since)
}

/// A scroll view that tells its driver where it stands.
#[derive(Clone)]
pub(crate) struct Reporter {
    pub(crate) id: String,
    pub(crate) events: EventSender,
    pub(crate) throttle: Duration,
    pub(crate) reports: Reports,
}

impl Reporter {
    /// For view `id`, when it listens: its reports are kept in `view`.
    pub(crate) fn of(id: &str, props: &ViewProps, view: &mut RootView) -> Option<Self> {
        if !props.on_scroll {
            // Listening again later tells where it stands then.
            view.scroll_reports.remove(id);
            return None;
        }
        // Under a check every frame's offset is told: a `settle` then has
        // nothing left to wait for.
        let throttle = if crate::check::enabled() {
            0.0
        } else {
            props.scroll_throttle.unwrap_or(0.0).clamp(0.0, 60_000.0)
        };
        Some(Self {
            id: id.to_owned(),
            events: view.events.clone(),
            throttle: Duration::from_secs_f32(throttle / 1000.0),
            reports: view
                .scroll_reports
                .entry(id.to_owned())
                .or_default()
                .clone(),
        })
    }

    /// The view was drawn standing as `geometry` says: tell the driver when
    /// that is news, now or when its throttle allows.
    pub(crate) fn look(
        &self,
        geometry: &Geometry,
        scrolled: &Scrolled,
        window: &mut Window,
        cx: &mut App,
    ) {
        let now = Instant::now();
        let Some(delay) = self.tell(ScrollPosition::of(geometry), now) else {
            return;
        };
        // Too soon: look again when the wait is over, drawn or not, until
        // the driver has heard where the view stands.
        let (reporter, scrolled) = (self.clone(), scrolled.clone());
        let executor = cx.background_executor().clone();
        window
            .spawn(cx, async move |_cx| {
                let mut delay = delay;
                loop {
                    executor.timer(delay).await;
                    reporter.reports.0.borrow_mut().waits = false;
                    let position = ScrollPosition::of(&scrolled.geometry());
                    match reporter.tell(position, Instant::now()) {
                        // A timer that woke a moment early: the rest of the wait.
                        Some(rest) => delay = rest,
                        None => break,
                    }
                }
            })
            .detach();
    }

    /// Tell the driver `position` when it is not where it last heard; the
    /// wait to look again after, when it is too soon and nothing waits yet.
    fn tell(&self, position: ScrollPosition, now: Instant) -> Option<Duration> {
        let mut told = self.reports.0.borrow_mut();
        if position.is_at(told.offset) {
            return None;
        }
        if let Some(delay) = wait(now, told.at, self.throttle) {
            return (!std::mem::replace(&mut told.waits, true)).then_some(delay);
        }
        told.offset = (position.x, position.y);
        told.at = Some(now);
        self.events.scroll(&self.id, position);
        None
    }
}

/// A node asked into view, until a frame has drawn the tree it is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Reveal {
    id: String,
    frames: u8,
    /// A list brought its row in by index, from above it (`Some(true)`) or
    /// from below: once the row is laid out it goes to the edge it came by.
    came: Option<bool>,
}

/// How far to scroll (down or right; negative: up or left) so that the
/// span `from..to` shows whole in the view's `start..end`: nothing when it
/// already does, or fills the view.
pub(crate) fn nearest(from: f32, to: f32, start: f32, end: f32) -> f32 {
    if from < start && to > end {
        0.0
    } else if from < start {
        from - start
    } else if to > end {
        // Never past its start: a span longer than the view shows its start.
        (to - end).min(from - start)
    } else {
        0.0
    }
}

/// The views around node `id`, outermost first; `None` when the tree has no
/// such node.
fn ancestors<'t>(node: &'t NodeSpec, id: &str, path: &mut Vec<&'t ViewProps>) -> bool {
    if crate::render::node_id(node).as_deref() == Some(id) {
        return true;
    }
    let NodeSpec::View { props, children } = node else {
        return false;
    };
    path.push(props);
    if children.iter().any(|child| ancestors(child, id, path)) {
        return true;
    }
    path.pop();
    false
}

impl RootView {
    /// Do what the driver asked of a scroll view. The tree it names is the
    /// one this view holds: the turn's trees are applied before.
    pub(crate) fn scroll(&mut self, command: ScrollCommand, cx: &mut Context<Self>) {
        match command {
            ScrollCommand::To { id, x, y } => self.scroll_to(&id, x, y),
            ScrollCommand::IntoView { id } => {
                if !self.tree.contains(&id) {
                    eprintln!("[mirin-metal] scrollIntoView: no node with id {id:?}");
                    return;
                }
                self.reveals.retain(|reveal| reveal.id != id);
                self.reveals.push(Reveal {
                    id,
                    frames: 0,
                    came: None,
                });
            }
        }
        cx.notify();
    }

    fn scroll_to(&mut self, id: &str, x: Option<f32>, y: Option<f32>) {
        let at = |value: f32| px(-value.max(0.0));
        if let Some(list) = self.lists.get_mut(id) {
            // To an offset in its whole length, not in the rows it has laid out.
            list.estimate();
            if let Some(y) = y {
                list.state.set_offset_from_scrollbar(point(px(0.0), at(y)));
            }
        } else if let Some(handle) = self.scrolls.get(id) {
            // Kept in its range as the view is next drawn.
            let offset = handle.offset();
            handle.set_offset(point(x.map_or(offset.x, at), y.map_or(offset.y, at)));
        } else {
            eprintln!("[mirin-metal] scrollTo: no scroll view with id {id:?}");
        }
    }

    /// As a frame begins: bring the nodes asked for into view, by where the
    /// last frame painted them. One whose tree no frame has drawn yet waits
    /// for this one, and asks for the next.
    pub(crate) fn reveal_pending(&mut self, window: &mut Window) {
        let generation = self.tree.generation();
        let drawn = std::mem::replace(&mut self.drawn_generation, generation) == generation;
        if self.reveals.is_empty() {
            return;
        }
        let mut reveals = std::mem::take(&mut self.reveals);
        reveals.retain_mut(|reveal| {
            reveal.frames += 1;
            if !drawn && reveal.frames <= WAIT_FRAMES {
                return true;
            }
            // Until a look moves nothing: what it moved is drawn by then.
            self.reveal(reveal) && reveal.frames < REVEAL_FRAMES
        });
        if !reveals.is_empty() {
            window.request_animation_frame();
        }
        self.reveals = reveals;
    }

    /// Scroll the views around the node so it shows; whether any moved.
    fn reveal(&mut self, reveal: &mut Reveal) -> bool {
        let id = reveal.id.as_str();
        let tree = Rc::clone(self.tree.tree());
        let mut around = Vec::new();
        if !ancestors(&tree, id, &mut around) {
            return false;
        }
        let mut shown = self.layout.bounds(id);
        let mut moved = false;
        for props in around.into_iter().rev() {
            let Some(view) = props.id.as_deref() else {
                continue;
            };
            if let Some(list) = self.lists.get_mut(view) {
                match shown {
                    Some(bounds) => {
                        let viewport = list.state.viewport_bounds();
                        // A row brought in by index was placed by the
                        // heights the list had for the rows around it,
                        // which were estimates where it had laid none out:
                        // now that they are, it goes to the edge it came by.
                        let by = match reveal.came.take() {
                            Some(from_above) => edge(bounds, viewport, from_above),
                            None => across(bounds, viewport).1,
                        };
                        if by != 0.0 {
                            list.state.scroll_by(px(by));
                            shown = Some(shifted(bounds, 0.0, by));
                            moved = true;
                        }
                    }
                    // Not laid out: its row comes in by index, and what is
                    // around the list shows the list meanwhile.
                    None => {
                        list.estimate();
                        if let Some(row) = list.row_of(id) {
                            reveal.came = Some(row <= list.state.logical_scroll_top().item_ix);
                            list.state.scroll_to_reveal_item(row);
                            moved = true;
                        }
                        shown = self.layout.bounds(view);
                    }
                }
            } else if let Some(handle) = self.scrolls.get(view) {
                let Some(bounds) = shown else {
                    shown = self.layout.bounds(view);
                    continue;
                };
                let (right, down) = across(bounds, handle.bounds());
                let right = if props.scroll_x { right } else { 0.0 };
                let down = if props.scroll { down } else { 0.0 };
                if right != 0.0 || down != 0.0 {
                    let offset = handle.offset();
                    handle.set_offset(point(offset.x - px(right), offset.y - px(down)));
                    shown = Some(shifted(bounds, right, down));
                    moved = true;
                }
            }
        }
        moved
    }
}

/// How far a view showing `viewport` scrolls (right, down) to show `bounds`.
fn across(bounds: Bounds<Pixels>, viewport: Bounds<Pixels>) -> (f32, f32) {
    let step = |from: Pixels, to: Pixels, start: Pixels, end: Pixels| {
        let by = nearest(from.into(), to.into(), start.into(), end.into());
        // Less than this is drawn in the same place.
        if by.abs() < 0.5 {
            0.0
        } else {
            by
        }
    };
    (
        step(
            bounds.left(),
            bounds.right(),
            viewport.left(),
            viewport.right(),
        ),
        step(
            bounds.top(),
            bounds.bottom(),
            viewport.top(),
            viewport.bottom(),
        ),
    )
}

/// How far a list showing `viewport` scrolls down to put `bounds` at its
/// top edge (a row that came from above) or its bottom one; a row longer
/// than the list shows its start.
fn edge(bounds: Bounds<Pixels>, viewport: Bounds<Pixels>, from_above: bool) -> f32 {
    let to_top = f32::from(bounds.top() - viewport.top());
    let by = if from_above {
        to_top
    } else {
        f32::from(bounds.bottom() - viewport.bottom()).min(to_top)
    };
    if by.abs() < 0.5 {
        0.0
    } else {
        by
    }
}

/// `bounds` once what it is in has scrolled `right` and `down`.
fn shifted(bounds: Bounds<Pixels>, right: f32, down: f32) -> Bounds<Pixels> {
    Bounds::new(
        point(bounds.origin.x - px(right), bounds.origin.y - px(down)),
        bounds.size,
    )
}

#[cfg(test)]
mod tests;
