//! The `app://` scheme: serves the app's bundled web assets to webviews
//! (docs/api-design.md §1, architecture.md §4). Used by production builds; dev
//! loads the Vite server directly.
//!
//! `app://<host>/<path>` maps to `<resources_root>/<host>/<path>` — e.g. with
//! the Vite `dist/` copied to `Resources/ui/`, `app://ui/index.html` serves
//! `Resources/ui/index.html` and `app://ui/assets/x.js` serves the asset.
//!
//! The scheme is registered (name + options) in EVERY process via each App's
//! `on_register_custom_schemes`; the handler factory is registered once in the
//! browser process after context init. Keep the name/options in sync with
//! mirin-helper's registration.

use cef::*;
use std::cell::Cell;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

pub const APP_SCHEME: &str = "app";

/// Standard + secure + CORS + fetch. `SECURE` makes `app://` a secure context,
/// so pages get the secure-context-only Web APIs (`crypto.randomUUID`,
/// `crypto.subtle`, `navigator.clipboard`, WebAuthn, …). The RPC
/// `ws://127.0.0.1` still connects because loopback is "potentially trustworthy"
/// (not mixed content) and Private/Local Network Access checks are disabled in
/// the browser command line (engine `on_before_command_line_processing`, plus
/// `--allow-insecure-localhost`). Keep in sync with mirin-helper's registration.
pub fn app_scheme_options() -> i32 {
    let options = SchemeOptions::STANDARD.get_raw()
        | SchemeOptions::SECURE.get_raw()
        | SchemeOptions::CORS_ENABLED.get_raw()
        | SchemeOptions::FETCH_ENABLED.get_raw();
    #[cfg(not(target_os = "windows"))]
    let options = options as i32;
    options
}

/// Register the `app` scheme. Call from an App's `on_register_custom_schemes`.
pub fn register_app_scheme(registrar: Option<&mut SchemeRegistrar>) {
    if let Some(reg) = registrar {
        reg.add_custom_scheme(Some(&CefString::from(APP_SCHEME)), app_scheme_options());
    }
}

static RESOURCES_ROOT: Mutex<String> = Mutex::new(String::new());

/// Register the handler factory against the global request context, serving from
/// `resources_root`. Call once in the browser process after CEF init.
pub fn register_app_factory(resources_root: String) {
    *RESOURCES_ROOT.lock().expect("resources root") = resources_root;
    if let Some(ctx) = request_context_get_global_context() {
        let mut factory = AppSchemeFactory::new();
        ctx.register_scheme_handler_factory(
            Some(&CefString::from(APP_SCHEME)),
            None,
            Some(&mut factory),
        );
    }
}

wrap_scheme_handler_factory! {
    struct AppSchemeFactory {}

    impl SchemeHandlerFactory {
        fn create(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _scheme_name: Option<&CefString>,
            request: Option<&mut Request>,
        ) -> Option<ResourceHandler> {
            let url = request
                .map(|r| CefString::from(&r.url()).to_string())
                .unwrap_or_default();
            let root = RESOURCES_ROOT.lock().expect("resources root").clone();
            let (status, body, mime) = load_asset(&root, &url);
            Some(AppResourceHandler::new(status, body, mime.to_string(), Cell::new(0)))
        }
    }
}

wrap_resource_handler! {
    struct AppResourceHandler {
        status: i32,
        body: Vec<u8>,
        mime: String,
        pos: Cell<usize>,
    }

    impl ResourceHandler {
        // Synchronous in-memory handler: signal immediate handling, then CEF
        // calls response_headers + read on the same instance.
        fn open(
            &self,
            _request: Option<&mut Request>,
            handle_request: Option<&mut i32>,
            _callback: Option<&mut Callback>,
        ) -> i32 {
            if let Some(h) = handle_request {
                *h = 1;
            }
            1
        }

        fn response_headers(
            &self,
            response: Option<&mut Response>,
            response_length: Option<&mut i64>,
            _redirect_url: Option<&mut CefString>,
        ) {
            if let Some(resp) = response {
                resp.set_status(self.status);
                resp.set_mime_type(Some(&CefString::from(self.mime.as_str())));
                resp.set_header_by_name(
                    Some(&CefString::from("Cache-Control")),
                    Some(&CefString::from("no-cache")),
                    1,
                );
            }
            if let Some(len) = response_length {
                *len = self.body.len() as i64;
            }
        }

        fn read(
            &self,
            data_out: *mut u8,
            bytes_to_read: i32,
            bytes_read: Option<&mut i32>,
            _callback: Option<&mut ResourceReadCallback>,
        ) -> i32 {
            let Some(out) = bytes_read else { return 0 };
            if bytes_to_read < 1 || data_out.is_null() {
                *out = 0;
                return 0;
            }
            let pos = self.pos.get();
            let remaining = self.body.len().saturating_sub(pos);
            let n = (bytes_to_read as usize).min(remaining);
            if n == 0 {
                *out = 0;
                return 0; // EOF
            }
            // SAFETY: `data_out` was checked non-null, CEF provides at least
            // `bytes_to_read` writable bytes, and `n` is bounded by both buffers.
            unsafe {
                std::ptr::copy_nonoverlapping(self.body.as_ptr().add(pos), data_out, n);
            }
            self.pos.set(pos + n);
            *out = n as i32;
            1
        }
    }
}

/// Resolve an `app://` URL to `(status, body, mime)`. Missing files 404; a
/// missing path with no extension falls back to the host's `index.html` (SPA).
fn load_asset(root: &str, url: &str) -> (i32, Vec<u8>, &'static str) {
    let Some(rel) = url.strip_prefix("app://") else {
        return (400, b"bad request".to_vec(), "text/plain");
    };
    // Drop query/fragment.
    let rel = rel.split(['?', '#']).next().unwrap_or("");
    let rel = rel.trim_end_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };

    let base = PathBuf::from(root);
    let target = safe_join(&base, rel);
    let Some(target) = target else {
        return (403, b"forbidden".to_vec(), "text/plain");
    };

    // Directory or extensionless -> index.html (exact file first).
    let candidate = if target.is_dir() {
        target.join("index.html")
    } else {
        target
    };

    if let Ok(bytes) = std::fs::read(&candidate) {
        return (200, bytes, mime_for(&candidate));
    }

    // SPA fallback: extensionless route -> host's index.html.
    if Path::new(rel).extension().is_none() {
        if let Some(host) = rel.split('/').next() {
            let index = base.join(host).join("index.html");
            if let Ok(bytes) = std::fs::read(&index) {
                return (200, bytes, "text/html");
            }
        }
    }

    (404, b"not found".to_vec(), "text/plain")
}

/// Join `rel` under `base`, rejecting any traversal outside it.
fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            // reject .., absolute, prefix, root
            _ => return None,
        }
    }
    Some(out)
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" | "htm" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "map" => "application/json",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}
