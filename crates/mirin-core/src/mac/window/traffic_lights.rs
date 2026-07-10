use objc2_app_kit::NSWindowButton;
use objc2_foundation::NSPoint;
use std::cell::RefCell;
use std::collections::HashMap;

use super::state::with_window;

thread_local! {
    /// Requested traffic-light inset (x, y) per window, re-applied on resize.
    static TRAFFIC_LIGHTS: RefCell<HashMap<u32, (f64, f64)>> = RefCell::new(HashMap::new());
}

/// Set (and apply) the traffic-light inset for a custom-title-bar window. Follows
/// the Tauri/decorum model: the title bar container is grown to `button_height +
/// y` and the three buttons are centered in it, inset `x` from the left. Stored
/// so it can be re-applied on resize (macOS resets button positions). Main thread.
pub fn set_traffic_light_position(id: u32, x: f64, y: f64) {
    TRAFFIC_LIGHTS.with(|t| {
        t.borrow_mut().insert(id, (x, y));
    });
    apply_traffic_light_position(id);
}

/// Re-apply the stored traffic-light inset for `id`, if any. Main thread only.
pub(super) fn apply_traffic_light_position(id: u32) {
    let Some((x, y)) = TRAFFIC_LIGHTS.with(|t| t.borrow().get(&id).copied()) else {
        return;
    };
    with_window(id, |window| {
        let buttons = [
            window.standardWindowButton(NSWindowButton::CloseButton),
            window.standardWindowButton(NSWindowButton::MiniaturizeButton),
            window.standardWindowButton(NSWindowButton::ZoomButton),
        ];
        let [Some(close), Some(mini), Some(zoom)] = buttons else {
            return;
        };
        let button_height = close.frame().size.height;
        let title_bar_height = button_height + y;

        // Grow the title bar container to the target height, pinned to the top,
        // so the buttons can sit centered within a taller custom title bar.
        if let Some(titlebar) = unsafe { close.superview() } {
            if let Some(container) = unsafe { titlebar.superview() } {
                let win_h = window.frame().size.height;
                let mut f = container.frame();
                f.size.height = title_bar_height;
                f.origin.y = win_h - title_bar_height;
                container.setFrame(f);
            }
        }

        const SPACE: f64 = 20.0;
        for (i, btn) in [&close, &mini, &zoom].into_iter().enumerate() {
            let origin = NSPoint::new(
                x + i as f64 * SPACE,
                (title_bar_height - button_height) / 2.0 - 4.0,
            );
            btn.setFrameOrigin(origin);
        }
    });
}
