//! Give freed memory back to the system once a window has gone quiet.
//!
//! glibc keeps most of what a process frees for its next allocation, and a
//! host frees a good deal as it starts (the parsed shaders, the driver's
//! lines, the font scan) and after every busy spell (a large tree replaced).
//! A resident app then sits idle holding it. `malloc_trim` hands whole free
//! pages back; it runs on a background thread a few seconds after the last
//! frame, once per busy spell, and an idle window schedules nothing.

use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use gpui::App;

/// How long after its last frame a window counts as quiet.
const QUIET: Duration = Duration::from_secs(3);

/// A window's frames, counted so that the first quiet spell after them
/// trims the heap.
#[derive(Clone, Default)]
pub(crate) struct IdleTrim {
    frames: Rc<Cell<u64>>,
    waiting: Rc<Cell<bool>>,
}

impl IdleTrim {
    /// A frame was drawn. Starts the wait for a quiet spell unless one is
    /// already waiting (it sees this frame and waits again).
    pub(crate) fn frame_drawn(&self, cx: &App) {
        self.frames.set(self.frames.get() + 1);
        if self.waiting.replace(true) {
            return;
        }
        let this = self.clone();
        cx.spawn(async move |cx| {
            loop {
                let seen = this.frames.get();
                cx.background_executor().timer(QUIET).await;
                if this.frames.get() == seen {
                    break;
                }
            }
            this.waiting.set(false);
            cx.background_executor().spawn(async { trim() }).detach();
        })
        .detach();
    }
}

/// Return the heap's free pages to the kernel.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn trim() {
    extern "C" {
        fn malloc_trim(pad: usize) -> std::ffi::c_int;
    }
    let started = std::time::Instant::now();
    // SAFETY: glibc's `malloc_trim` takes no pointer and may run on any
    // thread beside allocations: it locks each arena in turn and only
    // releases pages that hold no live allocation.
    let released = unsafe { malloc_trim(0) };
    crate::trace::log(format_args!(
        "idle: heap trimmed in {:.2}ms (released: {})",
        started.elapsed().as_secs_f64() * 1000.0,
        released == 1
    ));
}

/// Other allocators keep their own counsel.
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
fn trim() {}
