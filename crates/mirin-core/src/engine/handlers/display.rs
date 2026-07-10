use cef::*;

wrap_display_handler! {
    pub struct MirinDisplayHandler {}

    impl DisplayHandler {
        fn on_console_message(
            &self,
            _browser: Option<&mut Browser>,
            level: LogSeverity,
            message: Option<&CefString>,
            source: Option<&CefString>,
            line: i32,
        ) -> i32 {
            let msg = message.map(|m| m.to_string()).unwrap_or_default();
            let src = source.map(|s| s.to_string()).unwrap_or_default();
            eprintln!("[webview console] {level:?} {src}:{line} {msg}");
            0
        }
    }
}
