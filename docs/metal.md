# Mirin Metal

Metal is mirin without CEF. The developer writes normal React (JSX, hooks,
state, flexbox styles) and it renders as GPU-drawn native UI through
[GPUI](https://www.gpui.rs), the Rust UI framework behind Zed. No web engine,
no Chromium subprocess fleet, no `app://` scheme.

This document is the source of truth for Metal the way `docs/architecture.md`
is for the CEF runtime. Public API changes still go through
`docs/api-design.md` sign-off before leaving alpha.

Status: **alpha, standalone.** `crates/mirin-metal` is excluded from the Cargo
workspace and `@mirinjs/metal` is not wired into `mirinjs`, the CLI, or
release tooling. Metal seeds from the earlier `mirin-native` spike (branch
`claude/mirin-native-gpu-validation-vumae7`), imported and renamed on
2026-10-29.

## 0. Relationship to mirin

Metal and mirin are **two different worlds that share a contract**. The owner's
rule (2026-10-29): they share what they can and are almost interoperable, but
Metal is **not free to make breaking changes against `mirinjs`**.

What that means in practice:

- **Shared surface, shared ownership.** `mirin.config.ts` (`defineConfig`),
  `app` (lifecycle, windows, sidecars, resources, workers), `dialog`,
  `clipboard`, `notification`, `shortcut`, `tray`, `menu`, the typed RPC
  helpers, and the updater keep the shapes `docs/api-design.md` defines. Metal
  implements them, it does not redefine them. A change to any of these goes
  through `docs/api-design.md` sign-off with mirinjs in mind, never Metal-only.
- **Metal-only surface lives in `@mirinjs/metal`.** `<View>`, `<Text>`,
  `<TextInput>`, `<ScrollView>`, the element-tree protocol, and the renderer
  options are Metal's own and may move fast while alpha. They never leak into
  `mirinjs`.
- **Same process model.** A Metal app is still Bun host + Worker + Rust core;
  only the engine behind the window differs (GPUI instead of CEF). Apps keep the
  same `mirin.config.ts`, the same `app.windows.open`, the same packaging story.
- **Interoperable, not identical.** An app's main-process code should move
  between the two flavors unchanged. The UI code is different by design: DOM/
  React-DOM in mirin, Metal components in Metal.
- **Breaking changes.** Metal may break *its own* surface during alpha. It may
  not break, fork, or shadow a `mirinjs` export, event name, config key, or RPC
  frame. When Metal needs something the shared surface lacks, propose it for
  `mirinjs` first (feature-flagged or no-op on CEF if needed).

## 1. Shape

```txt
normal React ──react-reconciler──▶ element tree JSON ──▶ mirin-metal (GPUI) ──▶ GPU pixels
     ▲                                                          │
     └──────────────── interaction events (node id) ────────────┘
```

| Piece | Lives in | Role |
| --- | --- | --- |
| `@mirinjs/metal` | `packages/mirin-metal` | Custom React renderer. Host components `<View>` and `<Text>`; each commit serializes the host tree to JSON and sends it over a transport; events come back keyed by node id and invoke the matching handler. |
| `mirin-metal` crate | `crates/mirin-metal` | Parses the tree strictly (`tree.rs`, unknown fields rejected), maps it to GPUI elements (`render.rs`), owns the window and GPUI's event loop (`window.rs`), and reports interactions (`events.rs`). |
| `mirin-metal-host` | `crates/mirin-metal/src/bin/host.rs` | Alpha transport: a subprocess speaking newline-delimited JSON. Trees in on stdin, events out on stdout. |

The model deliberately mirrors React Native: the driver (React in Bun) owns
state and describes UI; the renderer is a pure function of the latest tree.
"Last write wins" per update tick; there is no diffing protocol yet.

## 2. Element tree (v2)

```json
{
  "type": "view",
  "props": {"id": "1", "fill": true, "direction": "row", "background": "#111114"},
  "children": [
    {"type": "view", "props": {"id": "2", "width": 220, "scroll": true, "padding": 12}, "children": [
      {"type": "text", "props": {"size": 11, "weight": "semibold", "color": "#8b8b96"}, "children": ["CONNECTIONS"]},
      {"type": "view", "props": {"id": "3", "onPress": true, "hoverBackground": "#1f1f27"}, "children": [
        {"type": "text", "props": {"truncate": true}, "children": ["Check SQLite"]}]}]},
    {"type": "input", "props": {"id": "4", "value": "select 1", "multiline": true, "mono": true,
      "autofocus": true, "onChange": true, "onSubmit": true}}
  ]
}
```

- `view`: `direction`, `gap`, `padding` / `paddingX` / `paddingY`, `width`,
  `height`, `minWidth`, `minHeight`, `maxHeight`, `flex` (grow when ≥ 1),
  `shrink`, `fill`, `center`, `align` (`start|center|end|stretch`), `justify`
  (`start|center|end|between`), `background`, `hoverBackground`, `cornerRadius`,
  `borderWidth` (1 or 2), `borderColor`, `scroll` (vertical), `scrollX`, `clip`, `opacity`,
  `onPress`. `id` is required for `onPress`, `hoverBackground`, and `scroll`
  (GPUI keeps per-element state for those); the TypeScript side sends one for
  every node.
- `text`: string children plus `color`, `size`, `weight`
  (`normal|medium|semibold|bold`), `mono` (system monospace via `fc-match`),
  `truncate`, `opacity`.
- `input`: `id` (required), `value`, `placeholder`, `multiline`, `secure`
  (bullets instead of text), `mono`, `size`,
  `color`, `placeholderColor`, `background`, `padding`, `cornerRadius`,
  `borderColor`, `focusBorderColor`, `width`, `height`, `minHeight`, `flex`,
  `fill`, `autofocus`, `onChange`, `onSubmit`. The renderer owns the editing
  buffer, caret, and focus (`window::InputState`); a different `value` in a
  later tree resets the buffer (controlled-input semantics). Enter submits a
  single-line input; multiline inserts a newline and Ctrl/Cmd+Enter submits.
  Ctrl/Cmd+V pastes from the system clipboard. Tab / Shift+Tab move focus
  between inputs in document order (wrapping).
- Colors are `#RGB`, `#RRGGBB`, or `#RRGGBBAA`.
- Events: `{"type":"press","nodeId"}`, `{"type":"change","nodeId","value"}`,
  `{"type":"submit","nodeId","value"}`, and `{"type":"layout","nodeId":"root",
  "nodes":[{id,x,y,width,height}]}` in reply to a layout query.
- Simulation (checks and tools): a stdin line `{"sim": ...}` instead of a tree.
  `{"kind":"click","id"}` / `{"kind":"click","x","y"}` focuses an input or
  fires a pressable view's `press` (resolved against the painted bounds;
  GPUI's mouse dispatch is crate-private, so hit-testing is approximated),
  `{"kind":"key","keystroke":"ctrl-enter"}` and `{"kind":"type","text"}` go
  through GPUI's real keystroke dispatch, `{"kind":"layout"}` asks for bounds.
  `@mirinjs/metal` exposes this as `testID` props, `transport.simulate()`,
  `root.nodeId(testID)`, and `root.lastTree()`; Anko's `apps/metal/check.ts`
  is the worked example.

The TypeScript side (`packages/mirin-metal/src/lib/serialize.ts`) maps React
Native-style props: `<View style>` (`flex`, `alignItems`, `justifyContent`,
`overflow: "scroll" | "hidden"`, `hoverBackgroundColor`, …), `<Text
numberOfLines={1} style={{ fontWeight, fontFamily: "monospace" }}>`,
`<TextInput value onChangeText onSubmitEditing multiline autoFocus style>`, and
`<ScrollView>` (a scrolling `<View>`).

## 3. Process model (decision pending)

GPUI, like CEF, wants the process main thread. The two cannot share it, so
Metal is a **separate app flavor**, never a mode of a CEF window. The proposed
model keeps mirin's host/Worker split and swaps the engine:

```txt
host (bun --compile)             Bun Worker                 libmirin_metal (Rust)
  dlopen libmirin_metal  ─────▶  React + @mirinjs/metal  ──▶  mirin_metal_run() owns main thread
  spawn Worker                   RPC/app APIs reused          GPUI window + event loop
```

- Commands (tree updates) cross the flat C ABI as JSON, like `mirin_window_*`.
- Events (press, window lifecycle) come back through a polled queue, matching
  `engine::events` in the CEF core.
- The stdio host is the alpha stand-in for that FFI transport and stays useful
  for out-of-process debugging.

Decisions, following §0:

1. **Packaging.** `mirinjs` stays the one app API. Metal is consumed as
   `@mirinjs/metal` (components + renderer) on top of it, not as a separate
   runtime entry that re-exports `app`/`dialog`/… Apps import `app` from
   `mirinjs` and `<View>` from `@mirinjs/metal`.
2. **Native library.** A second cdylib, `libmirin_metal`, so the CEF core stays
   free of GPUI's dependency tree and Metal apps ship without a CEF download.
   It exposes the same command/event envelope (`{"v":1,"kind":...}`) and the
   same feature modules (`engine/dialog`, `clipboard`, `notification`, …) so
   the Worker-side `mirinjs` code is shared verbatim; only window creation and
   the element-tree commands differ.
3. **Diffing.** Whole-tree replacement is fine for the alpha; a patch protocol
   (`insert` / `remove` / `update`) is a Metal-only change and can land whenever
   trees get large, without touching `mirinjs`.

## 4. Platform notes

### Linux (Fedora first)

Verified 2026-10-29 on Nobara 44 (Fedora 44 base), KDE Plasma on Wayland, AMD
Radeon 890M with Mesa RADV:

- GPUI renders natively on Wayland (`WAYLAND_DISPLAY`) and falls back to X11
  when it is unset. Both paths open a window, draw the tree, and apply piped
  updates. GPUI draws its own client-side title bar on Wayland.
- Build deps (dnf): `cmake ninja-build libxkbcommon-devel libxkbcommon-x11-devel
  wayland-devel vulkan-loader-devel fontconfig-devel freetype-devel libxcb-devel
  libX11-devel`. Runtime needs a Vulkan driver (RADV, ANV, or NVK; llvmpipe works
  as a software fallback).
- **libc pin.** `gpui 0.2.2` pulls `xattr 0.2.3` through `zed-async-tar`, which
  fails to compile against `libc >= 0.2.190` (`ENOATTR` was removed on Linux).
  The crate's `Cargo.lock` pins `libc 0.2.186`; refresh with
  `cargo update libc --precise 0.2.186` after any `cargo update`. Revisit when
  GPUI bumps its tar fork.
- `proc-macro-error2 2.0.1` triggers a future-incompat warning; harmless today.

### macOS

Renders through Metal (the Apple API) with no extra system deps. Not yet
re-verified on this branch.

### Windows

Renders through DirectX. Not yet verified.

## 5. Milestones

- **M0 — alpha imported** ✅ (2026-10-29). Crate + package renamed to Metal,
  builds standalone on Fedora, `bun test` / `tsc` / biome / `cargo test` /
  `cargo clippy -D warnings` / `cargo fmt --check` pass, stdio demo renders and
  applies updates on Wayland and X11.
- **M1 — real app loop.** 🚧 **Anko runs on Metal** (`apps/metal` in the Anko
  repo, 2026-10-29): React in Bun calls Anko's service/repository packages
  directly, and the sidebar, SQLite connection form, query editor, and results
  table render through GPUI; verified on Fedora/KDE by driving the whole flow
  with the keyboard (Tab, typing, Ctrl+Enter). Text input (`<TextInput>`, renderer-owned buffer,
  caret, focus, paste, change/submit events), scroll views, hover, borders,
  alignment, truncation, and monospace text landed 2026-10-29 and were driven
  with synthetic keyboard input on Fedora/KDE. Still open: press verified only
  through the fake transport, image nodes, text selection, a tree patch
  protocol.
- **M2 — in-process transport.** `libmirin_metal` C ABI + polled event queue
  replacing the stdio host; host/Worker boot shared with the CEF runtime;
  `docs/architecture.md` gains the Metal arm.
- **M3 — CLI.** `mirin dev` / `build` / `release` for Metal apps on Linux
  (flat dir, AppImage / rpm / deb), then macOS and Windows.
- **M4 — app shell parity.** Menus, tray, dialogs, clipboard, shortcuts,
  notifications through the same `engine/` feature modules.

## 6. Run it

```sh
cd crates/mirin-metal && cargo build --bin mirin-metal-host
cd ../../packages/mirin-metal && bun demo/counter.tsx
```

The host reads `MIRIN_METAL_TITLE` and `MIRIN_METAL_SIZE=1280x820`. A consumer
that depends on `@mirinjs/metal` must share one React instance with it: a
`bun link` keeps the package's own `node_modules` (two Reacts, "Invalid hook
call"), so until it is published use `"@mirinjs/metal": "file:../path"`.

Or drive the host by hand:

```sh
echo '{"type":"view","props":{"fill":true,"center":true,"background":"#3b82f6"},"children":[{"type":"text","props":{"size":40,"color":"#ffffff"},"children":["mirin metal"]}]}' \
  | crates/mirin-metal/target/debug/mirin-metal-host
```
