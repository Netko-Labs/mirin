use cef::*;

use super::state;

pub fn close_window(window_id: u32) {
    if let Some(entry) = state::remove_window(window_id) {
        if entry.window.is_closed() == 0 {
            entry.window.close();
        }
    }
}

pub fn close_all_windows() {
    for entry in state::drain_windows() {
        if entry.window.is_closed() == 0 {
            entry.window.close();
        }
    }
}

pub fn set_window_title(window_id: u32, title: &str) {
    state::with_window(window_id, |window| {
        window.set_title(Some(&CefString::from(title)));
    });
}

/// Apply a window-control verb (minimize/maximize/restore/fullscreen/focus/...).
pub fn control(window_id: u32, verb: &str) {
    state::with_window(window_id, |window| match verb {
        "minimize" => window.minimize(),
        "maximize" | "togglemaximize" => {
            if window.is_maximized() != 0 {
                window.restore();
            } else {
                window.maximize();
            }
        }
        "restore" | "unmaximize" => window.restore(),
        "fullscreen" | "togglefullscreen" => {
            window.set_fullscreen((window.is_fullscreen() == 0) as i32);
        }
        "unfullscreen" => window.set_fullscreen(0),
        "focus" | "activate" => window.activate(),
        "blur" | "deactivate" => window.deactivate(),
        "show" => window.show(),
        "hide" => window.hide(),
        "alwaysOnTop:on" | "alwaysOnTop:true" => window.set_always_on_top(1),
        "alwaysOnTop:off" | "alwaysOnTop:false" => window.set_always_on_top(0),
        _ => {}
    });
}

/// Move a window's top-left origin to screen point (x, y).
pub fn set_position(window_id: u32, x: f64, y: f64) {
    state::with_window(window_id, |window| {
        let b = window.bounds();
        window.set_bounds(Some(&Rect {
            x: x as i32,
            y: y as i32,
            width: b.width,
            height: b.height,
        }));
    });
}
