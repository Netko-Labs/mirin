//! `MIRIN_METAL_TRACE=1` timing logs on stderr. Timestamps are wall-clock
//! milliseconds since the Unix epoch, so a driver can line its own timings up
//! with the renderer's (see `packages/mirin-metal-ui/bench/native.tsx`).

use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

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
