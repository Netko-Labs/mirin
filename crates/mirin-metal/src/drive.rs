//! Driving a window from its driver: open it, apply the trees, titles and
//! simulations the driver streams, and, for a deferred host, open it later,
//! hide it, and open it again (a resident host). A hidden host keeps its
//! process, GPU context, fonts and the driver's newest tree, so the next open
//! draws that tree on its first frame.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::mpsc;
use std::time::Duration;

use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender};
use futures::StreamExt;

use gpui::{
    prelude::*, px, size, App, AsyncApp, Bounds, TitlebarOptions, WindowBackgroundAppearance,
    WindowBounds, WindowHandle, WindowOptions,
};

use crate::access::Accessibility;
use crate::events::{EventSender, NativeUiEvent};
use crate::focus::FOCUS_MARKER;
use crate::media::MetalAssets;
use crate::patch::{Document, PatchError, PatchOp};
use crate::sim::{self, LayoutMap, SimCommand};
use crate::surface::Surface;
use crate::titlebar::{Chrome, Controls, TitleBar};
use crate::tree::NodeSpec;
use crate::window::{DriverMessage, NativeUiOptions, RootView};

/// After a simulated click, how long to wait for the driver's resulting tree
/// before performing the commands queued behind it.
const SIM_SETTLE_INTERVAL: Duration = Duration::from_millis(16);
/// How long an unlocking lock surface stays so the unlock reaches the compositor.
const UNLOCK_FLUSH: Duration = Duration::from_millis(100);

/// Named by a host binary that keeps deferred hosts resident: `{"hide":true}`,
/// repeated `{"open":…}`, the `frame` event, and `heightTransitionMs`. A
/// driver looks for it in the binary before relying on them.
pub const RESIDENT_MARKER: &str = "MIRIN_METAL_RESIDENT";

/// Named by a host binary whose `{"open":…}` takes `minWidth` and
/// `minHeight`. A host from before refuses an open line with fields it
/// doesn't know, so a driver looks for this in the binary before sending them.
pub const OPEN_MIN_SIZE_MARKER: &str = "MIRIN_METAL_OPEN_MIN_SIZE";

/// What reaches a deferred host's window: a driver message, or a request to
/// open or hide the window.
#[derive(Debug, Clone)]
pub enum HostMessage {
    Driver(DriverMessage),
    /// `{"open": {...}}`: open the window (again, after a hide).
    Open(Box<NativeUiOptions>),
    /// `{"hide": true}`: close the window, keep the host and its newest tree.
    Hide,
}

/// Open the native window and hand the calling thread to GPUI's event loop.
/// Blocks until the app quits; call on the process main thread. A window
/// opens on the driver's first tree (`FirstTree`), or on `initial_tree` when
/// none comes within `FIRST_TREE_WAIT`; a desktop surface opens on
/// `initial_tree` at once. New trees sent on `updates` replace the rendered
/// tree (last write wins); node interactions are reported on `events`.
pub fn run(
    mut options: NativeUiOptions,
    initial_tree: NodeSpec,
    updates: mpsc::Receiver<DriverMessage>,
    events: mpsc::Sender<NativeUiEvent>,
) {
    crate::gpui_api::application()
        .with_assets(MetalAssets)
        .run(move |cx: &mut App| {
            let (access, asked) = futures::channel::mpsc::unbounded();
            let mut messages = bridge(updates, HostMessage::Driver);
            cx.spawn(async move |cx| {
                // A lock screen must lock now, and a layer surface's stand-in
                // is transparent: only windows wait for the app.
                let mut first = if options.surface.is_none() {
                    FirstTree::wait(&mut messages, FIRST_TREE_WAIT, cx).await
                } else {
                    FirstTree::default()
                };
                if let Some(title) = first.title.take() {
                    options.title = title.into();
                }
                let (tree, placeholder) = match first.tree.take() {
                    Some(tree) => (tree, false),
                    None => (Document::new(initial_tree), true),
                };
                for reason in std::mem::take(&mut first.resyncs) {
                    ask_resync(&events, reason);
                }
                let opened = crate::gpui_api::update(cx, |cx| {
                    open_window(
                        cx,
                        &options,
                        tree,
                        placeholder,
                        events.clone(),
                        access.clone(),
                    )
                })
                .flatten();
                let Some(window) = opened else {
                    crate::gpui_api::update(cx, |cx| cx.quit());
                    return;
                };
                let mut drive = Drive::new(Some(window), events, None, access);
                drive.desynced = first.desynced;
                if !first.rest.is_empty() && !drive.turn(first.rest, cx).await {
                    return;
                }
                drive.run(messages, asked, cx).await;
            })
            .detach();
        });
}

