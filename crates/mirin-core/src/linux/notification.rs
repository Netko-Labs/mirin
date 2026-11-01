//! Desktop notifications on Linux: one `Notify` call to the session's
//! notification service (org.freedesktop.Notifications, which every desktop
//! with notifications serves), over zbus. notify-rust did this before; its
//! Linux backends are zbus 5, whose zvariant crates are unmaintained (merged
//! into zbus 6), or libdbus, which would need its headers to build. The call
//! is a few fields, so mirin makes it itself.

use std::collections::HashMap;

use zbus::{Connection, Variant};

const SERVICE: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";

/// `expire_timeout` that leaves the duration to the notification service.
const SERVER_DEFAULT_TIMEOUT: i32 = -1;

/// Show a notification; false when there is no session bus or the service
/// refuses it. Blocks until the service answers, as notify-rust did.
pub fn show(summary: &str, body: Option<&str>, app_name: Option<&str>) -> bool {
    let app_name = app_name.map(str::to_owned).unwrap_or_else(executable_name);
    zbus::block_on(notify(&app_name, summary, body.unwrap_or(""))).is_ok()
}

async fn notify(app_name: &str, summary: &str, body: &str) -> zbus::Result<u32> {
    let connection = Connection::session().await?;
    let actions: Vec<&str> = Vec::new();
    let hints: HashMap<&str, Variant<'_>> = HashMap::new();
    let reply = connection
        .call_method(
            Some(SERVICE),
            PATH,
            Some(SERVICE),
            "Notify",
            &(
                app_name,
                0u32, // replaces_id: a new notification
                "",   // app_icon: the service finds it from the app name
                summary,
                body,
                actions,
                hints,
                SERVER_DEFAULT_TIMEOUT,
            ),
        )
        .await?;
    reply.body().deserialize::<u32>()
}

/// The name a notification is shown under when the app gave none: the running
/// executable's, as notify-rust used.
fn executable_name() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_stem()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_default()
}
