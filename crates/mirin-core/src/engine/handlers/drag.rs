use cef::*;
use std::sync::{Arc, Mutex};

use super::MirinHandler;

#[cfg(target_os = "linux")]
use crate::linux;
#[cfg(target_os = "macos")]
use crate::mac;
#[cfg(target_os = "windows")]
use crate::win;

wrap_drag_handler! {
    pub struct MirinDragHandler {
        inner: Arc<Mutex<MirinHandler>>,
    }

    impl DragHandler {
        fn on_draggable_regions_changed(
            &self,
            browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            regions: Option<&[DraggableRegion]>,
        ) {
            #[cfg(target_os = "macos")]
            {
                let Some(browser) = browser else {
                    return;
                };
                let window_id = {
                    let handler = self.inner.lock().expect("failed to lock MirinHandler");
                    handler.window_ids.get(&browser.identifier()).copied()
                };
                let Some(window_id) = window_id else {
                    return;
                };
                let regions = regions
                    .unwrap_or(&[])
                    .iter()
                    .map(|r| mac::DragRegion {
                        x: r.bounds.x as f64,
                        y: r.bounds.y as f64,
                        w: r.bounds.width as f64,
                        h: r.bounds.height as f64,
                        draggable: r.draggable != 0,
                    })
                    .collect();
                mac::set_draggable_regions(window_id, regions);
            }
            #[cfg(target_os = "windows")]
            {
                let Some(browser) = browser else {
                    return;
                };
                let window_id = {
                    let handler = self.inner.lock().expect("failed to lock MirinHandler");
                    handler.window_ids.get(&browser.identifier()).copied()
                };
                let Some(window_id) = window_id else {
                    return;
                };
                let regions = regions
                    .unwrap_or(&[])
                    .iter()
                    .map(|r| win::DragRegion {
                        x: r.bounds.x as f64,
                        y: r.bounds.y as f64,
                        w: r.bounds.width as f64,
                        h: r.bounds.height as f64,
                        draggable: r.draggable != 0,
                    })
                    .collect();
                win::set_draggable_regions(window_id, regions);
            }
            #[cfg(target_os = "linux")]
            {
                let Some(browser) = browser else {
                    return;
                };
                let window_id = {
                    let handler = self.inner.lock().expect("failed to lock MirinHandler");
                    handler.window_ids.get(&browser.identifier()).copied()
                };
                let Some(window_id) = window_id else {
                    return;
                };
                let regions = regions
                    .unwrap_or(&[])
                    .iter()
                    .map(|r| {
                        (
                            r.bounds.x,
                            r.bounds.y,
                            r.bounds.width,
                            r.bounds.height,
                            r.draggable != 0,
                        )
                    })
                    .collect();
                linux::set_draggable_regions(window_id, regions);
            }
        }
    }
}
