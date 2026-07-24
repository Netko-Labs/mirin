use std::sync::atomic::Ordering;

use super::config::{WindowMaterial, WindowOpts};
use super::handlers::MirinHandler;
use super::state::{self, NEXT_WINDOW_ID};
use super::tasks;

/// Allocate a window id and request creation on the UI thread. Returns the id
/// synchronously.
pub fn create_window(opts: WindowOpts) -> u32 {
    let id = NEXT_WINDOW_ID.fetch_add(1, Ordering::Relaxed);
    if !state::begin_window_creation(id) {
        schedule_quit_check();
        return 0;
    }
    if !tasks::post_create_window(id, opts) {
        let released = state::finish_window_creation(id);
        if should_schedule_quit_check(released, state::quit_requested()) {
            schedule_quit_check();
        }
        return 0;
    }
    id
}

fn schedule_quit_check() {
    if !state::quit_requested() {
        return;
    }
    if let Some(handler) = MirinHandler::instance() {
        MirinHandler::finish_quit_if_idle(&handler);
    }
}

fn should_schedule_quit_check(released: bool, quit_requested: bool) -> bool {
    released && quit_requested
}

pub fn close_window(id: u32) {
    tasks::post_window_command(id, tasks::WindowCommand::Close, None);
}

pub fn request_window_close(window_id: u32) {
    if let Some(handler) = MirinHandler::instance() {
        MirinHandler::close_browser_for_window(&handler, window_id);
    }
}

pub fn load_url(id: u32, url: String) {
    tasks::post_window_command(id, tasks::WindowCommand::LoadUrl, Some(url));
}

pub fn set_title(id: u32, title: String) {
    tasks::post_window_command(id, tasks::WindowCommand::SetTitle, Some(title));
}

pub fn quit() {
    state::request_quit();
    if let Some(handler) = MirinHandler::instance() {
        MirinHandler::request_quit(&handler);
    } else {
        tasks::post_quit();
    }
}

pub fn quit_for_update() {
    // Updater shutdown uses the same monotonic state as an ordinary explicit
    // quit. That state rejects new creations and force-closes late browsers.
    quit();
}

pub fn set_dock_visible(visible: bool) {
    tasks::post_set_dock_visible(visible);
}

pub fn window_control(id: u32, verb: String) {
    tasks::post_window_control(id, verb);
}

pub fn window_set_position(id: u32, x: f64, y: f64) {
    tasks::post_window_set_position(id, x, y);
}

pub fn window_maybe_start_drag(id: u32, x: i32, y: i32, detail: i32, ht: i32) {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    tasks::post_window_maybe_start_drag(id, x, y, detail, ht);
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let _ = (id, x, y, detail, ht);
}

pub fn set_material(id: u32, spec_json: String) {
    let material: Option<WindowMaterial> = serde_json::from_str(&spec_json).ok().flatten();
    tasks::post_set_material(id, material);
}

#[cfg(test)]
mod tests {
    use super::should_schedule_quit_check;

    #[test]
    fn creation_release_schedules_only_requested_quit_checks() {
        assert!(should_schedule_quit_check(true, true));
        assert!(!should_schedule_quit_check(true, false));
        assert!(!should_schedule_quit_check(false, true));
    }
}
