//! Cross-platform desktop notifications. The native library accepts a small
//! JSON payload and delegates delivery to the operating system notification
//! service through `notify-rust`.

use notify_rust::Notification;
use serde::Deserialize;

const MAX_TITLE_CHARS: usize = 128;
const MAX_BODY_CHARS: usize = 512;

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct NotificationSpec {
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    app_name: Option<String>,
}

fn parse_spec(spec_json: &str) -> Option<NotificationSpec> {
    let spec: NotificationSpec = serde_json::from_str(spec_json).ok()?;
    if spec.title.trim().is_empty()
        || spec.title.chars().count() > MAX_TITLE_CHARS
        || spec
            .body
            .as_ref()
            .is_some_and(|body| body.chars().count() > MAX_BODY_CHARS)
    {
        return None;
    }
    Some(spec)
}

/// Display a desktop notification. Returns false when the payload is invalid
/// or the host notification service rejects delivery.
pub fn notification_show(spec_json: String) -> bool {
    let Some(spec) = parse_spec(&spec_json) else {
        return false;
    };

    let mut notification = Notification::new();
    notification.summary(spec.title.trim());
    if let Some(body) = spec.body.as_deref().filter(|body| !body.is_empty()) {
        notification.body(body);
    }
    if let Some(app_name) = spec.app_name.as_deref().filter(|name| !name.is_empty()) {
        notification.appname(app_name);
    }

    notification.show().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_notification() {
        assert_eq!(
            parse_spec(
                r#"{"title":"Approval required","body":"Open Anko","appName":"dev.netko.anko"}"#
            ),
            Some(NotificationSpec {
                title: "Approval required".into(),
                body: Some("Open Anko".into()),
                app_name: Some("dev.netko.anko".into()),
            })
        );
    }

    #[test]
    fn rejects_blank_or_oversized_payloads() {
        assert!(parse_spec(r#"{"title":"  "}"#).is_none());
        let long_title = "x".repeat(MAX_TITLE_CHARS + 1);
        assert!(parse_spec(&serde_json::json!({ "title": long_title }).to_string()).is_none());
        let long_body = "x".repeat(MAX_BODY_CHARS + 1);
        assert!(
            parse_spec(&serde_json::json!({ "title": "Anko", "body": long_body }).to_string())
                .is_none()
        );
    }
}
