//! The accessibility tree: what a screen reader (Orca) hears of a Metal
//! window. Built from the element tree and the renderer's own state
//! (`tree.rs`), published over AT-SPI on Linux through AccessKit
//! (`linux.rs`), and nowhere yet on other platforms. A screen reader's
//! "press" comes back as a simulated click on that element (`sim.rs`), so it
//! does exactly what the person's click does; its "focus" gives the element
//! the keyboard (`{"kind":"focus"}`) and never presses it.
//!
//! It costs what changed. While the session has accessibility off nothing is
//! built at all; once the adapter is on the accessibility bus the tree is
//! kept (`published.rs`) and each update makes and hands over only the nodes
//! that differ: the ones a patch reached, the ones whose painted bounds
//! moved, the one with the keyboard.
//!
//! On by default; `MIRIN_METAL_ACCESSIBLE=0` turns it off. A driver checks
//! the host binary for `ACCESSIBLE_MARKER` before it sends `access` props:
//! a host without them rejects a tree that has them.
//!
//! The application is named by the driver (`MIRIN_METAL_APP_NAME`, the
//! `appName` option), else by its first window's title: what Orca says for
//! the app, never the host binary's file name.

#[cfg(target_os = "linux")]
mod linux;
mod published;
#[cfg(not(target_os = "linux"))]
mod silent;
#[cfg(test)]
mod tests;
mod tree;
mod walk;

use std::sync::{Arc, Mutex};

use accesskit::{Action, NodeId, Rect};

#[cfg(target_os = "linux")]
use self::linux::{name_app, Publisher};
use self::published::Published;
#[cfg(not(target_os = "linux"))]
use self::silent::{name_app, Publisher};
use crate::patch::Document;
use crate::sim::{LayoutMap, SimCommand};

/// Named by a host binary that publishes an accessibility tree and takes
/// `access` props on views and inputs; also the variable that turns it off.
pub const ACCESSIBLE_MARKER: &str = "MIRIN_METAL_ACCESSIBLE";

/// Whether this process publishes the tree: unless `MIRIN_METAL_ACCESSIBLE=0`.
fn wanted() -> bool {
    std::env::var(ACCESSIBLE_MARKER).map_or(true, |value| value != "0")
}

/// The variable a driver names its app with, for screen readers (`appName`).
pub const APP_NAME_VAR: &str = "MIRIN_METAL_APP_NAME";

/// `MIRIN_METAL_ACCESS_CHECK=1`: after every update the kept tree is
/// compared with one made from nothing, and a difference is reported on
/// stderr (for trying a change to `published.rs` on a real app).
const CHECK_VAR: &str = "MIRIN_METAL_ACCESS_CHECK";

/// What a screen reader calls the app: the driver's name for it, else the
/// first window's title unless it is the host's own stand-in ("mirin metal").
fn app_name(given: Option<&str>, title: &str) -> Option<String> {
    let given = given.map(str::trim).filter(|name| !name.is_empty());
    let title = title.trim();
    let titled = (!title.is_empty() && !title.starts_with("mirin metal")).then_some(title);
    given.or(titled).map(str::to_owned)
}

/// The field with the keyboard, and what is typed in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Focused {
    pub id: String,
    pub text: Option<String>,
}

/// What the tree was last brought in line with; the same again changes
/// nothing. The tree is known by its generation (`patch::Document`), which
/// every whole tree and every patch changes; holding the tree itself would
/// make every patch copy it.
struct Built {
    generation: u64,
    /// The layout's revision: bounds that moved (a resize, a scroll) with the
    /// same tree still need publishing.
    layout: u64,
    focused: Option<Focused>,
    window_active: bool,
    title: String,
}

impl Built {
    fn same(&self, other: &Self) -> bool {
        self.generation == other.generation
            && self.layout == other.layout
            && self.focused == other.focused
            && self.window_active == other.window_active
            && self.title == other.title
    }
}

/// A node's painted bounds in window pixels, as the layout has them.
fn painted(layout: &LayoutMap, id: &str) -> Option<Rect> {
    let bounds = layout.bounds(id)?;
    let (x, y) = (f64::from(bounds.origin.x), f64::from(bounds.origin.y));
    Some(Rect::new(
        x,
        y,
        x + f64::from(bounds.size.width),
        y + f64::from(bounds.size.height),
    ))
}

/// One window's accessibility tree and where it is published.
pub(crate) struct Accessibility {
    title: String,
    /// What the adapter's tree was last brought in line with; none while it
    /// has no tree.
    last: Option<Built>,
    /// The tree as the adapter has it.
    published: Published,
    /// Where a screen reader's press or focus goes (shared with the adapter's thread).
    targets: Arc<Mutex<tree::Targets>>,
    /// Whether the adapter was last told the window has the keyboard.
    window_active: Option<bool>,
    publisher: Publisher,
    /// `CHECK_VAR`: every update is compared with a tree made from nothing.
    checked: bool,
}

