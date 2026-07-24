use url::Url;

/// A normalized origin eligible to receive mirin's privileged renderer bridge.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TrustedOrigin {
    scheme: String,
    host: String,
    port: Option<u16>,
}

impl TrustedOrigin {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        let url = Url::parse(value).ok()?;
        if url.cannot_be_a_base() {
            return None;
        }

        let scheme = url.scheme();
        if !matches!(scheme, "app" | "http" | "https") {
            return None;
        }

        let host = url.host_str()?.to_owned();
        if host.is_empty() {
            return None;
        }

        let port = match scheme {
            "http" | "https" => url.port_or_known_default(),
            "app" => url.port(),
            _ => return None,
        };

        Some(Self {
            scheme: scheme.to_owned(),
            host,
            port,
        })
    }

    pub(crate) fn matches_url(&self, value: &str) -> bool {
        Self::parse(value).as_ref() == Some(self)
    }
}

#[cfg(test)]
mod tests {
    use super::TrustedOrigin;

    #[test]
    fn normalizes_http_origins() {
        let origin = TrustedOrigin::parse("HTTPS://Example.COM:443/start?q=1#top").unwrap();

        assert!(origin.matches_url("https://example.com/other"));
        assert!(origin.matches_url("https://EXAMPLE.com:443/redirected"));
        assert!(!origin.matches_url("https://example.com:444/"));
        assert!(!origin.matches_url("http://example.com/"));
    }

    #[test]
    fn matches_app_hosts_but_not_other_apps() {
        let origin = TrustedOrigin::parse("app://ui/index.html").unwrap();

        assert!(origin.matches_url("app://ui/settings/profile"));
        assert!(!origin.matches_url("app://admin/index.html"));
        assert!(!origin.matches_url("app://ui.example/index.html"));
    }

    #[test]
    fn rejects_opaque_untrusted_and_malformed_urls() {
        for value in [
            "about:blank",
            "data:text/html,hello",
            "blob:https://example.com/id",
            "file:///tmp/index.html",
            "javascript:alert(1)",
            "app:opaque",
            "https://[::1",
            "not a url",
        ] {
            assert_eq!(TrustedOrigin::parse(value), None, "accepted {value}");
        }
    }

    #[test]
    fn does_not_trust_cross_origin_navigation() {
        let origin = TrustedOrigin::parse("http://127.0.0.1:5173/index.html").unwrap();

        assert!(origin.matches_url("http://127.0.0.1:5173/after-redirect"));
        assert!(!origin.matches_url("http://localhost:5173/"));
        assert!(!origin.matches_url("https://127.0.0.1:5173/"));
    }
}
