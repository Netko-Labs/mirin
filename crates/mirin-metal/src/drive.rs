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

use sumi::{
    prelude::*, px, size, App, AsyncApp, Bounds, TitlebarOptions, WindowBackgroundAppearance,
    WindowBounds, WindowHandle, WindowOptions,
};

use crate::access::Accessibility;
use crate::events::{EventSender, NativeUiEvent};
use crate::focus::FOCUS_MARKER;
use crate::media::MetalAssets;
use crate::patch::{Document, PatchError, PatchOp};
use crate::scroll::ScrollCommand;
use crate::sim::{self, LayoutMap, SimCommand};
use crate::titlebar::{Chrome, Controls, TitleBar};
use crate::tree::NodeSpec;
use crate::window::{DriverMessage, NativeUiOptions, RootView};

/// After a simulated click, how long to wait for the driver's resulting tree
/// before performing the commands queued behind it.
const SIM_SETTLE_INTERVAL: Duration = Duration::from_millis(16);
/// Under a check (`check.rs`), how long a `settle` that drew a frame waits
/// before it looks again: long enough for the driver's lines to come in.
const CHECK_SETTLE_INTERVAL: Duration = Duration::from_millis(1);
/// How long a `settle` waits for the window before it answers that it has
/// not settled (a window the compositor never shows, an animation without
/// end).
const SETTLE_LIMIT: Duration = Duration::from_secs(20);
/// Under a check, how many frames a `settle` draws before it answers the
/// same: a minute of animation at `check::FRAME_STEP`.
const SETTLE_FRAMES: u32 = 600;
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

