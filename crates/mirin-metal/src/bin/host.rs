//! mirin-metal-host: stdio bridge for the alpha React renderer.
//! The driver process (the React reconciler running in Bun — see
//! `packages/mirin-metal`) writes newline-delimited JSON element trees on
//! stdin; interaction events go back as newline-delimited JSON on stdout.
//! This stands in for the eventual in-process FFI wiring.

use std::io::{BufRead, Write};
use std::sync::mpsc;

#[cfg(target_os = "linux")]
use mirin_metal::toplevels::{self, ToplevelCommand, ToplevelUpdate, Toplevels};
use mirin_metal::{
    parse_surface, parse_tree, run, DriverMessage, EventKind, NativeUiEvent, NativeUiOptions,
    SimCommand, Surface, TitleBar,
};

/// Privileged APIs a driver can ask for (`MIRIN_METAL_CAPABILITIES`, comma
/// separated; the `capabilities` key in docs/api-design.md §1a).
const CAPABILITIES: &[&str] = &["shell.toplevels"];

/// What a stdin line asks for: the window (a tree or a simulation), or a
/// taskbar action on another window (`{"toplevel": {...}}`, needs the
/// `shell.toplevels` capability).
enum HostLine {
    Window(DriverMessage),
    #[cfg(target_os = "linux")]
    Toplevel(ToplevelCommand),
}

fn parse_host_line(line: &str) -> Result<HostLine, String> {
    // A lock surface's way out, after the driver authenticated the person.
    if line.trim_start().starts_with("{\"unlock\"") {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct UnlockLine {
            unlock: bool,
        }
        let parsed: UnlockLine = serde_json::from_str(line).map_err(|e| e.to_string())?;
        if !parsed.unlock {
            return Err("\"unlock\" must be true".into());
        }
        return Ok(HostLine::Window(DriverMessage::Unlock));
    }
    #[cfg(target_os = "linux")]
    if line.trim_start().starts_with("{\"toplevel\"") {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct ToplevelLine {
            toplevel: ToplevelCommand,
        }
        let parsed: ToplevelLine = serde_json::from_str(line).map_err(|e| e.to_string())?;
        return Ok(HostLine::Toplevel(parsed.toplevel));
    }
    parse_line(line).map(HostLine::Window)
}

/// Write one JSON line to stdout. Holding the lock for the whole line keeps
/// the event and toplevel threads from interleaving.
fn write_line(line: &serde_json::Value) -> bool {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{line}").and_then(|()| out.flush()).is_ok()
}

fn requested_capabilities() -> Vec<String> {
    let Ok(list) = std::env::var("MIRIN_METAL_CAPABILITIES") else {
        return Vec::new();
    };
    let requested: Vec<String> = list
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(String::from)
        .collect();
    if let Some(unknown) = requested
        .iter()
        .find(|name| !CAPABILITIES.contains(&name.as_str()))
    {
        eprintln!("[mirin-metal-host] MIRIN_METAL_CAPABILITIES: unknown capability \"{unknown}\"");
        std::process::exit(2);
    }
    requested
}

/// Start the `shell.toplevels` watcher; its updates go to stdout as
/// `{"type":"toplevel",...}` and `{"type":"toplevel-closed","id":N}`.
#[cfg(target_os = "linux")]
fn start_toplevels() -> Option<Toplevels> {
    let watched = toplevels::watch(|update| {
        let line = match update {
            ToplevelUpdate::Changed(toplevel) => {
                serde_json::json!({ "type": "toplevel", "toplevel": toplevel })
            }
            ToplevelUpdate::Closed(id) => {
                serde_json::json!({ "type": "toplevel-closed", "id": id })
            }
        };
        write_line(&line);
    });
    match watched {
        Ok(toplevels) => Some(toplevels),
        Err(error) => {
            eprintln!("[mirin-metal-host] shell.toplevels unavailable: {error}");
            None
        }
    }
}

/// A stdin line is either a tree or `{"sim": {...}}`.
fn parse_line(line: &str) -> Result<DriverMessage, String> {
    // Parse once: trees are large, and sim lines are recognisable by their
    // leading key (the driver writes `{"sim":…}` for them).
    if line.trim_start().starts_with("{\"sim\"") {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct SimLine {
            sim: SimCommand,
        }
        let parsed: SimLine = serde_json::from_str(line).map_err(|e| e.to_string())?;
        return Ok(DriverMessage::Sim(parsed.sim));
    }
    parse_tree(line)
        .map(|tree| DriverMessage::Tree(Box::new(tree)))
        .map_err(|e| e.to_string())
}