/// How long a window waits for the driver's first tree before it opens on
/// the host's stand-in (a driver that is slow to start, or never draws).
const FIRST_TREE_WAIT: Duration = Duration::from_millis(2000);

/// What the driver sent before its window opened. A window opens on the
/// driver's first tree, so the first frame the compositor shows is the app,
/// not the host's dark stand-in followed by the app a moment later.
#[derive(Default)]
struct FirstTree {
    /// The newest tree with the patches after it applied, to open on.
    tree: Option<Document>,
    /// A patch failed: later ones are dropped until a whole tree comes.
    desynced: bool,
    /// Why patches failed, for the driver once the window is up (`resync`).
    resyncs: Vec<String>,
    /// The newest title, to open with.
    title: Option<String>,
    /// Everything else, in order, for the window once it is open.
    rest: Vec<HostMessage>,
}

impl FirstTree {
    fn take(&mut self, message: HostMessage) {
        match message {
            HostMessage::Driver(DriverMessage::Tree(tree)) => {
                self.tree = Some(Document::new(*tree));
                self.desynced = false;
            }
            HostMessage::Driver(DriverMessage::Patch(ops)) => {
                if let Err(error) = patch_held(&mut self.tree, &mut self.desynced, ops) {
                    self.resyncs.push(error.to_string());
                }
            }
            HostMessage::Driver(DriverMessage::Title(title)) => self.title = Some(title),
            other => self.rest.push(other),
        }
    }

    /// Wait for the driver's first tree, up to `limit`, and take what came
    /// with it (the newest tree wins). Gives up early when the driver goes.
    async fn wait(
        messages: &mut UnboundedReceiver<HostMessage>,
        limit: Duration,
        cx: &mut AsyncApp,
    ) -> Self {
        let started = std::time::Instant::now();
        let mut first = Self::default();
        let mut timer = std::pin::pin!(cx.background_executor().timer(limit));
        while first.tree.is_none() {
            match futures::future::select(messages.next(), timer.as_mut()).await {
                futures::future::Either::Left((Some(message), _)) => first.take(message),
                // The driver went away, or is slow: open on the stand-in.
                futures::future::Either::Left((None, _)) | futures::future::Either::Right(_) => {
                    break
                }
            }
        }
        while let Ok(message) = messages.try_recv() {
            first.take(message);
        }
        let waited = started.elapsed().as_secs_f64() * 1000.0;
        if first.tree.is_some() {
            crate::trace::log(format_args!(
                "window opens on the driver's first tree, after waiting {waited:.0}ms"
            ));
        } else {
            crate::trace::log(format_args!(
                "no tree from the driver in {waited:.0}ms: the window opens on the stand-in"
            ));
        }
        first
    }
}

