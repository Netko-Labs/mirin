//! M1 smoke test: boot CEF and open a mirin-owned NSWindow rendering a URL —
//! no Bun involved. Exercises the engine's startup-url path (docs/macos-mvp.md).
//! Must run from inside the dev `.app` bundle (scripts/dev-bundle.ts).

use mirin_core::engine::{run_core, CoreConfig};

fn main() {
    let url = std::env::var("MIRIN_SMOKE_URL").unwrap_or_else(|_| "https://example.com/".into());
    let config = CoreConfig {
        startup_url: Some(url),
        ..Default::default()
    };
    std::process::exit(run_core(config));
}
