//! libmirin_core — the native core of mirin (docs/architecture.md).
//!
//! - `ffi` — the C ABI the Bun host/Worker calls via `bun:ffi`.
//! - `engine` — CEF boot, window/browser lifecycle, the command/event surface.
//! - `mac` — the macOS AppKit layer (windows, menus, tray, dialogs, …).
//! - `scheme` — the `app://` asset scheme handler.

pub mod engine;
pub mod ffi;
pub mod scheme;

#[cfg(target_os = "macos")]
pub mod mac;

#[cfg(target_os = "windows")]
pub mod win;

#[cfg(target_os = "linux")]
pub mod linux;
