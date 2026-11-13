// mirin: this file is mirin's (see MIRIN.md): which events anything on the
// accessibility bus registered for, so signals nobody would get are not
// made, and how many signals were made.

//! AT-SPI clients say which events they want (`Registry.RegisterEvent`), and
//! toolkits send only those: at-spi2-atk asks the registry who listens
//! (`GetRegisteredEvents`). AccessKit sends every event. For most that costs
//! little, but bounds change in bulk (a window resized, a list reflowed: one
//! signal a node), so `object:bounds-changed` is sent only while something
//! registered for it. What a client reads is not affected: extents are
//! answered from the tree when asked.
//!
//! The registry is asked when bounds change, at most once in `ASK_EVERY`:
//! nothing follows its signals (a stream on the bus's connection outlives
//! the connection's own tasks when accessibility is turned off, and keeps
//! the application on the bus, answering nobody), and nothing wakes while
//! nothing moves. A client that registers for bounds changes hears them
//! from the next ask on.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use zbus::Connection;

/// How long an answer from the registry stands while bounds keep changing.
const ASK_EVERY: Duration = Duration::from_secs(1);

/// Whether something registered for bounds changes. True until the registry
/// says who listens, and whenever it cannot be asked: as upstream then.
static BOUNDS_HEARD: AtomicBool = AtomicBool::new(true);

/// When the registry was last asked, in ms on `clock` (0: not yet).
static ASKED: AtomicU64 = AtomicU64::new(0);

/// The signals handed to the bus so far (events and cache changes).
static SIGNALS: AtomicU64 = AtomicU64::new(0);

/// Milliseconds since the first call, never 0.
fn clock() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

/// What to do with a bounds change.
pub(crate) struct BoundsChange {
    /// Something listens (as far as is known): send it.
    pub(crate) send: bool,
    /// The registry's last answer is old: ask it again.
    pub(crate) ask: bool,
}

/// A node's bounds changed: whether the signal goes out, and whether it is
/// time to ask the registry again who listens.
pub(crate) fn bounds_changed() -> BoundsChange {
    let (now, asked) = (clock(), ASKED.load(Ordering::Relaxed));
    let ask = asked == 0 || now.saturating_sub(asked) > ASK_EVERY.as_millis() as u64;
    if ask {
        ASKED.store(now, Ordering::Relaxed);
    }
    BoundsChange {
        send: BOUNDS_HEARD.load(Ordering::Relaxed),
        ask,
    }
}

/// A new connection to the bus: bounds changes are sent until its registry
/// is asked (`Bus::new` asks at once).
pub(crate) fn forget() {
    BOUNDS_HEARD.store(true, Ordering::Relaxed);
    ASKED.store(0, Ordering::Relaxed);
}

pub(crate) fn count_signal() {
    SIGNALS.fetch_add(1, Ordering::Relaxed);
}

/// How many AT-SPI signals this process has queued for the accessibility
/// bus since it started (events and cache changes, for every adapter): the
/// difference across an update is what that update tells the bus.
pub fn signals_queued() -> u64 {
    SIGNALS.load(Ordering::Relaxed)
}

/// Ask the registry who listens. On any failure bounds changes are sent, as
/// upstream.
pub(crate) async fn ask(conn: &Connection) {
    let heard = match registered(conn).await {
        Ok(events) => events.iter().any(|(_, event)| hears_bounds(event)),
        Err(_) => true,
    };
    BOUNDS_HEARD.store(heard, Ordering::Relaxed);
    ASKED.store(clock(), Ordering::Relaxed);
}

/// `Registry.GetRegisteredEvents`: each listener's bus name and event. A
/// plain call: a proxy would keep streams on the connection.
async fn registered(conn: &Connection) -> zbus::Result<Vec<(String, String)>> {
    let reply = conn
        .call_method(
            Some("org.a11y.atspi.Registry"),
            "/org/a11y/atspi/registry",
            Some("org.a11y.atspi.Registry"),
            "GetRegisteredEvents",
            &(),
        )
        .await?;
    reply.body().deserialize()
}

/// Whether a registration for `event` ("object:bounds-changed",
/// "Object:BoundsChanged", "object", "object:", "*", "") takes in bounds
/// changes: the class and the event, however they are spelled.
fn hears_bounds(event: &str) -> bool {
    let spelled: String = event
        .chars()
        .filter(|c| !matches!(c, '-' | '_'))
        .flat_map(char::to_lowercase)
        .collect();
    let mut parts = spelled.split(':');
    let class = parts.next().unwrap_or_default();
    let major = parts.next().unwrap_or_default();
    matches!(class, "" | "*" | "object") && matches!(major, "" | "*" | "boundschanged")
}

#[cfg(test)]
mod tests {
    use super::{bounds_changed, forget, hears_bounds};

    #[test]
    fn the_registry_is_asked_once_in_a_while() {
        forget();
        let first = bounds_changed();
        assert!(first.send && first.ask, "nobody was asked yet");
        let next = bounds_changed();
        assert!(next.send && !next.ask, "the answer is on its way");
    }

    #[test]
    fn a_registration_takes_in_bounds_by_class_and_event() {
        for event in [
            "object:bounds-changed",
            "Object:BoundsChanged",
            "object:bounds-changed:",
            "object",
            "object:",
            "Object:",
            "*",
            "",
        ] {
            assert!(hears_bounds(event), "{event}");
        }
        for event in [
            "Object:StateChanged:Focused",
            "object:state-changed",
            "object:text-caret-moved",
            "window:activate",
            "window",
            "focus:",
            "document:load-complete",
        ] {
            assert!(!hears_bounds(event), "{event}");
        }
    }
}