impl Accessibility {
    /// The tree for a window titled `title`; `act` performs what a screen
    /// reader asks, and `wake` has the window publish its tree now (a screen
    /// reader started listening); both are called from another thread. None
    /// when it is turned off.
    pub(crate) fn new(
        title: &str,
        act: impl Fn(SimCommand) + Send + 'static,
        wake: impl Fn() + Send + 'static,
    ) -> Option<Self> {
        if !wanted() {
            return None;
        }
        let targets: Arc<Mutex<tree::Targets>> = Arc::default();
        let press = {
            let targets = Arc::clone(&targets);
            move |action: Action, node: NodeId| {
                let command = targets.lock().ok().and_then(|targets| {
                    targets.request(action, node).map(|request| match request {
                        tree::Request::Click(id) => SimCommand::Click {
                            id: Some(id.to_owned()),
                            x: None,
                            y: None,
                        },
                        tree::Request::Focus(id) => SimCommand::Focus { id: id.to_owned() },
                    })
                });
                if let Some(command) = command {
                    act(command);
                }
            }
        };
        let name = app_name(std::env::var(APP_NAME_VAR).ok().as_deref(), title);
        // The first window names the app; later ones (a resident host's) keep it.
        if let Some(name) = &name {
            name_app(name);
        }
        crate::trace::log(format_args!(
            "{ACCESSIBLE_MARKER}: publishing {title:?} for {name:?}"
        ));
        Some(Self {
            title: title.to_owned(),
            last: None,
            published: Published::default(),
            targets,
            window_active: None,
            publisher: Publisher::new(press, wake),
            checked: std::env::var(CHECK_VAR).is_ok_and(|value| value == "1"),
        })
    }

    pub(crate) fn retitle(&mut self, title: &str) {
        title.clone_into(&mut self.title);
    }

    /// Bring the published tree in line with `tree` as just painted (bounds
    /// from `layout`): nothing while nobody listens or nothing it is made
    /// from changed, else the nodes that changed (`published.rs`).
    pub(crate) fn refresh(
        &mut self,
        tree: &Document,
        layout: &LayoutMap,
        focused: Option<Focused>,
        window_active: bool,
    ) {
        if !self.publisher.listening() {
            self.forget();
            // The adapter still hears whether the window has the keyboard,
            // to announce it when a screen reader starts.
            if self.window_active != Some(window_active) {
                self.publisher.window_active(window_active);
                self.window_active = Some(window_active);
            }
            return;
        }
        let now = Built {
            generation: tree.generation(),
            layout: layout.revision(),
            focused,
            window_active,
            title: self.title.clone(),
        };
        if !self.publisher.wants_whole() && self.last.as_ref().is_some_and(|last| last.same(&now)) {
            return;
        }
        let started = std::time::Instant::now();
        let bounds = |id: &str| painted(layout, id);
        let last_layout = self.last.as_ref().map(|last| last.layout);
        let facts = tree::Facts {
            title: &self.title,
            bounds: &bounds,
            moved: last_layout != Some(now.layout),
            focused: now.focused.as_ref().map(|focused| focused.id.as_str()),
            typed: now
                .focused
                .as_ref()
                .and_then(|focused| focused.text.as_deref()),
        };
        let (published, targets) = (&mut self.published, &self.targets);
        let mut made = None;
        self.publisher.publish(window_active, |whole| {
            if whole {
                // The adapter has no tree: it gets every node again.
                *published = Published::default();
                if let Ok(mut targets) = targets.lock() {
                    *targets = tree::Targets::default();
                }
            }
            let update = published.update(tree, &facts, targets);
            let sent = update.tree.nodes.len();
            made = Some((update.built, update.compared, sent, started.elapsed()));
            update.tree
        });
        self.window_active = Some(window_active);
        // The adapter stopped listening meanwhile: nothing was made.
        let Some((built, compared, sent, tree_took)) = made else {
            return;
        };
        let took = started.elapsed();
        crate::trace::log(format_args!(
            "access: built {built} nodes, published {sent} in {:.2}ms \
             ({compared} bounds compared; the adapter took {:.2}ms)",
            took.as_secs_f64() * 1000.0,
            (took - tree_took).as_secs_f64() * 1000.0
        ));
        if self.checked {
            self.check(tree, &facts);
        }
        self.last = Some(now);
    }

    /// Nobody listens: nothing is kept for them.
    fn forget(&mut self) {
        if self.last.take().is_none() && self.published.is_empty() {
            return;
        }
        self.published = Published::default();
        if let Ok(mut targets) = self.targets.lock() {
            *targets = tree::Targets::default();
        }
    }

    /// The kept tree against one made from nothing (`CHECK_VAR`).
    fn check(&self, tree: &Document, facts: &tree::Facts) {
        let targets = Mutex::default();
        let mut whole = Published::default();
        whole.update(tree, facts, &targets);
        crate::trace::log(format_args!("access check: compared with a whole tree"));
        let nodes = self.published.differences(&whole);
        let same_targets = match (self.targets.lock(), targets.lock()) {
            (Ok(kept), Ok(whole)) => *kept == *whole,
            _ => false,
        };
        if nodes > 0 || !same_targets {
            eprintln!(
                "[mirin-metal] access check: {nodes} nodes differ from a whole tree{}",
                if same_targets {
                    ""
                } else {
                    ", and the targets"
                }
            );
        }
    }
}