/// `run` for a deferred host: GPUI (the GPU context, the fonts) starts at
/// once with no window, and `messages` opens it (`HostMessage::Open`), hides
/// it, and opens it again, for as long as the host lives. `initial_for` gives
/// the tree an open shows before the driver's first. Quits if `messages`
/// closes while no window is shown, and when the window is closed by anything
/// but a hide (the person, the compositor).
pub fn run_deferred(
    initial_for: fn(&NativeUiOptions) -> NodeSpec,
    messages: mpsc::Receiver<HostMessage>,
    events: mpsc::Sender<NativeUiEvent>,
) {
    crate::gpui_api::application()
        .with_assets(MetalAssets)
        .run(move |cx: &mut App| {
            // A hide closes the last window; the loop must go on without one.
            crate::gpui_api::keep_running_without_windows(cx);
            let hiding = Rc::new(Cell::new(false));
            let watch = hiding.clone();
            crate::gpui_api::on_window_closed(cx, move |cx| {
                if !watch.replace(false) {
                    cx.quit();
                }
            })
            .detach();
            crate::trace::log(format_args!("{RESIDENT_MARKER}: deferred host started"));
            let messages = bridge(messages, |message| message);
            let (access, asked) = futures::channel::mpsc::unbounded();
            let drive = Drive::new(
                None,
                events,
                Some(Resident {
                    initial_for,
                    hiding,
                }),
                access,
            );
            cx.spawn(async move |cx| drive.run(messages, asked, cx).await)
                .detach();
        });
}

/// Move messages from a std channel (a reader thread) into an async one, so
/// the window wakes as soon as one lands instead of polling on a timer.
fn bridge<T: Send + 'static, M: Send + 'static>(
    from: mpsc::Receiver<T>,
    wrap: fn(T) -> M,
) -> UnboundedReceiver<M> {
    let (tx, rx) = futures::channel::mpsc::unbounded::<M>();
    std::thread::spawn(move || {
        while let Ok(message) = from.recv() {
            if tx.unbounded_send(wrap(message)).is_err() {
                break;
            }
        }
    });
    rx
}

/// Open the window for `options`, drawing `tree` on its first frame
/// (`placeholder` when it is the host's stand-in, not the driver's); None
/// (logged) when the platform refused it.
/// Whether scroll views paint their content at whole device pixels (GPUI
/// fork's `Window::set_scroll_snap`): the offset keeps its fraction, so a
/// touchpad's small steps add up and the scroll bar reads what it did, and
/// a scrolled frame moves what was drawn by whole pixels, which retained
/// subtrees copy (`retain.rs`). `MIRIN_METAL_SCROLL_SNAP=0` paints at the
/// offset itself, as before: for comparing the two.
fn scroll_snap() -> bool {
    std::env::var("MIRIN_METAL_SCROLL_SNAP").map_or(true, |value| value != "0")
}

