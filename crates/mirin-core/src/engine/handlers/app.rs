use cef::*;
use std::cell::RefCell;
use std::sync::atomic::Ordering;

use super::client::MirinHandlerClient;
use super::MirinHandler;
use crate::engine::boot::{angle_backend, should_disable_gpu};
use crate::engine::config::{WindowMaterial, WindowOpts};
use crate::engine::events::emit_event;
use crate::engine::state::{self, CLIENT, NEXT_WINDOW_ID, READY, RESOURCES_PATH, STARTUP_URL};
use crate::engine::window::create_window_on_ui;

wrap_app! {
    pub struct MirinApp {
        browser_process_handler: RefCell<Option<BrowserProcessHandler>>,
    }

    impl App {
        fn on_before_command_line_processing(
            &self,
            process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            let is_browser = process_type.map(|t| t.to_string().is_empty()).unwrap_or(true);
            if let (true, Some(command_line)) = (is_browser, command_line) {
                command_line.append_switch(Some(&CefString::from("use-mock-keychain")));
                command_line.append_switch(Some(&CefString::from("allow-insecure-localhost")));
                command_line.append_switch_with_value(
                    Some(&CefString::from("disable-features")),
                    Some(&CefString::from(
                        "LocalNetworkAccessChecks,\
                         BlockInsecurePrivateNetworkRequests,\
                         PrivateNetworkAccessSendPreflights,\
                         PrivateNetworkAccessForNavigations,\
                         PrivateNetworkAccessForWorkers",
                    )),
                );
                if should_disable_gpu() {
                    command_line.append_switch(Some(&CefString::from("disable-gpu")));
                    command_line
                        .append_switch(Some(&CefString::from("disable-gpu-compositing")));
                } else if let Some(angle) = angle_backend() {
                    command_line.append_switch_with_value(
                        Some(&CefString::from("use-angle")),
                        Some(&CefString::from(angle.as_str())),
                    );
                }
                #[cfg(target_os = "linux")]
                {
                    let ozone = std::env::var("MIRIN_OZONE").ok();
                    let platform = ozone.as_deref().filter(|s| !s.is_empty()).unwrap_or("x11");
                    command_line.append_switch_with_value(
                        Some(&CefString::from("ozone-platform")),
                        Some(&CefString::from(platform)),
                    );
                    command_line.append_switch(Some(&CefString::from("ignore-gpu-blocklist")));
                    command_line.append_switch(Some(&CefString::from("enable-gpu-rasterization")));
                    command_line.append_switch(Some(&CefString::from("disable-gpu-sandbox")));
                }
            }
        }

        fn on_register_custom_schemes(&self, registrar: Option<&mut SchemeRegistrar>) {
            crate::scheme::register_app_scheme(registrar);
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            let mut handler = self.browser_process_handler.borrow_mut();
            if handler.is_none() {
                *handler = Some(MirinBrowserProcessHandler::new());
            }
            handler.clone()
        }
    }
}

wrap_browser_process_handler! {
    struct MirinBrowserProcessHandler {}

    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);

            let handler = MirinHandler::new();
            let client = MirinHandlerClient::new(handler.clone());
            CLIENT.with(|c| *c.borrow_mut() = Some(client));

            let resources = RESOURCES_PATH.with(|p| p.borrow().clone());
            if !resources.is_empty() {
                crate::scheme::register_app_factory(resources);
            }

            if state::quit_requested() {
                MirinHandler::finish_quit_if_idle(&handler);
                return;
            }

            READY.store(true, Ordering::SeqCst);
            emit_event(r#"{"type":"core.ready"}"#);

            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            if let Some(url) = STARTUP_URL.with(|u| u.borrow().clone()) {
                let id = NEXT_WINDOW_ID.fetch_add(1, Ordering::Relaxed);
                if !state::begin_window_creation(id) {
                    MirinHandler::request_quit(&handler);
                    return;
                }
                let mut opts = WindowOpts::startup(url);
                if std::env::var_os("MIRIN_SMOKE_TRANSPARENT").is_some() {
                    opts.transparent = true;
                    if std::env::var_os("MIRIN_SMOKE_MATERIAL").is_some() {
                        opts.material = Some(WindowMaterial {
                            kind: "acrylic".into(),
                            tint: None,
                            corner_radius: None,
                        });
                    }
                }
                if !create_window_on_ui(id, opts) {
                    MirinHandler::fail_window_creation(
                        &handler,
                        id,
                        "native startup browser creation failed",
                    );
                    MirinHandler::request_quit(&handler);
                }
            }
        }
    }
}
