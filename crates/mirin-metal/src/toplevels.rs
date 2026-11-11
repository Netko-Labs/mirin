//! The `shell.toplevels` capability: a second Wayland connection, on its own
//! thread, that follows every window through wlr-foreign-toplevel-management
//! (title, app id, focus, minimized, maximized) and performs taskbar actions
//! on them. A shell's dock and menu bar are built on this.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{wl_registry::WlRegistry, wl_seat::WlSeat};
use wayland_client::{event_created_child, Connection, Dispatch, Proxy, QueueHandle};
use wayland_protocols_wlr::foreign_toplevel::v1::client::{
    zwlr_foreign_toplevel_handle_v1::{self as handle_v1, ZwlrForeignToplevelHandleV1},
    zwlr_foreign_toplevel_manager_v1::{self as manager_v1, ZwlrForeignToplevelManagerV1},
};

/// One window as the compositor describes it. `id` is stable while the
/// window lives and may be reused after it closes.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Toplevel {
    pub id: u32,
    pub title: String,
    pub app_id: String,
    pub activated: bool,
    pub minimized: bool,
    pub maximized: bool,
    pub fullscreen: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ToplevelUpdate {
    /// A window appeared or changed (sent after the compositor's `done`).
    Changed(Toplevel),
    Closed(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToplevelAction {
    Activate,
    Close,
    Minimize,
    Unminimize,
    Maximize,
    Unmaximize,
}

/// A taskbar action from the driver: `{"toplevel":{"id":3,"action":"activate"}}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToplevelCommand {
    pub id: u32,
    pub action: ToplevelAction,
}

type Handles = Arc<Mutex<HashMap<u32, ZwlrForeignToplevelHandleV1>>>;

/// Performs taskbar actions from any thread; requests go out immediately.
#[derive(Clone)]
pub struct Toplevels {
    connection: Connection,
    seat: WlSeat,
    handles: Handles,
}

impl Toplevels {
    pub fn perform(&self, command: ToplevelCommand) -> Result<(), String> {
        {
            let handles = self.handles.lock().unwrap_or_else(PoisonError::into_inner);
            let handle = handles
                .get(&command.id)
                .ok_or_else(|| format!("no toplevel {}", command.id))?;
            match command.action {
                ToplevelAction::Activate => handle.activate(&self.seat),
                ToplevelAction::Close => handle.close(),
                ToplevelAction::Minimize => handle.set_minimized(),
                ToplevelAction::Unminimize => handle.unset_minimized(),
                ToplevelAction::Maximize => handle.set_maximized(),
                ToplevelAction::Unmaximize => handle.unset_maximized(),
            }
        }
        self.connection.flush().map_err(|error| error.to_string())
    }
}

/// Connect, bind the toplevel manager, and follow windows on a new thread,
/// calling `emit` for every change. Fails when the compositor does not offer
/// wlr-foreign-toplevel-management.
pub fn watch(emit: impl FnMut(ToplevelUpdate) + Send + 'static) -> Result<Toplevels, String> {
    let connection = Connection::connect_to_env().map_err(|error| error.to_string())?;
    let (globals, mut queue) =
        registry_queue_init::<Watcher>(&connection).map_err(|error| error.to_string())?;
    let qh = queue.handle();
    let manager: ZwlrForeignToplevelManagerV1 = globals
        .bind(&qh, 1..=3, ())
        .map_err(|_| "the compositor does not offer wlr-foreign-toplevel-management")?;
    let seat: WlSeat = globals
        .bind(&qh, 1..=1, ())
        .map_err(|_| "the compositor offers no seat")?;
    let handles = Handles::default();
    let mut watcher = Watcher {
        windows: HashMap::new(),
        handles: handles.clone(),
        emit: Box::new(emit),
    };
    std::thread::Builder::new()
        .name("toplevels".into())
        .spawn(move || {
            // Keep the manager alive for as long as events flow.
            let _manager = manager;
            while queue.blocking_dispatch(&mut watcher).is_ok() {}
        })
        .map_err(|error| error.to_string())?;
    Ok(Toplevels {
        connection,
        seat,
        handles,
    })
}

struct Watcher {
    /// Accumulated state per window; emitted on `done`.
    windows: HashMap<u32, Toplevel>,
    handles: Handles,
    emit: Box<dyn FnMut(ToplevelUpdate) + Send>,
}

impl Watcher {
    fn handles(&self) -> std::sync::MutexGuard<'_, HashMap<u32, ZwlrForeignToplevelHandleV1>> {
        self.handles.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Dispatch<WlRegistry, GlobalListContents> for Watcher {
    fn event(
        _: &mut Self,
        _: &WlRegistry,
        _: <WlRegistry as Proxy>::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<WlSeat, ()> for Watcher {
    fn event(
        _: &mut Self,
        _: &WlSeat,
        _: <WlSeat as Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ZwlrForeignToplevelManagerV1, ()> for Watcher {
    fn event(
        watcher: &mut Self,
        _: &ZwlrForeignToplevelManagerV1,
        event: manager_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let manager_v1::Event::Toplevel { toplevel } = event {
            let id = toplevel.id().protocol_id();
            watcher.windows.insert(
                id,
                Toplevel {
                    id,
                    ..Toplevel::default()
                },
            );
            watcher.handles().insert(id, toplevel);
        }
    }

    event_created_child!(Watcher, ZwlrForeignToplevelManagerV1, [
        manager_v1::EVT_TOPLEVEL_OPCODE => (ZwlrForeignToplevelHandleV1, ()),
    ]);
}

impl Dispatch<ZwlrForeignToplevelHandleV1, ()> for Watcher {
    fn event(
        watcher: &mut Self,
        handle: &ZwlrForeignToplevelHandleV1,
        event: handle_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let id = handle.id().protocol_id();
        if let handle_v1::Event::Closed = event {
            watcher.windows.remove(&id);
            watcher.handles().remove(&id);
            handle.destroy();
            (watcher.emit)(ToplevelUpdate::Closed(id));
            return;
        }
        let Some(window) = watcher.windows.get_mut(&id) else {
            return;
        };
        match event {
            handle_v1::Event::Title { title } => window.title = title,
            handle_v1::Event::AppId { app_id } => window.app_id = app_id,
            handle_v1::Event::State { state } => apply_states(window, &state),
            handle_v1::Event::Done => {
                let snapshot = window.clone();
                (watcher.emit)(ToplevelUpdate::Changed(snapshot));
            }
            _ => {}
        }
    }
}

/// The `state` event's array of native-endian u32 states.
fn apply_states(window: &mut Toplevel, raw: &[u8]) {
    let states: Vec<handle_v1::State> = raw
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| u32::from_ne_bytes(*chunk))
        .filter_map(|value| handle_v1::State::try_from(value).ok())
        .collect();
    window.activated = states.contains(&handle_v1::State::Activated);
    window.minimized = states.contains(&handle_v1::State::Minimized);
    window.maximized = states.contains(&handle_v1::State::Maximized);
    window.fullscreen = states.contains(&handle_v1::State::Fullscreen);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_state_arrays() {
        let raw: Vec<u8> = [2u32, 1]
            .iter()
            .flat_map(|value| value.to_ne_bytes())
            .collect();
        let mut window = Toplevel::default();
        apply_states(&mut window, &raw);
        assert!(window.activated && window.minimized);
        assert!(!window.maximized && !window.fullscreen);

        // Unknown values and a trailing partial value are ignored.
        let mut raw: Vec<u8> = 99u32.to_ne_bytes().to_vec();
        raw.extend([0u8, 0]);
        apply_states(&mut window, &raw);
        assert!(!window.activated && !window.minimized);
    }

    #[test]
    fn parses_commands() {
        let command: ToplevelCommand =
            serde_json::from_str(r#"{"id":3,"action":"unminimize"}"#).unwrap();
        assert_eq!(
            command,
            ToplevelCommand {
                id: 3,
                action: ToplevelAction::Unminimize
            }
        );
        assert!(serde_json::from_str::<ToplevelCommand>(r#"{"id":3,"action":"raise"}"#).is_err());
        assert!(serde_json::from_str::<ToplevelCommand>(r#"{"id":3}"#).is_err());
    }
}