fn open_window(
    cx: &mut App,
    options: &NativeUiOptions,
    tree: Document,
    placeholder: bool,
    events: mpsc::Sender<NativeUiEvent>,
    access: UnboundedSender<SimCommand>,
) -> Option<WindowHandle<RootView>> {
    let bounds = Bounds::centered(None, size(px(options.width), px(options.height)), cx);
    // Desktop surfaces (layers, a lock screen) draw over what the
    // compositor shows behind them; their tree paints its own background.
    let is_layer = options.surface.is_some();
    let unified = !is_layer && options.title_bar == TitleBar::Unified;
    let window_options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: Some(TitlebarOptions {
            title: Some(options.title.clone()),
            // The unified style: GPUI's Wayland backend asks Dashi
            // to leave the title bar to the app (forks/gpui/MIRIN.md).
            appears_transparent: unified,
            ..Default::default()
        }),
        window_background: if is_layer {
            WindowBackgroundAppearance::Transparent
        } else {
            WindowBackgroundAppearance::Opaque
        },
        app_id: options.app_id.clone(),
        // The app's own floor (`MIRIN_METAL_MIN_SIZE`): the compositor keeps
        // the window from being made smaller.
        window_min_size: options
            .min_size
            .filter(|_| !is_layer)
            .map(|(width, height)| size(px(width), px(height))),
        ..Default::default()
    };
    let window_options = crate::gpui_api::with_surface(
        window_options,
        match &options.surface {
            Some(Surface::Layer(layer)) => Some(layer),
            _ => None,
        },
        matches!(options.surface, Some(Surface::Lock)),
    );
    let layout = LayoutMap::default();
    let event_sender = EventSender::new(events, layout.clone());
    let chrome_events = event_sender.clone();
    let close_events = event_sender.clone();
    let visibility_events = event_sender.clone();
    let opened = cx.open_window(window_options, |window, cx| {
        crate::gpui_api::set_scroll_snap(window, scroll_snap());
        cx.new(|cx| RootView::new(tree, placeholder, event_sender, layout, cx))
    });
    let window = match opened {
        Ok(window) => window,
        Err(error) => {
            eprintln!("[mirin-metal] failed to open window: {error}");
            return None;
        }
    };
    crate::trace::log(format_args!(
        "window opened, {:.1}ms after the host started",
        crate::trace::since_start_ms()
    ));
    cx.activate(true);
    // GPUI's Wayland backend ignores `TitlebarOptions::title` at creation
    // (the window opened untitled); set it explicitly.
    let title = options.title.clone();
    // What a screen reader hears (`access/`); its presses come back as
    // simulated clicks. When one starts listening the window publishes its
    // tree at once, painted or not (a window out of sight paints no frame).
    let (wake, mut woken) = futures::channel::mpsc::unbounded::<()>();
    let tree_access = Accessibility::new(
        &title,
        move |command| {
            let _ = access.unbounded_send(command);
        },
        move || {
            let _ = wake.unbounded_send(());
        },
    )
    .map(|access| Rc::new(RefCell::new(access)));
    cx.spawn(async move |cx| {
        // Ends with the window, or with its tree (the adapter drops `wake`).
        while woken.next().await.is_some() {
            let woke = window.update(cx, |view, window, _cx| view.refresh_access(window));
            if woke.is_err() {
                break;
            }
        }
    })
    .detach();
    let _ = window.update(cx, |view, window, cx| {
        window.set_window_title(&title);
        view.access = tree_access;
        view.apply_pending_focus(window, cx);
    });
    // Report the chrome now and whenever the compositor moves or
    // drops its window controls (it runs once on registering).
    let requested = if unified {
        TitleBar::Unified
    } else {
        TitleBar::Standard
    };
    let _ = window.update(cx, |_view, window, _cx| {
        crate::gpui_api::observe_chrome(window, move |controls| {
            let controls = controls.map(|bounds| Controls {
                x: f32::from(bounds.origin.x),
                y: f32::from(bounds.origin.y),
                width: f32::from(bounds.size.width),
                height: f32::from(bounds.size.height),
            });
            chrome_events.chrome(Chrome::effective(requested, controls));
        });
    });
    // A driver that answers closes itself: the window stays, and the
    // driver hears of it (it ends the host to close, or asks first).
    if options.ask_to_close && !is_layer {
        let _ = window.update(cx, |_view, window, cx| {
            window.on_window_should_close(cx, move |_window, _cx| {
                close_events.close_request();
                false
            });
        });
    }
    // Out of sight (minimized, on another desktop) and back, as the
    // compositor says; only changes are reported, the window opens seen.
    let _ = window.update(cx, |_view, window, _cx| {
        crate::trace::log(format_args!(
            "{FOCUS_MARKER}: focus, press modifiers and visibility"
        ));
        let mut visible = true;
        crate::gpui_api::observe_visibility(window, move |now| {
            if now != visible {
                visible = now;
                visibility_events.visibility(now);
            }
        });
    });
    Some(window)
}

/// What a deferred host needs to open its window later and hide it.
struct Resident {
    initial_for: fn(&NativeUiOptions) -> NodeSpec,
    /// Set just before a hide removes the window, so the close it causes is
    /// not taken for the person closing it.
    hiding: Rc<Cell<bool>>,
}

/// The tree updates of one turn: the newest whole tree, then the patches
/// sent after it, in order (patches before a whole tree are moot).
#[derive(Default)]
struct Trees {
    whole: Option<NodeSpec>,
    patches: Vec<Vec<PatchOp>>,
}

impl Trees {
    fn whole(&mut self, tree: NodeSpec) {
        self.whole = Some(tree);
        self.patches.clear();
    }

    fn patch(&mut self, ops: Vec<PatchOp>) {
        self.patches.push(ops);
    }

