//! mirin-helper — the CEF subprocess binary (renderer / GPU / plugin / alerts).
//! The dev-bundle script copies it into the five per-type Helper .app shells
//! (docs/architecture.md §1). Adapted from cef-rs's cefsimple_helper.
//!
//! Renderer role: inject the `window.mirin` RPC bootstrap at V8-context creation
//! (docs/architecture.md §4), using the RPC endpoint and trusted initial origin
//! passed per browser via `extra_info` from the browser process.

// On Windows, link as a GUI-subsystem binary so CEF's helper subprocesses (GPU,
// renderer, utility, …) never pop a console window. Without this, a GUI-subsystem
// host (which has no console to inherit) makes Windows allocate a fresh console
// for EACH spawned helper — a swarm of terminals. CEF passes inherited stdio, so
// logging still flows where the host points it.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod origin;

use cef::{args::Args, *};
use origin::TrustedOrigin;
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};

/// JS bootstrap defining `window.mirin` (the transport `mirin/client` expects).
/// `__PORT__` / `__TOKEN__` / `__WEBVIEW__` are substituted per browser.
const BOOTSTRAP: &str = include_str!("bootstrap.js");

#[derive(Clone)]
struct RpcEndpoint {
    port: i32,
    token: String,
    webview: i32,
    initial_origin: Option<TrustedOrigin>,
}

thread_local! {
    /// Per-browser RPC endpoint generations captured in on_browser_created and
    /// consumed in on_context_created (both run on the renderer thread). CEF
    /// may create a replacement with the same numeric id before destroying the
    /// old browser, so destruction retires the oldest generation only.
    static ENDPOINTS: RefCell<HashMap<i32, VecDeque<RpcEndpoint>>> =
        RefCell::new(HashMap::new());
}

fn register_endpoint(
    endpoints: &mut HashMap<i32, VecDeque<RpcEndpoint>>,
    browser_id: i32,
    endpoint: RpcEndpoint,
) {
    endpoints.entry(browser_id).or_default().push_back(endpoint);
}

fn current_endpoint(
    endpoints: &HashMap<i32, VecDeque<RpcEndpoint>>,
    browser_id: i32,
) -> Option<RpcEndpoint> {
    endpoints
        .get(&browser_id)
        .and_then(|generations| generations.back())
        .cloned()
}

fn retire_oldest_endpoint(endpoints: &mut HashMap<i32, VecDeque<RpcEndpoint>>, browser_id: i32) {
    let remove_browser = endpoints.get_mut(&browser_id).is_some_and(|generations| {
        generations.pop_front();
        generations.is_empty()
    });
    if remove_browser {
        endpoints.remove(&browser_id);
    }
}

fn main() {
    let args = Args::new();

    #[cfg(all(target_os = "macos", feature = "sandbox"))]
    let _sandbox = {
        let mut sandbox = cef::sandbox::Sandbox::new();
        sandbox.initialize(args.as_main_args());
        sandbox
    };

    #[cfg(target_os = "macos")]
    let _loader = {
        let loader = library_loader::LibraryLoader::new(&std::env::current_exe().unwrap(), true);
        assert!(loader.load());
        loader
    };

    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);

    let mut app = MirinHelperApp::new();
    execute_process(
        Some(args.as_main_args()),
        Some(&mut app),
        std::ptr::null_mut(),
    );
}

wrap_app! {
    struct MirinHelperApp {}

    impl App {
        // Must match mirin-core's scheme::register_app_scheme exactly: every
        // process has to register app:// with identical options or the renderer
        // won't treat it as a standard/secure origin.
        fn on_register_custom_schemes(&self, registrar: Option<&mut SchemeRegistrar>) {
            if let Some(reg) = registrar {
                // Must match mirin-core scheme::app_scheme_options exactly
                // (standard + secure + cors + fetch — SECURE gives app:// the
                // secure-context Web APIs; loopback RPC still works, see core).
                let opts = SchemeOptions::STANDARD.get_raw()
                    | SchemeOptions::SECURE.get_raw()
                    | SchemeOptions::CORS_ENABLED.get_raw()
                    | SchemeOptions::FETCH_ENABLED.get_raw();
                #[cfg(not(target_os = "windows"))]
                let opts = opts as i32;
                reg.add_custom_scheme(Some(&CefString::from("app")), opts);
            }
        }

        fn render_process_handler(&self) -> Option<RenderProcessHandler> {
            Some(MirinRenderProcessHandler::new())
        }
    }
}

