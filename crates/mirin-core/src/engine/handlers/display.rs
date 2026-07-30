use cef::*;

use super::MirinHandler;
use crate::engine::events::emit_event;

/// Longest console message forwarded to the Worker. A page can `console.log` a
/// megabyte; capping here keeps both the event queue and the devtools stream
/// readable instead of pushing the problem downstream.
const MAX_CONSOLE_CHARS: usize = 4000;

/// Truncate on a char boundary, marking that we did.
fn clamp(text: String) -> String {
    if text.chars().count() <= MAX_CONSOLE_CHARS {
        return text;
    }
    let kept: String = text.chars().take(MAX_CONSOLE_CHARS).collect();
    format!("{kept}…(truncated)")
}

/// Map CEF's severity onto mirin's devtools levels.
fn level_name(level: LogSeverity) -> &'static str {
    if level == LogSeverity::ERROR || level == LogSeverity::FATAL {
        "error"
    } else if level == LogSeverity::WARNING {
        "warn"
    } else if level == LogSeverity::VERBOSE {
        "debug"
    } else {
        // DEFAULT and INFO both mean "ordinary console output".
        "info"
    }
}

wrap_display_handler! {
    pub struct MirinDisplayHandler {}

    impl DisplayHandler {
        /// Renderer console output. Forwarded to the Worker as a structured
        /// `webview.console` event so the devtools stream can carry it
        /// (docs/agent-devtools.md), and still echoed to stderr for the terminal.
        ///
        /// Returning 0 keeps CEF's default handling intact.
        fn on_console_message(
            &self,
            browser: Option<&mut Browser>,
            level: LogSeverity,
            message: Option<&CefString>,
            source: Option<&CefString>,
            line: i32,
        ) -> i32 {
            let msg = clamp(message.map(|m| m.to_string()).unwrap_or_default());
            let src = source.map(|s| s.to_string()).unwrap_or_default();
            eprintln!("[webview console] {level:?} {src}:{line} {msg}");

            let window_id = browser
                .map(|b| b.identifier())
                .and_then(MirinHandler::window_id_for_ident);
            // json! escapes page-controlled text; never interpolate it into a
            // hand-built JSON string.
            let event = serde_json::json!({
                "type": "webview.console",
                "id": window_id,
                "level": level_name(level),
                "message": msg,
                "source": src,
                "line": line,
            });
            emit_event(&event.to_string());
            0
        }
    }
}