    fn is_empty(&self) -> bool {
        self.whole.is_none() && self.patches.is_empty()
    }

    /// Apply to a window's tree (traced, for the benches); the errors of
    /// the patches that failed. After one fails, the rest are dropped until
    /// a whole tree comes.
    fn apply(self, desynced: &mut bool, view: &mut RootView, cx: &mut App) -> Vec<PatchError> {
        let mut failed = Vec::new();
        if let Some(tree) = self.whole {
            let started = std::time::Instant::now();
            view.set_tree(tree, cx);
            *desynced = false;
            crate::trace::log(format_args!(
                "tree applied in {:.2}ms",
                started.elapsed().as_secs_f64() * 1000.0
            ));
        }
        for ops in self.patches {
            if *desynced {
                crate::trace::log(format_args!("patch dropped: waiting for a whole tree"));
                continue;
            }
            let started = std::time::Instant::now();
            let count = ops.len();
            if let Err(error) = view.apply_patch(ops, cx) {
                *desynced = true;
                failed.push(error);
            }
            crate::trace::log(format_args!(
                "patch applied ({count} ops) in {:.2}ms",
                started.elapsed().as_secs_f64() * 1000.0
            ));
        }
        failed
    }
}

/// Apply a patch to a tree no window shows (before the first open, while
/// hidden); none yet, or a failed patch earlier, is an error.
fn patch_held(
    held: &mut Option<Document>,
    desynced: &mut bool,
    ops: Vec<PatchOp>,
) -> Result<(), PatchError> {
    if *desynced {
        return Ok(());
    }
    let applied = match held {
        Some(tree) => tree.apply(ops).map(|_| ()),
        None => Err(PatchError::new("a patch came before any tree")),
    };
    *desynced = applied.is_err();
    applied
}

/// Ask the driver for the whole tree: a patch didn't apply (`reason`).
fn ask_resync(events: &mpsc::Sender<NativeUiEvent>, reason: String) {
    eprintln!("[mirin-metal-host] patch refused, asking for the whole tree: {reason}");
    let _ = events.send(NativeUiEvent {
        node_id: "root".into(),
        kind: crate::events::EventKind::Resync { reason },
        bounds: None,
    });
}

/// The newest tree, title, size and unlock of one turn of messages.
#[derive(Default)]
struct Turn {
    trees: Trees,
    title: Option<String>,
    size: Option<(f32, f32)>,
    min_size: Option<(f32, f32)>,
    unlock: bool,
}

/// The window (when one is shown) and what the driver sent while none was.
struct Drive {
    window: Option<WindowHandle<RootView>>,
    events: mpsc::Sender<NativeUiEvent>,
    /// Deferred hosts only: what opening and hiding need.
    resident: Option<Resident>,
    /// The newest tree while no window is shown, drawn by the next open.
    held: Option<Document>,
    /// A patch failed and the driver was asked for the whole tree: patches
    /// are dropped until it comes (they would apply to a tree it doesn't
    /// have).
    desynced: bool,
    /// Simulated commands waiting for a later turn: a focus or press must
    /// land (and the driver's resulting tree arrive) before the commands
    /// after it, so at most one of those is performed per turn.
    pending: VecDeque<SimCommand>,
    /// Where a window's accessibility tree sends a screen reader's presses.
    access: UnboundedSender<SimCommand>,
}

impl Drive {
    fn new(
        window: Option<WindowHandle<RootView>>,
        events: mpsc::Sender<NativeUiEvent>,
        resident: Option<Resident>,
        access: UnboundedSender<SimCommand>,
    ) -> Self {
        Self {
            window,
            events,
            resident,
            held: None,
            desynced: false,
            pending: VecDeque::new(),
            access,
        }
    }

