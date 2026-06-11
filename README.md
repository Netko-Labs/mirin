# mirin

**Build desktop apps with Bun, TypeScript, and Chromium.**

Mirin is a desktop application framework in the spirit of Electron, built natively around the [Bun](https://bun.sh) runtime. Your app's main process is Bun — full `Bun.*` APIs, `bun:ffi`, Bun's bundler and test runner — and your UI is real Chromium via [CEF](https://github.com/chromiumembedded/cef) on every platform.

## Why mirin

- **Bun-native, permanently.** Bun is not a compatibility layer or a phase — it is the runtime. The main process API is designed around Bun idioms (top-level await, typed FFI, Workers), not ported from Node.
- **One engine everywhere.** CEF (Chromium) is the only engine on macOS and Linux, and the default on Windows. Identical rendering, identical devtools, identical web platform across every install. Windows apps that want a smaller footprint can opt into WebView2.
- **Declarative first.** An app is a typed config — windows, lifecycle, RPC surface — with imperative escape hatches when you need them. Closer to how you'd *describe* an app than how you'd wire one up in 2013.
- **Typed end to end.** RPC between the Bun process and webview JS is schema-derived: one router definition, full TypeScript inference on both sides, no stringly-typed channels.
- **Rust underneath.** The native layer (windowing, CEF embedding, IPC plumbing) is Rust, exposed to Bun through a stable C ABI.

## Architecture at a glance

```
your-app.app
├─ mirin host (Bun-compiled executable)
│   ├─ main thread ──→ libmirin_core (Rust): AppKit + CEF browser process
│   └─ Bun Worker ───→ your main-process code (TypeScript)
├─ Chromium Embedded Framework.framework
└─ Helper apps (Rust): renderer / GPU / plugin subprocesses
```

See [docs/architecture.md](docs/architecture.md) for the full picture, [docs/api-design.md](docs/api-design.md) for the developer-facing API, and [docs/macos-mvp.md](docs/macos-mvp.md) for the current roadmap.

## Quickstart (macOS arm64)

```bash
bun create mirinjs my-app
cd my-app
bun install
bun run dev      # native window: React + Vite HMR + typed RPC
bun run build    # standalone .app in ./build
```

You get a mirin-owned native window rendering React, a typed `greet` query
round-tripping to the Bun process, and live `tick` events pushed back to the UI
— all over a token-gated localhost socket. In dev the UI loads from Vite (HMR);
in a build it's served from the bundle via the native `app://` scheme.

The first run downloads the pinned CEF framework once (~hundreds of MB) into
`~/.mirinjs/cef/`. Requires Bun and the Xcode command-line tools — **no Rust
toolchain needed**; the native core ships prebuilt. See
[docs/getting-started.md](docs/getting-started.md).

Working on mirin itself? See [CONTRIBUTING.md](CONTRIBUTING.md).

## Status

Pre-alpha, macOS only. **The full loop works end-to-end** — both `mirin dev`
(Vite HMR) and `mirin build` (standalone signed `.app`): Bun host → CEF →
mirin-owned NSWindow → React (rolldown-vite) → typed RPC both directions, served
in production from `app://`, with clean teardown (zero orphan processes).

Built: native core + helper (Rust/CEF), the Bun host/Worker handoff, the FFI
command surface, manifest-driven windows, preload injection, typed RPC over a
localhost WebSocket, the `app://` scheme handler, `mirin dev` / `mirin build`,
and the macOS app-shell tier — **native menus + context menus, a menu-bar
tray, dialogs, clipboard, global shortcuts, window controls, and custom /
frameless title bars** (`docs/macos-mvp.md`, M0–M6 done).

### Examples

- `examples/hello-react` — minimal starter (typed RPC, live events).
- `examples/kitchen-sink` — every native feature in one app (menus, tray,
  dialogs, clipboard, ⌘⇧K global shortcut, window controls, draggable custom
  title bar).
- `examples/spotlight` — a ⌘⇧J-summoned frameless translucent command palette
  (type-to-filter over RPC, Esc to dismiss, stays resident).

Not yet built (toward Electron/electrobun parity): `mirin init`, notarization +
dmg packaging, multi-webview windows, the auto-updater, and the Windows/Linux
ports.

## Prior art & credits

Mirin is a clean-room project heavily informed by [Electrobun](https://github.com/blackboardsh/electrobun) (MIT, © Blackboard Technologies inc.), whose Zig-based architecture proved that a Bun-worker-inside-native-host model works in production. We also stand on [Electron](https://electronjs.org), [Tauri](https://tauri.app), and [cef-rs](https://github.com/tauri-apps/cef-rs).

## License

MIT
