use cef::*;
use std::cell::RefCell;
use std::sync::{Arc, Mutex};

use super::config::{WindowMaterial, WindowOpts};
use super::handlers::MirinHandler;
use super::state;
use super::window::create_window_on_ui;
#[cfg(target_os = "macos")]
use super::window::material_opts;
#[cfg(target_os = "windows")]
use super::window::parse_hex_rgba;

#[cfg(target_os = "linux")]
use crate::linux;
#[cfg(target_os = "macos")]
use crate::mac;
#[cfg(target_os = "windows")]
use crate::win;

pub(crate) fn post_create_window(id: u32, opts: WindowOpts) -> bool {
    let mut task = CreateWindowTask::new(id, RefCell::new(Some(opts)));
    post_task(ThreadId::UI, Some(&mut task)) != 0
}

pub(crate) fn post_window_command(id: u32, command: WindowCommand, arg: Option<String>) {
    let mut task = WindowCommandTask::new(id, command, RefCell::new(arg));
    post_task(ThreadId::UI, Some(&mut task));
}

pub(crate) fn post_close_all_browsers(inner: Arc<Mutex<MirinHandler>>, force_close: bool) {
    let mut task = CloseAllBrowsers::new(inner, force_close);
    post_task(ThreadId::UI, Some(&mut task));
}

pub(crate) fn post_request_quit(inner: Arc<Mutex<MirinHandler>>) {
    let mut task = RequestQuitTask::new(inner);
    post_task(ThreadId::UI, Some(&mut task));
}

pub(crate) fn post_quit() {
    let mut task = QuitTask::new();
    post_task(ThreadId::UI, Some(&mut task));
}

pub(crate) fn post_set_dock_visible(visible: bool) {
    let mut task = SetDockVisibleTask::new(visible);
    post_task(ThreadId::UI, Some(&mut task));
}

pub(crate) fn post_window_control(id: u32, verb: String) {
    let mut task = WindowControlTask::new(id, RefCell::new(Some(verb)));
    post_task(ThreadId::UI, Some(&mut task));
}

pub(crate) fn post_window_set_position(id: u32, x: f64, y: f64) {
    let mut task = WindowSetPositionTask::new(id, x, y);
    post_task(ThreadId::UI, Some(&mut task));
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(crate) fn post_window_maybe_start_drag(id: u32, x: i32, y: i32, detail: i32, ht: i32) {
    let mut task = WindowMaybeStartDragTask::new(id, x, y, detail, ht);
    post_task(ThreadId::UI, Some(&mut task));
}

pub(crate) fn post_set_material(id: u32, material: Option<WindowMaterial>) {
    let mut task = SetMaterialTask::new(id, RefCell::new(Some(material)));
    post_task(ThreadId::UI, Some(&mut task));
}

#[derive(Clone)]
pub(crate) enum WindowCommand {
    Close,
    LoadUrl,
    SetTitle,
}

wrap_task! {
    struct CreateWindowTask {
        id: u32,
        opts: RefCell<Option<WindowOpts>>,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            if state::quit_requested() {
                state::finish_window_creation();
                if let Some(handler) = MirinHandler::instance() {
                    MirinHandler::finish_quit_if_idle(&handler);
                }
                return;
            }
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            if let Some(opts) = self.opts.borrow_mut().take() {
                create_window_on_ui(self.id, opts);
            }
        }
    }
}

wrap_task! {
    struct WindowCommandTask {
        id: u32,
        command: WindowCommand,
        arg: RefCell<Option<String>>,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            let id = self.id;
            match self.command {
                WindowCommand::Close => {
                    if let Some(handler) = MirinHandler::instance() {
                        MirinHandler::close_browser_for_window(&handler, id);
                    }
                }
                WindowCommand::LoadUrl => {
                    if let Some(url) = self.arg.borrow().as_ref() {
                        if let Some(handler) = MirinHandler::instance() {
                            MirinHandler::load_url_for_window(&handler, id, url);
                        }
                    }
                }
                WindowCommand::SetTitle => {
                    #[cfg(target_os = "macos")]
                    if let Some(title) = self.arg.borrow().as_ref() {
                        mac::set_window_title(id, title);
                    }
                    #[cfg(target_os = "windows")]
                    if let Some(title) = self.arg.borrow().as_ref() {
                        win::set_window_title(id, title);
                    }
                    #[cfg(target_os = "linux")]
                    if let Some(title) = self.arg.borrow().as_ref() {
                        linux::set_window_title(id, title);
                    }
                }
            }
        }
    }
}