wrap_render_process_handler! {
    struct MirinRenderProcessHandler {}

    impl RenderProcessHandler {
        fn on_browser_created(
            &self,
            browser: Option<&mut Browser>,
            extra_info: Option<&mut DictionaryValue>,
        ) {
            let (Some(browser), Some(dict)) = (browser, extra_info) else { return };
            let initial_url = CefString::from(&dict.string(Some(&CefString::from("initialUrl"))))
                .to_string();
            let endpoint = RpcEndpoint {
                port: dict.int(Some(&CefString::from("rpcPort"))),
                token: CefString::from(&dict.string(Some(&CefString::from("rpcToken"))))
                    .to_string(),
                webview: dict.int(Some(&CefString::from("windowId"))),
                initial_origin: TrustedOrigin::parse(&initial_url),
            };
            ENDPOINTS.with(|endpoints| {
                register_endpoint(&mut endpoints.borrow_mut(), browser.identifier(), endpoint);
            });
        }

        fn on_browser_destroyed(&self, browser: Option<&mut Browser>) {
            let Some(browser) = browser else { return };
            ENDPOINTS.with(|endpoints| {
                retire_oldest_endpoint(&mut endpoints.borrow_mut(), browser.identifier());
            });
        }

        fn on_context_created(
            &self,
            browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _context: Option<&mut V8Context>,
        ) {
            let (Some(browser), Some(frame)) = (browser, frame) else { return };
            if frame.is_main() == 0 {
                return;
            }

            let endpoint = ENDPOINTS.with(|endpoints| {
                current_endpoint(&endpoints.borrow(), browser.identifier())
            });
            let Some(endpoint) = endpoint else { return };
            let Some(initial_origin) = endpoint.initial_origin else { return };
            let current_url = CefString::from(&frame.url()).to_string();
            if !initial_origin.matches_url(&current_url) {
                return;
            }

            let script = BOOTSTRAP
                .replace("__PORT__", &endpoint.port.to_string())
                .replace("__TOKEN__", &endpoint.token)
                .replace("__WEBVIEW__", &endpoint.webview.to_string());

            frame.execute_java_script(
                Some(&CefString::from(script.as_str())),
                Some(&CefString::from("mirin://preload")),
                0,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        current_endpoint, register_endpoint, retire_oldest_endpoint, RpcEndpoint, TrustedOrigin,
    };
    use std::collections::HashMap;

    fn endpoint(token: &str) -> RpcEndpoint {
        RpcEndpoint {
            port: 1234,
            token: token.to_owned(),
            webview: 7,
            initial_origin: TrustedOrigin::parse("app://bundle/index.html"),
        }
    }

    #[test]
    fn browser_replacement_retains_the_newest_endpoint_until_its_own_destroy() {
        let mut endpoints = HashMap::new();
        register_endpoint(&mut endpoints, 9, endpoint("old"));
        register_endpoint(&mut endpoints, 9, endpoint("replacement"));

        assert_eq!(
            current_endpoint(&endpoints, 9).unwrap().token,
            "replacement"
        );
        retire_oldest_endpoint(&mut endpoints, 9);
        assert_eq!(
            current_endpoint(&endpoints, 9).unwrap().token,
            "replacement"
        );
        retire_oldest_endpoint(&mut endpoints, 9);
        assert!(current_endpoint(&endpoints, 9).is_none());
        assert!(!endpoints.contains_key(&9));
    }
}
