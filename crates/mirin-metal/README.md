# mirin-metal (alpha)

A React Native-like solution for mirin, built on [GPUI](https://www.gpui.rs) —
the GPU-accelerated Rust UI framework from the creators of Zed.

The model mirrors React Native: a **driver** owns state and describes the UI as
a serialized element tree; this crate renders that tree with **native GPU-drawn
elements — no webview** — applies streamed tree updates, and reports
interaction events back to the driver. Today the driver is a Rust thread (see
`examples/counter.rs`); the goal is the React reconciler running in mirin's Bun
Worker, talking to this renderer over the existing FFI/event-queue pattern.

```txt
driver (state)  ──JSON element tree──▶  mirin-metal / GPUI  ──▶  GPU pixels
      ▲                                        │
      └──────────── interaction events ────────┘
```

## Status

Exploratory **alpha** (`0.1.0-alpha.x`). Deliberately standalone:

- Excluded from the root Cargo workspace (`exclude` in the root `Cargo.toml`,
  own lockfile), so the CEF build, CI, and releases are unaffected.
- Not wired into the FFI surface (`ffi.rs`), the engine, or the TypeScript
  packages yet.

## Element tree (v1)

React-element-shaped JSON, parsed strictly (unknown fields rejected):

```json
{
  "type": "view",
  "props": {"fill": true, "center": true, "gap": 12, "background": "#111114"},
  "children": [
    {"type": "text", "props": {"size": 28, "color": "#f4f4f5"}, "children": ["count: 0"]},
    {"type": "view",
     "props": {"id": "increment", "onPress": true, "padding": 12, "cornerRadius": 8, "background": "#3b82f6"},
     "children": [{"type": "text", "props": {"color": "#ffffff"}, "children": ["tap me"]}]}
  ]
}
```

- `view`: flexbox-flavored layout (`direction`, `gap`, `padding`, `width`/
  `height`, `fill`, `center`), `background`, `cornerRadius`, and `onPress`
  (requires `id`; emits a `press` event carrying that id).
- `text`: string children plus `color` and `size`.

Rust surface: `parse_tree` → `NodeSpec`, then
`run(NativeUiOptions, initial_tree, updates_rx, events_tx)` — blocks in GPUI's
event loop on the process main thread; new trees on `updates_rx` replace the
rendered tree (last write wins), interactions arrive on `events_tx`.

## Run

```sh
cd crates/mirin-metal
cargo run --example hello     # static tree
cargo run --example counter   # full driver loop: press → event → new tree
```

Platform notes:

- macOS: renders via Metal; no extra system deps.
- Linux: needs Vulkan (Mesa is fine) plus XKB/Wayland client libs. Fedora:
  `dnf install libxkbcommon-devel libxkbcommon-x11-devel wayland-devel
  vulkan-loader-devel fontconfig-devel freetype-devel libxcb-devel`
  (Debian/Ubuntu: `libxkbcommon-dev libxkbcommon-x11-dev`). Keep `libc` pinned
  at 0.2.186 in `Cargo.lock` (see `Cargo.toml`). Verified on Fedora/KDE Wayland
  and under XWayland (`docs/metal.md`).
- Windows: renders via DirectX.

## React driver

`packages/mirin-metal` (`@mirinjs/metal`) is the real driver: a custom React
renderer whose `<View>`/`<Text>` host components commit to this element tree.
It talks to the `mirin-metal-host` binary (`src/bin/host.rs`) over stdio
NDJSON — trees in on stdin, events out on stdout — so normal React drives this
window today:

```sh
cargo build --bin mirin-metal-host
cd ../../packages/mirin-metal && bun demo/counter.tsx
```

## Integration plan (not yet built)

1. Expose the renderer through the flat C ABI pattern (`mirin_metal_*`
   symbols) instead of stdio; events through the polled queue, correlated by
   node id.
2. Thread ownership decision: GPUI, like CEF, wants the process main thread —
   the two cannot both own it, so a native-UI app mode (or subprocess) must be
   chosen and recorded in `docs/architecture.md` before any FFI lands.

Public-API and architecture changes go through `docs/api-design.md` /
`docs/architecture.md` sign-off before leaving alpha.
