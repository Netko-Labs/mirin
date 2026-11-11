// mirin: this file is mirin's (see MIRIN.md): which events anything on the
// accessibility bus registered for, so signals nobody would get are not
// made, and how many signals were made.

//! AT-SPI clients say which events they want (`Registry.RegisterEvent`), and
//! toolkits send only those: at-spi2-atk asks the registry who listens
//! (`GetRegisteredEvents`) and follows `EventListenerRegistered` and
//! `EventListenerDeregistered`. AccessKit sends every event. For most that
//! costs little, but bounds change in bulk (a window resized, a list
//! reflowed: one signal a node), so `object:bounds-changed` is sent only
//! while something registered for it. What a client reads is not affected:
//! extents are answered from the tree when asked.

use atspi::proxy::registry::RegistryProxy;
use futures_lite::StreamExt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use zbus::{Connection, MatchRule, MessageStream, message::Type};

/// Whether something registered for bounds changes. True until the registry
/// says who listens, and whenever it cannot be asked: as upstream then.
static BOUNDS_HEARD: AtomicBool = AtomicBool::new(true);

/// The signals handed to the bus so far (events and cache changes).
static SIGNALS: AtomicU64 = AtomicU64::new(0);

pub(crate) fn bounds_heard() -> bool {
    BOUNDS_HEARD.load(Ordering::Relaxed)
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

/// Follow who listens for bounds changes for as long as the connection
/// lives. On any failure bounds changes are sent, as upstream.
pub(crate) async fn follow_bounds_listeners(conn: Connection) {
    BOUNDS_HEARD.store(true, Ordering::Relaxed);
    let _ = follow(&conn).await;
    BOUNDS_HEARD.store(true, Ordering::Relaxed);
}

async fn follow(conn: &Connection) -> zbus::Result<()> {
    let registry = RegistryProxy::new(conn).await?;
    // Subscribed before the first ask, so no registration falls between.
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .interface("org.a11y.atspi.Registry")?
        .build();
    let mut changes = MessageStream::for_match_rule(rule, conn, None).await?;
    loop {
        let events = registry.registered_events().await?;
        let heard = events.iter().any(|(_, event)| hears_bounds(event));
        BOUNDS_HEARD.store(heard, Ordering::Relaxed);
        // Any registration or deregistration: ask again.
        if changes.next().await.is_none() {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::hears_bounds;

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