/// `MIRIN_METAL_PROFILE=<path>` (with `--features profiling`): sample the
/// process for `MIRIN_METAL_PROFILE_SECS` seconds (default 10) and write
/// folded stacks (`frame;frame;frame count`) to `<path>`.
#[cfg(feature = "profiling")]
fn start_profiler() {
    let Ok(path) = std::env::var("MIRIN_METAL_PROFILE") else {
        return;
    };
    let seconds = std::env::var("MIRIN_METAL_PROFILE_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(10);
    std::thread::spawn(move || {
        let guard = match pprof::ProfilerGuardBuilder::default()
            .frequency(1000)
            .build()
        {
            Ok(guard) => guard,
            Err(error) => {
                eprintln!("[mirin-metal-host] profiler failed to start: {error}");
                return;
            }
        };
        std::thread::sleep(std::time::Duration::from_secs(seconds));
        let report = match guard.report().build() {
            Ok(report) => report,
            Err(error) => {
                eprintln!("[mirin-metal-host] profiler report failed: {error}");
                return;
            }
        };
        let mut folded = String::new();
        for (frames, count) in &report.data {
            let stack: Vec<String> = frames
                .frames
                .iter()
                .rev()
                .flat_map(|symbols| symbols.iter().rev().map(|symbol| symbol.name()))
                .collect();
            folded.push_str(&format!(
                "{};{} {count}\n",
                frames.thread_name,
                stack.join(";")
            ));
        }
        match std::fs::write(&path, folded) {
            Ok(()) => eprintln!("[mirin-metal-host] profile written to {path}"),
            Err(error) => eprintln!("[mirin-metal-host] profile write failed: {error}"),
        }
    });
}

#[cfg(not(feature = "profiling"))]
fn start_profiler() {}

fn main() {
    // Asked by gpu::prefer_display_gpu, in a child of the host: answer and exit.
    #[cfg(target_os = "linux")]
    if std::env::args().nth(1).as_deref() == Some(mirin_metal::gpu::PROBE_ARG) {
        mirin_metal::gpu::answer_probe();
    }
    // Before any thread or GPUI starts: Vulkan reads this at load.
    #[cfg(target_os = "linux")]
    if let Some(filter) = mirin_metal::gpu::prefer_display_gpu() {
        mirin_metal::trace::log(format_args!("vulkan drivers limited to {filter}"));
    }
    start_profiler();
    let (update_tx, update_rx) = mpsc::channel::<DriverMessage>();
    let (event_tx, event_rx) = mpsc::channel::<NativeUiEvent>();

    let capabilities = requested_capabilities();
    #[cfg(target_os = "linux")]
    let toplevels = capabilities
        .iter()
        .any(|name| name == "shell.toplevels")
        .then(start_toplevels)
        .flatten();
    #[cfg(not(target_os = "linux"))]
    if !capabilities.is_empty() {
        eprintln!("[mirin-metal-host] capabilities are Linux only; ignoring them");
    }

    // A lock surface whose driver goes away exits at once, still locked: the
    // session must never unlock because a lock screen crashed.
    let lock_surface = std::env::var("MIRIN_METAL_SURFACE")
        .is_ok_and(|json| matches!(parse_surface(&json, ""), Ok(Surface::Lock)));

    // stdin → tree updates. EOF means the driver went away; the window simply
    // stops updating (closing it quits the process).
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let started = std::time::Instant::now();
            let parsed = parse_host_line(&line);
            mirin_metal::trace::log(format_args!(
                "line parsed ({} KB) in {:.2}ms",
                line.len() / 1024,
                started.elapsed().as_secs_f64() * 1000.0
            ));
            match parsed {
                Ok(HostLine::Window(message)) => {
                    if update_tx.send(message).is_err() {
                        break;
                    }
                }
                #[cfg(target_os = "linux")]
                Ok(HostLine::Toplevel(command)) => match &toplevels {
                    Some(toplevels) => {
                        if let Err(error) = toplevels.perform(command) {
                            eprintln!("[mirin-metal-host] toplevel action failed: {error}");
                        }
                    }
                    None => eprintln!(
                        "[mirin-metal-host] rejected line: toplevel actions need the shell.toplevels capability"
                    ),
                },
                Err(error) => eprintln!("[mirin-metal-host] rejected line: {error}"),
            }
        }
        if lock_surface {
            std::process::exit(0);
        }
    });

    // interaction events → stdout.
    std::thread::spawn(move || {
        while let Ok(event) = event_rx.recv() {
            let mut line =
                serde_json::json!({ "type": event.kind.name(), "nodeId": event.node_id });
            if let Some(value) = event.kind.value() {
                line["value"] = serde_json::Value::String(value.to_string());
            }
            if let EventKind::Hover { hovered } = &event.kind {
                line["hovered"] = serde_json::Value::Bool(*hovered);
            }
            if let EventKind::Pointer { phase, x, y, .. } = &event.kind {
                line["phase"] = serde_json::json!(phase.name());
                line["x"] = serde_json::json!(x);
                line["y"] = serde_json::json!(y);
            }
            if let Some(bounds) = &event.bounds {
                line["bounds"] = serde_json::json!({
                    "x": bounds.x, "y": bounds.y,
                    "width": bounds.width, "height": bounds.height,
                });
            }
            if let EventKind::ContextMenu { x, y } = &event.kind {
                line["x"] = serde_json::json!(x);
                line["y"] = serde_json::json!(y);
            }
            if let EventKind::Chrome(chrome) = &event.kind {
                line["titleBar"] = serde_json::json!(chrome.title_bar.name());
                line["controls"] = match &chrome.controls {
                    Some(c) => serde_json::json!({
                        "x": c.x, "y": c.y, "width": c.width, "height": c.height,
                    }),
                    None => serde_json::Value::Null,
                };
            }
            if let EventKind::Layout { nodes } = &event.kind {
                line["nodes"] = serde_json::Value::Array(
                    nodes
                        .iter()
                        .map(|node| {
                            serde_json::json!({
                                "id": node.id, "x": node.x, "y": node.y,
                                "width": node.width, "height": node.height,
                            })
                        })
                        .collect(),
                );
            }
            if !write_line(&line) {
                break;
            }
        }
    });

    let title = std::env::var("MIRIN_METAL_TITLE").unwrap_or_else(|_| "mirin metal".into());
    // `MIRIN_METAL_SURFACE=<json>` opens a layer-shell surface (a panel, a
    // dock) instead of a window; the shape is `windows.*.surface` in
    // docs/api-design.md §1a.
    let surface = match std::env::var("MIRIN_METAL_SURFACE") {
        Ok(json) => match parse_surface(&json, &title) {
            Ok(surface) => Some(surface),
            Err(error) => {
                eprintln!("[mirin-metal] MIRIN_METAL_SURFACE: {error}");
                std::process::exit(2);
            }
        },
        Err(_) => None,
    };
    // `MIRIN_METAL_TITLEBAR=unified` puts the app's own toolbar in the title
    // bar where the compositor supports it (Dashi); anything but `standard`
    // and `unified` is an error.
    let title_bar = match std::env::var("MIRIN_METAL_TITLEBAR") {
        Ok(value) => match TitleBar::parse(&value) {
            Ok(title_bar) => title_bar,
            Err(error) => {
                eprintln!("[mirin-metal] MIRIN_METAL_TITLEBAR: {error}");
                std::process::exit(2);
            }
        },
        Err(std::env::VarError::NotPresent) => TitleBar::Standard,
        Err(error) => {
            eprintln!("[mirin-metal] MIRIN_METAL_TITLEBAR: {error}");
            std::process::exit(2);
        }
    };
    // `MIRIN_METAL_SIZE=1280x820` picks the initial window size. Surfaces may
    // be thin (a 28px menu bar); windows keep a usable minimum.
    let minimum = if surface.is_some() { 1.0 } else { 200.0 };
    let (width, height) = std::env::var("MIRIN_METAL_SIZE")
        .ok()
        .and_then(|size| {
            let (w, h) = size.split_once('x')?;
            Some((w.parse::<f32>().ok()?, h.parse::<f32>().ok()?))
        })
        .filter(|(w, h)| *w >= minimum && *h >= minimum)
        .unwrap_or((
            NativeUiOptions::default().width,
            NativeUiOptions::default().height,
        ));
    // Until the driver's first tree: a dark window, or nothing for a surface
    // (a dock must not flash an opaque block).
    let initial = if surface.is_some() {
        r##"{"type":"view","props":{"fill":true}}"##
    } else {
        r##"{"type":"view","props":{"fill":true,"background":"#111114"}}"##
    };
    let initial = parse_tree(initial).expect("static initial tree is valid JSON");
    run(
        NativeUiOptions {
            title: title.into(),
            // `MIRIN_METAL_APP_ID=dev.dashi.files` names the app to the compositor.
            app_id: std::env::var("MIRIN_METAL_APP_ID")
                .ok()
                .filter(|id| !id.is_empty()),
            width,
            height,
            surface,
            title_bar,
        },
        initial,
        update_rx,
        event_tx,
    );
}