/// The application, on the platform the engine picks, with the engine's own
/// AccessKit adapter off: mirin's `access/` tree is the one screen readers
/// get (it is incremental and survives retained subtrees, which the engine's
/// is not and does not), so the engine's would only publish a second, empty
/// application (docs/metal/gpui-next.md, "Round 5: a small app's footprint").
fn application() -> sumi::Application {
    sumi::Application::new_inaccessible(sumi_platform::current_platform(false))
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
    application()
        .with_assets(MetalAssets)
        .run(move |cx: &mut App| {
            crate::text_mode::apply(cx);
            crate::render::warm_fonts(cx);
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
                let opened = cx.update(|cx| {
                    open_window(
                        cx,
                        &options,
                        tree,
                        placeholder,
                        events.clone(),
                        access.clone(),
                    )
                });
                let Some(window) = opened else {
                    cx.update(|cx| cx.quit());
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
    application()
        .with_assets(MetalAssets)
        .run(move |cx: &mut App| {
            crate::text_mode::apply(cx);
            // A hide closes the last window; the loop must go on without one.
            cx.set_quit_mode(sumi::QuitMode::Explicit);
            let hiding = Rc::new(Cell::new(false));
            let watch = hiding.clone();
            cx.on_window_closed(move |cx, _window| {
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

fn open_window(
    cx: &mut App,
    options: &NativeUiOptions,
    tree: Document,
    placeholder: bool,
    events: mpsc::Sender<NativeUiEvent>,
    access: UnboundedSender<SimCommand>,
) -> Option<WindowHandle<RootView>> {
    // Before the window: opening it waits for the GPU, and the fonts warm meanwhile.
    crate::render::warm_weights(tree.tree());
    let bounds = Bounds::centered(None, size(px(options.width), px(options.height)), cx);
    // Desktop surfaces (layers, a lock screen) draw over what the
    // compositor shows behind them; their tree paints its own background.
    // (`is_layer`: neither is a window, with a title bar or a least size.)
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
        // A surface the driver says it paints whole is opaque, as a window
        // is (`Surface::is_opaque`).
        window_background: match &options.surface {
            Some(surface) if !surface.is_opaque() => WindowBackgroundAppearance::Transparent,
            _ => WindowBackgroundAppearance::Opaque,
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
    let window_options = crate::surface::with_role(window_options, options.surface.as_ref(), cx);
    let layout = LayoutMap::default();
    let event_sender = EventSender::new(events, layout.clone());
    let chrome_events = event_sender.clone();
    let close_events = event_sender.clone();
    let visibility_events = event_sender.clone();
    let opened = cx.open_window(window_options, |_window, cx| {
        cx.new(|cx| RootView::new(tree, placeholder, event_sender, layout, cx))
    });
    let window = match opened {
        Ok(window) => window,
        Err(error) => {
            eprintln!("[mirin-metal] failed to open window: {error:#}");
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
        // Under a check the window hears only simulated input (`check.rs`).
        window.set_platform_input_ignored(crate::check::enabled());
        window.set_window_title(&title);
        view.access = tree_access;
        view.apply_pending_focus(window, cx);
    });
    // Report the chrome whenever the compositor shows, moves or drops
    // its window controls (on Dashi, as the window opens; elsewhere never,
    // and the driver keeps the standard style).
    let requested = if unified {
        TitleBar::Unified
    } else {
        TitleBar::Standard
    };
    let _ = window.update(cx, |_view, window, _cx| {
        window
            .observe_window_chrome(move |window, _cx| {
                let controls = window.chrome_controls().map(|bounds| Controls {
                    x: f32::from(bounds.origin.x),
                    y: f32::from(bounds.origin.y),
                    width: f32::from(bounds.size.width),
                    height: f32::from(bounds.size.height),
                });
                chrome_events.chrome(Chrome::effective(requested, controls));
            })
            .detach();
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
        // The engine reports xdg_toplevel's `suspended` as the window's
        // visibility.
        window
            .observe_window_visibility(move |visibility, _window, _cx| {
                let now = visibility.is_visible();
                if now != visible {
                    visible = now;
                    visibility_events.visibility(now);
                }
            })
            .detach();
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
    /// What the driver asked of scroll views, in order, after the turn's trees.
    scrolls: Vec<ScrollCommand>,
    unlock: bool,
}

/// How many scroll commands are kept for a window that is not shown: an
/// app that scrolls a hidden view for hours leaves the newest.
const HELD_SCROLLS: usize = 64;

/// The window (when one is shown) and what the driver sent while none was.
struct Drive {
    window: Option<WindowHandle<RootView>>,
    events: mpsc::Sender<NativeUiEvent>,
    /// Deferred hosts only: what opening and hiding need.
    resident: Option<Resident>,
    /// The newest tree while no window is shown, drawn by the next open.
    held: Option<Document>,
    /// What the driver asked of scroll views while no window is shown, in
    /// order: the next open scrolls its window so (`HELD_SCROLLS` at most).
    held_scrolls: Vec<ScrollCommand>,
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
    /// The `settle` at the head of `pending`, while it waits for the window.
    settling: Option<Settling>,
    /// This loop has stood aside for the window's own tasks since it last
    /// did anything to the window (`apply`): a `settle` looks only then.
    stood_aside: bool,
    /// What came after a `settle` that is still waiting, in order: a
    /// `settle` is about what was sent before it, so the rest waits for its
    /// answer. The frames drawn to settle are then the same however fast
    /// the driver answers the events of the first of them.
    after_settle: Vec<HostMessage>,
}

/// A `settle` waiting for the window: since when, the frames it drew, and
/// a digest of what each drew, in order (`MIRIN_METAL_TRACE_SCENE`).
struct Settling {
    since: std::time::Instant,
    frames: u32,
    drew: u64,
}

impl Settling {
    fn start() -> Self {
        Self {
            since: std::time::Instant::now(),
            frames: 0,
            drew: 0,
        }
    }

    /// Take a frame's scene digest into the digest of all of them (FNV-1a
    /// over the digests' bytes: the same in every build of the host).
    fn drew(&mut self, scene: u64) {
        let mut digest = if self.drew == 0 {
            0xcbf2_9ce4_8422_2325
        } else {
            self.drew
        };
        for byte in scene.to_le_bytes() {
            digest = (digest ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3);
        }
        self.drew = digest;
    }

    /// Whether it has waited long enough to answer that nothing settled.
    fn is_overdue(&self) -> bool {
        self.since.elapsed() > SETTLE_LIMIT || self.frames > SETTLE_FRAMES
    }
}

/// Answer a `settle`: the window settled (`quiet`), or did not in time, or
/// there is none to settle. `scene` is what its last frame drew and
/// `frames` what all the frames drawn to settle did, when the host traces
/// that.
fn tell_settled(
    events: &mpsc::Sender<NativeUiEvent>,
    quiet: bool,
    scene: Option<String>,
    frames: Option<String>,
) {
    if !quiet {
        eprintln!("[mirin-metal-host] settle: the window did not settle");
    }
    let _ = events.send(NativeUiEvent {
        node_id: "root".into(),
        kind: crate::events::EventKind::Settled {
            quiet,
            scene,
            frames,
        },
        bounds: None,
    });
}

/// Under a check: the animations that asked for the next frame are told it
/// has come, a step later on their clock (`check.rs`). Whether any had.
fn run_animations(window: &mut sumi::Window, cx: &mut App) -> bool {
    let animating = window.run_next_frame_callbacks(cx) > 0;
    if animating {
        crate::check::advance();
    }
    animating
}

/// Under a check: draw the frame the window waits for now, not when the
/// compositor next asks (it presents the last one drawn when it does).
/// Whether there was one.
fn draw_if_dirty(window: &mut sumi::Window, cx: &mut App) -> bool {
    let draws = window.is_dirty();
    if draws {
        window.draw(cx).clear(cx);
    }
    draws
}

/// The commands to perform this turn, taken off the queue: up to a click
/// (the driver's tree answering it must come before what follows), and
/// never past a `settle`, which stays at the head until the window has
/// settled. The flag is whether a `settle` is now at the head with nothing
/// before it left to perform.
fn take_due(pending: &mut VecDeque<SimCommand>) -> (Vec<SimCommand>, bool) {
    let mut due = Vec::new();
    while let Some(command) = pending.front() {
        if matches!(command, SimCommand::Settle) {
            return (due, true);
        }
        let settles = matches!(command, SimCommand::Click { .. });
        due.extend(pending.pop_front());
        if settles {
            break;
        }
    }
    (due, false)
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
            held_scrolls: Vec::new(),
            desynced: false,
            pending: VecDeque::new(),
            access,
            settling: None,
            stood_aside: false,
            after_settle: Vec::new(),
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
            if !self.settle_waits() && !self.after_settle.is_empty() {
                // The settle is answered: what waited behind it, first.
                batch = std::mem::take(&mut self.after_settle);
            } else if self.pending.is_empty() {
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
                            cx.update(|cx| cx.quit());
                        }
                        return;
                    }
                }
            } else {
                // A check's `settle` draws its frames one after another.
                let settling = matches!(self.pending.front(), Some(SimCommand::Settle));
                let interval = if settling && crate::check::enabled() {
                    CHECK_SETTLE_INTERVAL
                } else {
                    SIM_SETTLE_INTERVAL
                };
                // The timer wakes this loop behind whatever the window
                // queued for itself meanwhile.
                cx.background_executor().timer(interval).await;
                self.stood_aside = true;
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
            if self.settle_waits() {
                self.after_settle.push(message);
                continue;
            }
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
                HostMessage::Driver(DriverMessage::Scroll(command)) => turn.scrolls.push(command),
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
            let _ = window.update(cx, |_view, window, _cx| window.unlock_session());
            // Give the event loop a moment to send the unlock
            // before the process goes.
            cx.background_executor().timer(UNLOCK_FLUSH).await;
            cx.update(|cx| cx.quit());
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
        // For the window the next open makes: it opens scrolled as asked.
        self.held_scrolls.append(&mut turn.scrolls);
        let over = self.held_scrolls.len().saturating_sub(HELD_SCROLLS);
        self.held_scrolls.drain(..over);
        if !self.pending.is_empty() {
            eprintln!("[mirin-metal-host] dropped simulated input: no window is shown");
            self.drop_pending();
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
        // Whether this turn does anything to the window.
        let mut touched = turn.size.is_some() || turn.min_size.is_some();
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
        let (sims, settle) = take_due(&mut self.pending);
        if !turn.trees.is_empty() || !sims.is_empty() || !turn.scrolls.is_empty() {
            touched = true;
            if !self.perform(window, turn.trees, turn.scrolls, sims, cx) {
                return false;
            }
        }
        // What a turn does to the window may end in a task of the window's
        // own (a resize on Wayland is one). A `settle` looks only once this
        // loop has stood aside for those since the last thing it did: the
        // settle stays at the head, so the loop waits before its next turn.
        if touched {
            self.stood_aside = false;
        }
        !settle || !self.stood_aside || self.settle(window, cx)
    }

    /// Apply the turn's trees, scroll as the driver asked, and perform its
    /// simulations. False when the window is gone.
    fn perform(
        &mut self,
        window: WindowHandle<RootView>,
        trees: Trees,
        scrolls: Vec<ScrollCommand>,
        sims: Vec<SimCommand>,
        cx: &mut AsyncApp,
    ) -> bool {
        // Resolve while the view is leased; dispatch with only the window
        // leased, because keystrokes re-enter the view's listeners.
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
            for command in scrolls {
                view.scroll(command, cx);
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
        let any_window: sumi::AnyWindowHandle = window.into();
        let dispatched = any_window.update(cx, |_root, window, cx| {
            for action in actions {
                sim::perform(action, &events, window, cx);
            }
        });
        dispatched.is_ok()
    }

    /// Whether a `settle` is waiting for the window.
    fn settle_waits(&self) -> bool {
        self.pending
            .iter()
            .any(|command| matches!(command, SimCommand::Settle))
    }

    /// Drop the simulations that wait; a `settle` among them is answered
    /// (nothing settled), so its driver is not left waiting.
    fn drop_pending(&mut self) {
        let settles = self
            .pending
            .drain(..)
            .filter(|command| matches!(command, SimCommand::Settle))
            .count();
        self.settling = None;
        for _ in 0..settles {
            tell_settled(&self.events, false, None, None);
        }
    }

    /// One look at the window for the `settle` at the head of `pending`:
    /// answered and taken off once the window waits for no frame, or once
    /// it has waited too long. Under a check the frame the window waits for
    /// is drawn here, one a look, and the animations' clock moved for each
    /// an animation asked for; otherwise frames come as the platform asks
    /// for them. Before the platform's first frame the window has no size
    /// to draw at, so that one is always waited for. False when the window
    /// is gone.
    fn settle(&mut self, window: WindowHandle<RootView>, cx: &mut AsyncApp) -> bool {
        let Ok(painted) = window.update(cx, |view, _window, _cx| view.has_painted()) else {
            return false;
        };
        let settling = self.settling.get_or_insert_with(Settling::start);
        let any_window: sumi::AnyWindowHandle = window.into();
        let traced = crate::window::scene_traced().is_some();
        let waits = if !painted {
            Ok(true)
        } else if crate::check::enabled() {
            // From here on the window draws only here: every frame is one
            // a `settle` asked for, the same ones on every run. Then the
            // animations notify their views, and the frame is drawn once
            // that has taken effect, which is when the update ends.
            any_window
                .update(cx, |_root, window, cx| {
                    window.set_frames_held(true);
                    run_animations(window, cx)
                })
                .and_then(|animating| {
                    any_window
                        .update(cx, |_root, window, cx| {
                            let drew = draw_if_dirty(window, cx);
                            (drew, (drew && traced).then(|| window.last_scene_digest()))
                        })
                        .map(|(drew, scene)| {
                            if let Some(scene) = scene {
                                settling.drew(scene);
                            }
                            drew || animating
                        })
                })
        } else {
            any_window.update(cx, |_root, window, _cx| window.frame_pending())
        };
        let Ok(waits) = waits else {
            return false;
        };
        if waits {
            settling.frames += u32::from(painted && crate::check::enabled());
            if !settling.is_overdue() {
                return true;
            }
        }
        // What the frames drawn to settle drew, and the settled one, whole,
        // for a check of two hosts' drawing (`MIRIN_METAL_TRACE_SCENE`).
        let frames = (traced && crate::check::enabled()).then(|| format!("{:x}", settling.drew));
        self.settling = None;
        self.pending.pop_front();
        let scene = traced
            .then(|| {
                any_window
                    .update(cx, |_root, window, _cx| window.last_scene_digest())
                    .ok()
            })
            .flatten()
            .map(|digest| format!("{digest:016x}"));
        tell_settled(&self.events, !waits, scene, frames);
        true
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
        let opened = cx
            .update(|cx| open_window(cx, &options, tree, placeholder, events, self.access.clone()));
        match opened {
            Some(window) => {
                self.window = Some(window);
                // What was asked of its scroll views before it was there.
                let scrolls = std::mem::take(&mut self.held_scrolls);
                if !scrolls.is_empty() {
                    let _ = window.update(cx, |view, _window, cx| {
                        for command in scrolls {
                            view.scroll(command, cx);
                        }
                    });
                }
                true
            }
            None => {
                cx.update(|cx| cx.quit());
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
            self.drop_pending();
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

    #[test]
    fn a_settle_waits_for_what_came_before_it() {
        use super::take_due;
        let click = || SimCommand::Click {
            id: Some("a".into()),
            x: None,
            y: None,
        };
        let key = || SimCommand::Key {
            keystroke: "enter".into(),
        };
        let mut pending: std::collections::VecDeque<SimCommand> =
            [key(), click(), key(), SimCommand::Settle, key()].into();
        // Up to the click: the driver's answer to it comes before the rest.
        assert_eq!(take_due(&mut pending), (vec![key(), click()], false));
        // Then what is left before the settle, which now heads the queue...
        assert_eq!(take_due(&mut pending), (vec![key()], true));
        // ...and stays there, with what follows it, until it is answered.
        assert_eq!(take_due(&mut pending), (vec![], true));
        assert_eq!(pending.len(), 2);
        pending.pop_front();
        assert_eq!(take_due(&mut pending), (vec![key()], false));
        assert!(pending.is_empty());
    }

    #[test]
    fn a_settle_gives_up_on_a_window_that_never_settles() {
        use super::{Settling, SETTLE_FRAMES, SETTLE_LIMIT};
        let now = std::time::Instant::now();
        let fresh = Settling {
            frames: SETTLE_FRAMES,
            ..Settling::start()
        };
        assert!(!fresh.is_overdue());
        let animating = Settling {
            frames: SETTLE_FRAMES + 1,
            ..Settling::start()
        };
        assert!(animating.is_overdue());
        if let Some(long_ago) = now.checked_sub(SETTLE_LIMIT + std::time::Duration::from_secs(1)) {
            let unseen = Settling {
                since: long_ago,
                ..Settling::start()
            };
            assert!(unseen.is_overdue());
        }
    }

    #[test]
    fn the_frames_drawn_to_settle_are_told_apart_by_what_and_in_which_order() {
        use super::Settling;
        let drew = |scenes: &[u64]| {
            let mut settling = Settling::start();
            for scene in scenes {
                settling.drew(*scene);
            }
            settling.drew
        };
        assert_eq!(drew(&[]), 0, "no frame");
        assert_ne!(drew(&[7]), 0);
        assert_eq!(drew(&[7, 9]), drew(&[7, 9]));
        assert_ne!(drew(&[7, 9]), drew(&[9, 7]));
        assert_ne!(drew(&[7, 9]), drew(&[7]));
        assert_ne!(drew(&[7, 7]), drew(&[7]), "a frame drawn twice is two");
    }

    /// A view that asks for the next frame on each of its first frames.
    struct Fades {
        left: u32,
        drawn: std::rc::Rc<std::cell::Cell<u32>>,
    }

    impl sumi::Render for Fades {
        fn render(
            &mut self,
            window: &mut sumi::Window,
            _: &mut sumi::Context<Self>,
        ) -> impl sumi::IntoElement {
            self.drawn.set(self.drawn.get() + 1);
            if self.left > 0 {
                self.left -= 1;
                window.request_animation_frame();
            }
            sumi::div()
        }
    }

    #[sumi::test]
    fn a_settle_draws_an_animation_to_its_end(cx: &mut sumi::TestAppContext) {
        use super::{draw_if_dirty, run_animations};
        let drawn = std::rc::Rc::new(std::cell::Cell::new(0));
        let counted = drawn.clone();
        let (_view, cx) = cx.add_window_view(|_, _| Fades {
            left: 3,
            drawn: counted,
        });
        assert!(cx.update(|window, _| window.frame_pending()));
        // As `Drive::settle` does under a check: a look at a time, until
        // one finds nothing to run and nothing to draw.
        let mut looks = 0;
        loop {
            let animating = cx.update(run_animations);
            let drew = cx.update(draw_if_dirty);
            if !animating && !drew {
                break;
            }
            looks += 1;
            assert!(looks < 10, "the window never settles");
        }
        // Three frames that each asked for the next, and the one that did not.
        assert_eq!(drawn.get(), 4);
        assert!(!cx.update(|window, _| window.frame_pending()));
    }

    #[sumi::test]
    fn a_window_under_a_check_draws_nothing_for_the_platform(cx: &mut sumi::TestAppContext) {
        let drawn = std::rc::Rc::new(std::cell::Cell::new(0));
        let counted = drawn.clone();
        let (_view, cx) = cx.add_window_view(|_, _| Fades {
            left: 0,
            drawn: counted,
        });
        // The frames drawn since the last look (the test platform draws a
        // dirty window itself).
        let frames = |cx: &mut sumi::VisualTestContext| {
            cx.run_until_parked();
            cx.update(|window, cx| {
                if window.is_dirty() {
                    window.draw(cx).clear(cx);
                }
            });
            drawn.replace(0)
        };
        cx.update(|window, _| window.activate_window());
        frames(cx);
        assert!(cx.update(|window, _| window.is_window_active()));

        // A window a person uses is drawn again when the compositor takes
        // the keyboard from it, and when the pointer comes over it.
        cx.deactivate_window();
        assert!(!cx.update(|window, _| window.is_window_active()));
        assert_eq!(frames(cx), 1);
        cx.simulate_window_hover(true);
        assert_eq!(frames(cx), 1);

        // Under a check it is active whatever the compositor says, and
        // neither draws a frame: the frames are the check's alone.
        cx.update(|window, _| window.set_platform_input_ignored(true));
        assert!(cx.update(|window, _| window.is_window_active()));
        assert_eq!(frames(cx), 1, "it is drawn again, active");
        cx.update(|window, _| window.activate_window());
        cx.run_until_parked();
        cx.deactivate_window();
        cx.simulate_window_hover(false);
        cx.simulate_window_hover(true);
        assert!(cx.update(|window, _| window.is_window_active()));
        // The hover is a state of its own where the platform says it (on a Mac
        // a window is hovered when it is active, which it is here).
        if cfg!(any(
            target_os = "windows",
            target_os = "linux",
            target_os = "freebsd"
        )) {
            assert!(!cx.update(|window, _| window.is_window_hovered()));
        } else {
            assert!(cx.update(|window, _| window.is_window_hovered()));
        }
        assert_eq!(frames(cx), 0);
    }

    #[sumi::test]
    fn a_check_makes_its_window_inactive_and_active_again(cx: &mut sumi::TestAppContext) {
        let drawn = std::rc::Rc::new(std::cell::Cell::new(0));
        let counted = drawn.clone();
        let (view, cx) = cx.add_window_view(|_, _| Fades {
            left: 0,
            drawn: counted,
        });
        let frames = |cx: &mut sumi::VisualTestContext| {
            cx.run_until_parked();
            cx.update(|window, cx| {
                if window.is_dirty() {
                    window.draw(cx).clear(cx);
                }
            });
            drawn.replace(0)
        };
        let heard = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let told = heard.clone();
        cx.update(|window, _| window.set_platform_input_ignored(true));
        let _watch = view.update_in(cx, |_, window, cx| {
            cx.observe_window_activation(window, move |_, window, _| {
                told.borrow_mut().push(window.is_window_active());
            })
        });
        frames(cx);

        // The `deactivate` and `activate` window simulations.
        let simulate = |cx: &mut sumi::VisualTestContext, active| {
            cx.update(|window, cx| window.simulate_active_status(active, cx));
        };
        simulate(cx, false);
        assert!(!cx.update(|window, _| window.is_window_active()));
        assert_eq!(frames(cx), 1, "drawn again, inactive");
        // The compositor's word still is not heard: the check's holds.
        cx.update(|window, _| window.activate_window());
        cx.run_until_parked();
        assert!(!cx.update(|window, _| window.is_window_active()));
        assert_eq!(frames(cx), 0);
        // Saying what it already is draws nothing.
        simulate(cx, false);
        assert_eq!(frames(cx), 0);
        simulate(cx, true);
        assert!(cx.update(|window, _| window.is_window_active()));
        assert_eq!(frames(cx), 1, "drawn again, active");
        assert_eq!(*heard.borrow(), [false, true]);
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
