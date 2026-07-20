//! M1 smoke test: boot CEF and open a mirin-owned window rendering a URL —
//! no Bun involved. Exercises the engine's startup-url path (docs/macos-mvp.md).
//! On macOS it must run from inside the dev `.app` bundle (scripts/dev-bundle.ts).
//!
//! Validation mode (`MIRIN_SMOKE_VALIDATE=1`): instead of staying open (or
//! relying on the blind `MIRIN_AUTOQUIT_MS` timer), watch the engine event
//! queue for the real UI boot — `core.ready` then `window.created` — with the
//! GPU process enabled, then quit. Exits 0 only when the window actually came
//! up; times out (`MIRIN_SMOKE_TIMEOUT_MS`, default 30000) with a nonzero exit
//! otherwise.

use std::ffi::CStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use mirin_core::engine::{poll_event, quit, run_core, CoreConfig};

/// Set by the watcher thread once CEF reports the startup window was created.
static WINDOW_CREATED: AtomicBool = AtomicBool::new(false);

fn main() {
    let url = std::env::var("MIRIN_SMOKE_URL").unwrap_or_else(|_| "https://example.com/".into());
    let validate = std::env::var_os("MIRIN_SMOKE_VALIDATE").is_some();
    if validate {
        if std::env::var_os("MIRIN_DISABLE_GPU").is_some() {
            eprintln!("[m1-smoke] warning: MIRIN_DISABLE_GPU set — validating software rendering, not the GPU UI path");
        }
        std::thread::spawn(watch_events);
    }
    let config = CoreConfig {
        startup_url: Some(url),
        ..Default::default()
    };
    let code = run_core(config);
    if validate && !WINDOW_CREATED.load(Ordering::SeqCst) {
        eprintln!("[m1-smoke] FAIL: message loop exited (code {code}) before window.created");
        std::process::exit(if code == 0 { 2 } else { code });
    }
    if validate {
        println!("[m1-smoke] PASS: GPU UI booted and quit cleanly (code {code})");
    }
    std::process::exit(code);
}

/// Drain the engine event queue until the startup window exists, then quit the
/// message loop. Runs off the main thread; `quit()` posts through engine tasks.
fn watch_events() {
    let timeout_ms = std::env::var("MIRIN_SMOKE_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(30_000);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut ready = false;
    while Instant::now() < deadline {
        while let Some(event) = next_event() {
            match event_type(&event).as_deref() {
                Some("core.ready") => {
                    ready = true;
                    println!("[m1-smoke] core.ready");
                }
                Some("window.created") => {
                    println!("[m1-smoke] window.created — UI is up, quitting");
                    WINDOW_CREATED.store(true, Ordering::SeqCst);
                    quit();
                    return;
                }
                _ => {}
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    eprintln!("[m1-smoke] FAIL: timed out after {timeout_ms}ms (core.ready={ready}, window.created=false)");
    quit();
}

/// Pop the next queued engine event as an owned string, or `None` when drained.
fn next_event() -> Option<String> {
    let ptr = poll_event();
    if ptr.is_null() {
        return None;
    }
    // SAFETY: poll_event returns a NUL-terminated C string kept alive in this
    // thread's CURRENT_EVENT slot until the next poll on this thread; we copy it
    // out immediately and never poll concurrently on this thread.
    Some(
        unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned(),
    )
}

/// Extract the `type` field from an engine event's JSON envelope.
fn event_type(event: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(event).ok()?;
    Some(value.get("type")?.as_str()?.to_string())
}
