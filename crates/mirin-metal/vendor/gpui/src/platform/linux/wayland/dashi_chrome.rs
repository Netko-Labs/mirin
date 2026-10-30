// mirin: the client side of Dashi's private dashi-chrome-v1 protocol, so an
// app can put its own content in the title bar ("unified" chrome). The XML is
// a copy of dashi/comp/protocols/dashi-chrome-v1.xml; keep them in sync.
// Generated the way wayland-protocols' own bindings are.
#![allow(dead_code, non_camel_case_types, unused_unsafe, unused_variables)]
#![allow(non_upper_case_globals, non_snake_case, unused_imports)]
#![allow(missing_docs, clippy::all)]

use wayland_client;
use wayland_client::protocol::*;
use wayland_protocols::xdg::shell::client::*;

pub mod __interfaces {
    use wayland_client::protocol::__interfaces::*;
    use wayland_protocols::xdg::shell::client::__interfaces::*;
    wayland_scanner::generate_interfaces!("protocols/dashi-chrome-v1.xml");
}
use self::__interfaces::*;

wayland_scanner::generate_client_code!("protocols/dashi-chrome-v1.xml");
