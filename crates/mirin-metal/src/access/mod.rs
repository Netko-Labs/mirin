//! The accessibility tree: what a screen reader (Orca) hears of a Metal
//! window. Built from the element tree and the renderer's own state
//! (`tree.rs`), published over AT-SPI on Linux through AccessKit
//! (`linux.rs`), and nowhere yet on other platforms. A screen reader's
//! "press" or "focus" comes back as a simulated click on that element
//! (`sim.rs`), so it does exactly what the person's click does.
//!
//! On by default; `MIRIN_METAL_ACCESSIBLE=0` turns it off. A driver checks
//! the host binary for `ACCESSIBLE_MARKER` before it sends `access` props:
//! a host without them rejects a tree that has them.

#[cfg(target_os = "linux")]
mod linux;
mod tree;

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use accesskit::{NodeId, Rect};

use crate::sim::{LayoutMap, SimCommand};
use crate::tree::NodeSpec;

/// Named by a host binary that publishes an accessibility tree and takes
/// `access` props on views and inputs; also the variable that turns it off.
pub const ACCESSIBLE_MARKER: &str = "MIRIN_METAL_ACCESSIBLE";

/// Whether this process publishes the tree: unless `MIRIN_METAL_ACCESSIBLE=0`.
fn wanted() -> bool {
    std::env::var(ACCESSIBLE_MARKER).map_or(true, |value| value != "0")
}

/// The field with the keyboard, and what is typed in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Focused {
    pub id: String,
    pub text: Option<String>,
}

/// What the tree was last built from; the same again builds nothing. The
/// tree is held, so a new one can't take its place in memory unnoticed.
struct Built {
    tree: Rc<NodeSpec>,
    focused: Option<Focused>,
    window_active: bool,
    title: String,
}

impl Built {
    fn same(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.tree, &other.tree)
            && self.focused == other.focused
            && self.window_active == other.window_active
            && self.title == other.title
    }
}

/// One window's accessibility tree and where it is published.
pub(crate) struct Accessibility {
    title: String,
    last: Option<Built>,
    /// Node → the element a screen reader's press goes to (shared with the adapter's thread).
    targets: Arc<Mutex<HashMap<NodeId, String>>>,
    #[cfg(target_os = "linux")]
    publisher: linux::Publisher,
}

impl Accessibility {
    /// The tree for a window titled `title`; `act` performs what a screen
    /// reader asks (from another thread). None when it is turned off.
    pub(crate) fn new(title: &str, act: impl Fn(SimCommand) + Send + 'static) -> Option<Self> {
        if !wanted() {
            return None;
        }
        let targets: Arc<Mutex<HashMap<NodeId, String>>> = Arc::default();
        let press = {
            let targets = Arc::clone(&targets);
            move |node: NodeId| {
                let id = targets
                    .lock()
                    .ok()
                    .and_then(|targets| targets.get(&node).cloned());
                if let Some(id) = id {
                    act(SimCommand::Click {
                        id: Some(id),
                        x: None,
                        y: None,
                    });
                }
            }
        };
        #[cfg(not(target_os = "linux"))]
        let _ = press;
        crate::trace::log(format_args!("{ACCESSIBLE_MARKER}: publishing {title:?}"));
        Some(Self {
            title: title.to_owned(),
            last: None,
            targets,
            #[cfg(target_os = "linux")]
            publisher: linux::Publisher::new(press),
        })
    }

    pub(crate) fn retitle(&mut self, title: &str) {
        title.clone_into(&mut self.title);
    }

    /// Publish the tree for `tree` as just painted (bounds from `layout`),
    /// unless nothing it is built from changed since the last time.
    pub(crate) fn refresh(
        &mut self,
        tree: &Rc<NodeSpec>,
        layout: &LayoutMap,
        focused: Option<Focused>,
        window_active: bool,
    ) {
        let now = Built {
            tree: Rc::clone(tree),
            focused,
            window_active,
            title: self.title.clone(),
        };
        if self.last.as_ref().is_some_and(|last| last.same(&now)) {
            return;
        }
        let bounds = |id: &str| {
            layout.bounds(id).map(|bounds| {
                let (x, y) = (f64::from(bounds.origin.x), f64::from(bounds.origin.y));
                Rect::new(
                    x,
                    y,
                    x + f64::from(bounds.size.width),
                    y + f64::from(bounds.size.height),
                )
            })
        };
        let typed = now.focused.clone();
        let text_of = move |id: &str| {
            typed
                .as_ref()
                .filter(|focused| focused.id == id)
                .and_then(|focused| focused.text.clone())
        };
        let facts = tree::Facts {
            title: &self.title,
            bounds: &bounds,
            focused: now.focused.as_ref().map(|focused| focused.id.as_str()),
            text_of: &text_of,
        };
        let built = tree::build(tree, &facts);
        if let Ok(mut targets) = self.targets.lock() {
            *targets = built.targets;
        }
        #[cfg(target_os = "linux")]
        self.publisher.publish(built.update, window_active);
        #[cfg(not(target_os = "linux"))]
        let _ = built.update;
        self.last = Some(now);
    }
}