    /// Apply driver messages, coalescing to the newest tree per wake, until
    /// the driver goes away or the window does.
    /// A screen reader's presses (`asked`) are simulated clicks; they never
    /// keep the host up once the driver has gone.
    async fn run(
        mut self,
        mut messages: UnboundedReceiver<HostMessage>,
        mut asked: UnboundedReceiver<SimCommand>,
        cx: &mut AsyncApp,
    ) {
        loop {
            let mut batch = Vec::new();
            if self.pending.is_empty() {
                let next = futures::future::select(messages.next(), asked.next()).await;
                let message = match next {
                    futures::future::Either::Left((message, _)) => message,
                    futures::future::Either::Right((Some(command), _)) => {
                        Some(HostMessage::Driver(DriverMessage::Sim(command)))
                    }
                    // No window can ask any more; the driver's messages go on.
                    futures::future::Either::Right((None, _)) => messages.next().await,
                };
                match message {
                    Some(message) => batch.push(message),
                    None => {
                        // The driver went away: a shown window keeps its last
                        // tree; a host with none has nothing left to show.
                        if self.window.is_none() {
                            crate::gpui_api::update(cx, |cx| cx.quit());
                        }
                        return;
                    }
                }
            } else {
                cx.background_executor().timer(SIM_SETTLE_INTERVAL).await;
            }
            while let Ok(message) = messages.try_recv() {
                batch.push(message);
            }
            while let Ok(command) = asked.try_recv() {
                batch.push(HostMessage::Driver(DriverMessage::Sim(command)));
            }
            if !self.turn(batch, cx).await {
                return;
            }
        }
    }

    /// One wake's messages, in order. False once there is nothing left to drive.
    async fn turn(&mut self, batch: Vec<HostMessage>, cx: &mut AsyncApp) -> bool {
        let mut turn = Turn::default();
        for message in batch {
            match message {
                HostMessage::Driver(DriverMessage::Tree(tree)) => turn.trees.whole(*tree),
                HostMessage::Driver(DriverMessage::Patch(ops)) => turn.trees.patch(ops),
                HostMessage::Driver(DriverMessage::Sim(command)) => self.pending.push_back(command),
                HostMessage::Driver(DriverMessage::Unlock) => turn.unlock = true,
                HostMessage::Driver(DriverMessage::Title(title)) => turn.title = Some(title),
                HostMessage::Driver(DriverMessage::Size(width, height)) => {
                    turn.size = Some((width, height));
                }
                HostMessage::Driver(DriverMessage::MinSize(width, height)) => {
                    turn.min_size = Some((width, height));
                }
                HostMessage::Open(options) => {
                    // What came before the open is what it shows.
                    self.hold(&mut turn);
                    if !self.open(*options, cx) {
                        return false;
                    }
                }
                HostMessage::Hide => {
                    if !self.apply(std::mem::take(&mut turn), cx) {
                        return false;
                    }
                    self.hide(cx);
                }
            }
        }
        if turn.unlock {
            let Some(window) = self.window else {
                eprintln!("[mirin-metal-host] rejected line: unlock needs a shown lock surface");
                return true;
            };
            let _ = window.update(cx, |_view, window, _cx| {
                crate::gpui_api::unlock_session(window)
            });
            // Give the event loop a moment to send the unlock
            // before the process goes.
            cx.background_executor().timer(UNLOCK_FLUSH).await;
            crate::gpui_api::update(cx, |cx| cx.quit());
            return false;
        }
        self.apply(turn, cx)
    }

    /// While no window is shown, keep the turn's tree for the next open (a
    /// title is the open's to give; simulations need a window).
    fn hold(&mut self, turn: &mut Turn) {
        if self.window.is_some() {
            return;
        }
        let trees = std::mem::take(&mut turn.trees);
        if let Some(tree) = trees.whole {
            self.held = Some(Document::new(tree));
            self.desynced = false;
        }
        for ops in trees.patches {
            if let Err(error) = patch_held(&mut self.held, &mut self.desynced, ops) {
                ask_resync(&self.events, error.to_string());
            }
        }
        turn.title = None;
        turn.size = None;
        turn.min_size = None;
        if !self.pending.is_empty() {
            eprintln!("[mirin-metal-host] dropped simulated input: no window is shown");
            self.pending.clear();
        }
    }