wrap_task! {
    struct CloseAllBrowsers {
        inner: Arc<Mutex<MirinHandler>>,
        force_close: bool,
    }
    impl Task {
        fn execute(&self) {
            MirinHandler::close_all_browsers(&self.inner, self.force_close);
        }
    }
}

wrap_task! {
    struct RequestQuitTask {
        inner: Arc<Mutex<MirinHandler>>,
    }
    impl Task {
        fn execute(&self) {
            MirinHandler::request_quit(&self.inner);
        }
    }
}

wrap_task! {
    struct QuitTask {}
    impl Task {
        fn execute(&self) {
            if let Some(handler) = MirinHandler::instance() {
                MirinHandler::request_quit(&handler);
            } else {
                #[cfg(target_os = "macos")]
                mac::close_all_windows();
                #[cfg(target_os = "windows")]
                win::close_all_windows();
                #[cfg(target_os = "linux")]
                linux::close_all_windows();
                quit_message_loop();
            }
        }
    }
}

wrap_task! {
    struct SetDockVisibleTask {
        visible: bool,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            #[cfg(target_os = "macos")]
            mac::app::set_dock_visible(self.visible);
            #[cfg(not(target_os = "macos"))]
            let _ = self.visible;
        }
    }
}

wrap_task! {
    struct WindowControlTask {
        id: u32,
        verb: RefCell<Option<String>>,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            #[cfg(target_os = "macos")]
            if let Some(verb) = self.verb.borrow_mut().take() {
                mac::window::control(self.id, &verb);
            }
            #[cfg(target_os = "windows")]
            if let Some(verb) = self.verb.borrow_mut().take() {
                win::control(self.id, &verb);
            }
            #[cfg(target_os = "linux")]
            if let Some(verb) = self.verb.borrow_mut().take() {
                linux::control(self.id, &verb);
            }
        }
    }
}

wrap_task! {
    struct WindowSetPositionTask {
        id: u32,
        x: f64,
        y: f64,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            #[cfg(target_os = "macos")]
            mac::window::set_position(self.id, self.x, self.y);
            #[cfg(target_os = "windows")]
            win::set_position(self.id, self.x, self.y);
            #[cfg(target_os = "linux")]
            linux::set_position(self.id, self.x, self.y);
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
wrap_task! {
    struct WindowMaybeStartDragTask {
        id: u32,
        x: i32,
        y: i32,
        detail: i32,
        ht: i32,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            #[cfg(target_os = "windows")]
            win::maybe_start_drag(self.id, self.x, self.y, self.detail, self.ht);
            #[cfg(target_os = "linux")]
            linux::maybe_start_drag(self.id, self.x, self.y, self.detail, self.ht);
        }
    }
}

wrap_task! {
    struct SetMaterialTask {
        id: u32,
        material: RefCell<Option<Option<WindowMaterial>>>,
    }
    impl Task {
        fn execute(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);
            #[cfg(target_os = "macos")]
            if let Some(material) = self.material.borrow_mut().take() {
                let mtm = objc2::MainThreadMarker::new().expect("UI thread");
                mac::osr::set_material(mtm, self.id, material.as_ref().map(material_opts));
            }
            #[cfg(target_os = "windows")]
            if let Some(material) = self.material.borrow_mut().take() {
                match material {
                    Some(m) if m.kind != "none" && !m.kind.is_empty() => {
                        let tint = m.tint.as_deref().and_then(parse_hex_rgba);
                        win::osr::set_material(self.id, true, tint);
                    }
                    _ => win::osr::set_material(self.id, false, None),
                }
            }
        }
    }
}
