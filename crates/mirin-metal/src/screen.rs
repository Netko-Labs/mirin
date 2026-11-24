//! The screen a desktop surface names (`"output": "HDMI-A-1"`, a layer
//! surface's or a lock surface's): it opens there and on no other screen.
//!
//! A host may know of fewer screens than the driver asking: a screen just
//! plugged in is a `wl_output` the host learns of from the compositor, and
//! its name comes only after the host has bound it, a round trip later. A
//! host started before the screen came (a warm spare) and asked at once to
//! open on it would not find it. It used to open with no screen named, which
//! the compositor takes as its first screen: a second screen's menu bar
//! opened over the first one's. Now the host waits for that screen, a while,
//! and if it never comes, opens nothing and says why: the driver sees the
//! host end and asks again, never a surface on the wrong screen.

use std::time::{Duration, Instant};

use sumi::{App, AsyncApp, DisplayId};

use crate::surface::Surface;

/// How long a surface waits for the screen it names to be known.
pub(crate) const SCREEN_WAIT: Duration = Duration::from_secs(3);
/// How often it looks meanwhile (the host's events run between looks).
const LOOK_EVERY: Duration = Duration::from_millis(16);

/// Where a surface opens.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Placement<Id> {
    /// It names no screen: wherever the compositor puts it.
    Anywhere,
    /// On this screen, the one it names.
    On(Id),
    /// It names a screen this host does not know (yet).
    Unknown,
}

/// Where a surface naming `name` opens among `displays` (each its name, if it
/// has one, and its id).
pub(crate) fn placement<Id>(
    name: Option<&str>,
    displays: impl IntoIterator<Item = (Option<String>, Id)>,
) -> Placement<Id> {
    let Some(name) = name else {
        return Placement::Anywhere;
    };
    displays
        .into_iter()
        .find(|(display, _)| display.as_deref() == Some(name))
        .map_or(Placement::Unknown, |(_, id)| Placement::On(id))
}

/// The screen the surface names, if it names one.
pub(crate) fn named(surface: Option<&Surface>) -> Option<&str> {
    match surface {
        Some(Surface::Layer(layer)) => layer.output.as_deref(),
        Some(Surface::Lock { output, .. }) => output.as_deref(),
        None => None,
    }
}

/// Where the surface opens on the screens this host knows now.
pub(crate) fn place(surface: Option<&Surface>, cx: &App) -> Placement<DisplayId> {
    let displays = cx
        .displays()
        .into_iter()
        .map(|display| (display.name().map(|name| name.to_string()), display.id()));
    placement(named(surface), displays)
}

/// Wait until the host knows the screen the surface names, for at most
/// `SCREEN_WAIT`; the reason it can't open when it never does.
pub(crate) async fn wait_for_screen(
    surface: Option<&Surface>,
    cx: &mut AsyncApp,
) -> Result<(), String> {
    let Some(name) = named(surface) else {
        return Ok(());
    };
    let started = Instant::now();
    loop {
        if cx.update(|cx| place(surface, cx)) != Placement::Unknown {
            // Said once, so a report from real hardware shows the wait.
            if started.elapsed() >= LOOK_EVERY {
                eprintln!(
                    "[mirin-metal] waited {} ms for screen {name} to be known",
                    started.elapsed().as_millis()
                );
            }
            return Ok(());
        }
        if started.elapsed() >= SCREEN_WAIT {
            return Err(unknown_screen(name));
        }
        cx.background_executor().timer(LOOK_EVERY).await;
    }
}

/// Why a surface naming `name` was not opened.
pub(crate) fn unknown_screen(name: &str) -> String {
    format!(
        "no screen named \"{name}\" after {} ms; the surface is not opened on another",
        SCREEN_WAIT.as_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screens() -> Vec<(Option<String>, u32)> {
        vec![
            (Some("Virtual-1".into()), 1),
            (None, 2),
            (Some("Virtual-2".into()), 3),
        ]
    }

    #[test]
    fn a_surface_opens_on_the_screen_it_names() {
        assert_eq!(placement(Some("Virtual-2"), screens()), Placement::On(3));
        assert_eq!(placement(None, screens()), Placement::Anywhere);
    }

    #[test]
    fn a_screen_not_known_yet_is_never_another_screen() {
        // The bug: a warm host that hadn't heard Virtual-2's name opened the
        // second screen's bar with no screen, which is the first screen.
        assert_eq!(placement(Some("HDMI-A-1"), screens()), Placement::Unknown);
        assert_eq!(
            placement(Some("Virtual-2"), Vec::<(Option<String>, u32)>::new()),
            Placement::Unknown
        );
    }

    #[test]
    fn a_lock_surface_names_its_screen_as_a_layer_surface_does() {
        let lock = crate::surface::parse_surface(r#"{"role":"lock","output":"Virtual-2"}"#, "x")
            .expect("a lock surface");
        assert_eq!(named(Some(&lock)), Some("Virtual-2"));
        let bar = crate::surface::parse_surface(r#"{"output":"Virtual-2"}"#, "x")
            .expect("a layer surface");
        assert_eq!(named(Some(&bar)), Some("Virtual-2"));
        assert_eq!(named(None), None);
    }

    #[sumi::test]
    fn a_window_for_an_unknown_screen_is_refused_not_put_on_the_first(
        cx: &mut sumi::TestAppContext,
    ) {
        // The test platform's one screen has no name: a surface naming any
        // screen used to open with no screen (the compositor's first).
        let bar = crate::surface::parse_surface(r#"{"output":"Virtual-2"}"#, "x")
            .expect("a layer surface");
        let refused = cx
            .update(|cx| crate::surface::with_role(sumi::WindowOptions::default(), Some(&bar), cx));
        assert_eq!(refused.err(), Some(unknown_screen("Virtual-2")));
        let anywhere = crate::surface::parse_surface("{}", "x").expect("a layer surface");
        let opened = cx.update(|cx| {
            crate::surface::with_role(sumi::WindowOptions::default(), Some(&anywhere), cx)
        });
        assert!(opened.is_ok_and(|options| options.display_id.is_none()));
    }
}
