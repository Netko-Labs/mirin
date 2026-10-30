# mirin's GPUI fork

`gpui` 0.2.2 from crates.io (Zed Industries, Apache-2.0), vendored so
`mirin-metal` can extend layout where the published crate stops short. Every
change is listed here and marked with a `// mirin:` comment in the source.
Upstreaming candidates are marked as such.

| Change | Files | Why |
| --- | --- | --- |
| Explicit grid track lists (`grid_template_columns` / `grid_template_rows`) | `src/style.rs`, `src/taffy.rs` | Tailwind `grid-cols-[16px_1fr]`, `grid-cols-[1fr_auto]`; the published crate only has `repeat(N, minmax(0, 1fr))`. Upstreamable. |
| `justify_items` / `justify_self` | `src/style.rs`, `src/taffy.rs` | Grid inline-axis alignment (`justify-self-end`, `justify-items-center`). Upstreamable. |
| Text min-content width is the widest word | `src/elements/text.rs` | Taffy asks text for its min-content size when sizing `auto`/`1fr` grid tracks and flex items; GPUI returned the unwrapped line, so text never wrapped there (a card header's title column pushed its action out of the card). Upstreamable. |
| wlr-layer-shell surfaces (`WindowOptions::layer_shell`, `LayerShellOptions`) | `src/platform.rs`, `src/window.rs`, `src/platform/linux/wayland/{client,window}.rs`, `src/platform/mac/window.rs`, `Cargo.toml` | Desktop-shell UI (menu bar, dock, launcher) are layer surfaces; GPUI only made xdg toplevels. The Wayland window's surface role became an enum, toplevel-only requests are no-ops on layer surfaces, and `wayland-protocols-wlr` 0.2 is a new optional dependency. Upstreamable in spirit (Zed would want its own API shape). |
| Typed float literals in `to_grid_repeat` | `src/taffy.rs` | rustc is phasing out `f32` fallback for untyped literals (future hard error). |
| Session-lock surfaces (`WindowOptions::session_lock`, `Window::unlock_session`) | `src/platform.rs`, `src/window.rs`, `src/platform/linux/wayland/{client,window}.rs` | A lock screen: ext-session-lock-v1 on the first output; unlocks only on request, never on exit. |
| Wayland windows commit only drawn frames; idle windows wake on dirty (`PlatformWindow::redraw_waker`) | `src/platform.rs`, `src/window.rs`, `src/platform/linux/wayland/window.rs` | GPUI committed after every frame callback even when nothing was drawn, which asked for another callback: an unchanged window committed at the display's rate and kept an on-demand compositor drawing (and the GPU awake) forever. Now a frame callback is asked for only when a frame draws, a window with nothing to draw goes idle, and GPUI wakes it when it becomes dirty or wants its next frame. Upstreamable. |

To update: copy the new release over this directory (minus `examples/`,
`Cargo.lock`, `Cargo.toml.orig`, and the `[[example]]` entries in
`Cargo.toml`), then re-apply the changes above.
