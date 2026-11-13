//! `MIRIN_METAL_TRACE=1` timing logs on stderr. Timestamps are wall-clock
//! milliseconds since the Unix epoch, so a driver can line its own timings up
//! with the renderer's (see `packages/mirin-metal-ui/bench/native.tsx`).

use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static STARTED: OnceLock<Instant> = OnceLock::new();

/// The `log` target the GPUI fork reports its startup milestones under (the
/// text system, the GPU context, a window's renderer, a font family loaded).
const STARTUP_TARGET: &str = "mirin::startup";

/// Prints the fork's startup milestones as trace lines.
struct StartupLog;

impl log::Log for StartupLog {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.target() == STARTUP_TARGET
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            log(format_args!(
                "startup: {}, {:.1}ms after the host started",
                record.args(),
                since_start_ms()
            ));
        }
    }

    fn flush(&self) {}
}

/// Note when the host started (first thing in `main`); later calls keep the
/// first. With tracing on, the GPUI fork's startup milestones are traced too.
pub fn mark_start() {
    STARTED.get_or_init(Instant::now);
    if enabled() && log::set_logger(&StartupLog).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}

/// Milliseconds since `mark_start` (since the first call, if it never ran).
pub fn since_start_ms() -> f64 {
    STARTED.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// Whether tracing is on for this process.
pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("MIRIN_METAL_TRACE").is_ok_and(|v| v == "1"))
}

/// Log one trace line when tracing is on.
pub fn log(message: std::fmt::Arguments<'_>) {
    if enabled() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0);
        eprintln!("[mirin-metal trace] {now:.1} {message}");
    }
}