    /// Draw the turn's tree and title, then perform the simulations due. False
    /// when the window is gone.
    fn apply(&mut self, mut turn: Turn, cx: &mut AsyncApp) -> bool {
        let Some(window) = self.window else {
            self.hold(&mut turn);
            return true;
        };
        if let Some(title) = turn.title {
            let _ = window.update(cx, |view, window, _cx| {
                window.set_window_title(&title);
                if let Some(access) = &view.access {
                    access.borrow_mut().retitle(&title);
                }
            });
        }
        // The least size first: a window grown to show a sidebar is never under it.
        if let Some((width, height)) = turn.min_size {
            let _ = window.update(cx, |_view, window, _cx| {
                window.set_window_min_size(size(px(width), px(height)));
            });
        }
        if let Some((width, height)) = turn.size {
            let _ = window.update(cx, |_view, window, _cx| {
                window.resize(size(px(width), px(height)));
            });
        }
        let mut sims = Vec::new();
        while let Some(command) = self.pending.pop_front() {
            let settles = matches!(command, SimCommand::Click { .. });
            sims.push(command);
            if settles {
                break;
            }
        }
        if turn.trees.is_empty() && sims.is_empty() {
            return true;
        }
        // Resolve while the view is leased; dispatch with only the window
        // leased, because keystrokes re-enter the view's listeners.
        let trees = turn.trees;
        let desynced = &mut self.desynced;
        let resolved = window.update(cx, |view, window, cx| {
            if !trees.is_empty() {
                let failed = trees.apply(desynced, view, cx);
                for error in failed {
                    ask_resync(&view.events.sender(), error.to_string());
                }
                view.apply_pending_focus(window, cx);
                cx.notify();
            }
            let actions: Vec<_> = sims
                .iter()
                .filter_map(|command| sim::resolve(command, view))
                .collect();
            (actions, view.events.clone())
        });
        let Ok((actions, events)) = resolved else {
            // Window is gone; nothing left to drive.
            return false;
        };
        if actions.is_empty() {
            return true;
        }
        let any_window: gpui::AnyWindowHandle = window.into();
        let dispatched = any_window.update(cx, |_root, window, cx| {
            for action in actions {
                sim::perform(action, &events, window, cx);
            }
        });
        dispatched.is_ok()
    }

    /// Open the window, drawing the newest tree the driver sent. False when
    /// the platform refused (the host quits, as it always has).
    fn open(&mut self, options: NativeUiOptions, cx: &mut AsyncApp) -> bool {
        let Some(resident) = &self.resident else {
            eprintln!("[mirin-metal-host] rejected line: the window is already open");
            return true;
        };
        if self.window.is_some() {
            eprintln!("[mirin-metal-host] rejected line: the window is already open");
            return true;
        }
        let (tree, placeholder) = match self.held.take() {
            Some(tree) => (tree, false),
            None => (Document::new((resident.initial_for)(&options)), true),
        };
        let events = self.events.clone();
        let opened = crate::gpui_api::update(cx, |cx| {
            open_window(cx, &options, tree, placeholder, events, self.access.clone())
        })
        .flatten();
        match opened {
            Some(window) => {
                self.window = Some(window);
                true
            }
            None => {
                crate::gpui_api::update(cx, |cx| cx.quit());
                false
            }
        }
    }

    /// Close the window but keep the host and the tree it showed.
    fn hide(&mut self, cx: &mut AsyncApp) {
        let Some(resident) = &self.resident else {
            eprintln!(
                "[mirin-metal-host] rejected line: hide needs a deferred host ({RESIDENT_MARKER}, MIRIN_METAL_DEFERRED=1)"
            );
            return;
        };
        let Some(window) = self.window.take() else {
            eprintln!("[mirin-metal-host] rejected line: the window is already hidden");
            return;
        };
        let hiding = resident.hiding.clone();
        let shown = window.update(cx, |view, window, _cx| {
            hiding.set(true);
            window.remove_window();
            // The window is gone; its tree (and the generations in it) is kept.
            std::mem::replace(&mut view.tree, Document::new(NodeSpec::empty()))
        });
        match shown {
            Ok(tree) => self.held = Some(tree),
            // Closed already (the person was quicker): that close quits.
            Err(_) => hiding.set(false),
        }
        if !self.pending.is_empty() {
            eprintln!("[mirin-metal-host] dropped simulated input: the window was hidden");
            self.pending.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FirstTree, HostMessage};
    use crate::sim::SimCommand;
    use crate::tree::parse_tree;
    use crate::window::DriverMessage;

    fn tree(background: &str) -> HostMessage {
        let json = format!(r#"{{"type":"view","props":{{"background":"{background}"}}}}"#);
        HostMessage::Driver(DriverMessage::Tree(Box::new(parse_tree(&json).unwrap())))
    }

    #[test]
    fn a_window_opens_on_the_newest_tree_and_title() {
        let mut first = FirstTree::default();
        first.take(HostMessage::Driver(DriverMessage::Title("Old".into())));
        first.take(tree("#000000"));
        first.take(tree("#ffffff"));
        first.take(HostMessage::Driver(DriverMessage::Title("Software".into())));
        assert_eq!(
            first.tree.as_deref(),
            parse_tree(r##"{"type":"view","props":{"background":"#ffffff"}}"##)
                .ok()
                .as_ref()
        );
        assert_eq!(first.title.as_deref(), Some("Software"));
        assert!(first.rest.is_empty());
    }

    #[test]
    fn what_needs_a_window_waits_for_it_in_order() {
        let mut first = FirstTree::default();
        first.take(HostMessage::Driver(DriverMessage::Sim(SimCommand::Layout)));
        first.take(tree("#ffffff"));
        first.take(HostMessage::Driver(DriverMessage::Unlock));
        assert!(first.tree.is_some());
        assert!(matches!(
            first.rest.as_slice(),
            [
                HostMessage::Driver(DriverMessage::Sim(SimCommand::Layout)),
                HostMessage::Driver(DriverMessage::Unlock)
            ]
        ));
    }

    fn patch(json: &str) -> HostMessage {
        HostMessage::Driver(DriverMessage::Patch(
            crate::patch::parse_patch(json).expect("test patch parses"),
        ))
    }

    fn background(first: &FirstTree) -> Option<String> {
        match first.tree.as_deref() {
            Some(crate::tree::NodeSpec::View { props, .. }) => props.background.clone(),
            _ => None,
        }
    }

    #[test]
    fn patches_before_the_window_opens_apply_until_one_fails() {
        let mut first = FirstTree::default();
        // A patch with no tree to apply to: the driver is asked for one.
        first.take(patch(r#"{"patch":[{"op":"remove","id":"x"}]}"#));
        assert_eq!(first.resyncs.len(), 1);
        let whole = r##"{"type":"view","props":{"id":"1","background":"#000000"}}"##;
        first.take(HostMessage::Driver(DriverMessage::Tree(Box::new(
            parse_tree(whole).unwrap(),
        ))));
        assert!(!first.desynced);
        let set = |color: &str| {
            patch(&format!(
                r#"{{"patch":[{{"op":"set","id":"1","node":{{"type":"view","props":{{"id":"1","background":"{color}"}}}}}}]}}"#
            ))
        };
        first.take(set("#111111"));
        assert_eq!(background(&first).as_deref(), Some("#111111"));
        // One that fails changes nothing, and the ones after it are dropped
        // until a whole tree comes.
        first.take(patch(r#"{"patch":[{"op":"remove","id":"nope"}]}"#));
        assert_eq!(first.resyncs.len(), 2);
        first.take(set("#222222"));
        assert_eq!(background(&first).as_deref(), Some("#111111"));
        first.take(HostMessage::Driver(DriverMessage::Tree(Box::new(
            parse_tree(whole).unwrap(),
        ))));
        first.take(set("#333333"));
        assert_eq!(background(&first).as_deref(), Some("#333333"));
        assert_eq!(first.resyncs.len(), 2);
    }
}
