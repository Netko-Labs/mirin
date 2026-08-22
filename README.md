<div align="center">

<img src="packages/docs/public/kome.svg" alt="Kome, the Mirin mascot — a grain of rice filled with amber" width="88" height="88">

# Mirin

**Desktop apps, brewed in Bun.**

[Docs](https://mirin.netko.dev) · [Examples](#examples) · [llms.txt](https://mirin.netko.dev/llms.txt)

</div>

Mirin is a desktop application framework in the spirit of Electron, built natively around the [Bun](https://bun.sh) runtime. Your app's main process is Bun — full `Bun.*` APIs, `bun:ffi`, Bun's bundler and test runner — and your UI is real Chromium via [CEF](https://github.com/chromiumembedded/cef) on every platform.

Three spellings, three different things: **Mirin** is the product, `mirinjs` is the npm package, `mirin` is the binary.

## Why Mirin


- **Bun-native, permanently.** Bun is not a compatibility layer or a phase — it is the runtime. The main process API is designed around Bun idioms (top-level await, typed FFI, Workers), not ported from Node.
- **One engine everywhere.** CEF (Chromium) is the engine on macOS, Windows, and Linux. Identical rendering, identical devtools, identical web platform across every install. A WebView2 option on Windows remains a future size optimization.
- **Declarative first.** An app is a typed config — windows, lifecycle, RPC surface — with imperative escape hatches when you need them. Closer to how you'd *describe* an app than how you'd wire one up in 2013.
- **Typed end to end.** RPC between the Bun process and webview JS is schema-derived: one router definition, full TypeScript inference on both sides, no stringly-typed channels.
- **Rust underneath.** The native layer (windowing, CEF embedding, IPC plumbing) is Rust, exposed to Bun through a stable C ABI.

## Architecture at a glance

The macOS bundle below illustrates the shared host/Worker/core model; Windows
and Linux use the same process model in flat app directories.

```
your-app.app
├─ mirin host (Bun-compiled executable)
│   ├─ main thread ──→ libmirin_core (Rust): AppKit + CEF browser process
│   └─ Bun Worker ───→ your main-process code (TypeScript)
├─ Chromium Embedded Framework.framework
└─ Helper apps (Rust): renderer / GPU / plugin subprocesses
```

See [docs/architecture.md](docs/architecture.md) for the full picture, [docs/api-design.md](docs/api-design.md) for the developer-facing API, and [docs/macos-mvp.md](docs/macos-mvp.md) for the current roadmap.

## Quickstart (macOS arm64 / Windows x64/arm64 / Linux x64/arm64 alpha)

```bash
bun create mirinjs my-app
cd my-app
bun install
bun run dev      # native window: React + Vite HMR + typed RPC
bun run build    # standalone app in ./build
```

You get a mirin-owned native window rendering React, a typed `greet` query
round-tripping to the Bun process, and live `tick` events pushed back to the UI
— all over a token-gated localhost socket. In dev the UI loads from Vite (HMR);
in a build it's served from the bundle via the native `app://` scheme.

The first run downloads the pinned CEF runtime once (~hundreds of MB) into
`~/.mirinjs/cef/<version-platform>/`. Requires Bun; macOS builds also need the
Xcode command-line tools for signing. **No Rust toolchain needed** to use mirin;
the native core ships prebuilt for supported platforms. See
[docs/getting-started.md](docs/getting-started.md).

Working on mirin itself? See [CONTRIBUTING.md](CONTRIBUTING.md).

## Status

Pre-alpha. macOS arm64 is the most exercised path; the Windows and Linux CEF
ports are implemented and documented for x64 and arm64. **The full loop works
end-to-end** — `mirin init`, `mirin dev` (Vite HMR), `mirin build` (standalone
app), and `mirin release` (installer + updater artifacts): Bun host → CEF →
native window → React (rolldown-vite) → typed RPC both directions, served in
production from `app://`, with clean teardown (zero orphan processes in verified
flows).

Built on every platform: native core + helper (Rust/CEF), the Bun host/Worker
handoff, the FFI command surface, manifest-driven windows, preload injection,
typed RPC over a localhost WebSocket, the `app://` scheme handler, `mirin init` /
`dev` / `build` / `release`, sidecars, extra workers, deep links, updater
artifacts, DMG / Inno / NSIS / AppImage / deb / rpm packages, and window
controls. macOS and Windows also ship the broader app-shell tier: **native menus
and context menus, tray, dialogs, clipboard, global shortcuts, window controls,
custom / frameless title bars, and transparent/material windows**. Linux
app-shell parity is still in progress; see `docs/linux-port.md` for the precise
matrix.

### Examples

- `examples/hello-react` — minimal starter (typed RPC, live events).
- `examples/kitchen-sink` — every native feature in one app (menus, tray,
  dialogs, clipboard, ⌘⇧K global shortcut, window controls, draggable custom
  title bar).
- `examples/spotlight` — a ⌘⇧J-summoned frameless command palette on Apple
  **Liquid Glass** (type-to-filter over RPC, Esc to dismiss, stays resident).
- `examples/liquid-glass` — live picker that swaps native background materials
  (Liquid Glass + vibrancy) on a transparent window.
- `examples/updater` — `app.updater` plus `mirin release` artifacts.

Not yet built (toward Electron/electrobun parity): multi-webview windows,
user preload scripts, session/cookie controls, payload encryption or a CEF IPC
replacement for the RPC data plane, and a WebView2 option on Windows.

## Brand

Mirin (味醂) is sweet amber rice wine, and the identity follows the ingredient
rather than the category. **Kome** — a grain of rice filled with amber to the
brew line, with a face — is both the logo and the mascot; there is no separate
abstract mark. Amber `#dd9a3f` is the only accent, every neutral is warm, and
the display serif belongs to marketing while the docs stay in the interface
sans.

The full brand book, the docs site and the landing page all live at
[mirin.netko.dev](https://mirin.netko.dev), built from `packages/docs`.

## Prior art & credits

Mirin is a clean-room project heavily informed by [Electrobun](https://github.com/blackboardsh/electrobun) (MIT, © Blackboard Technologies inc.), whose Zig-based architecture proved that a Bun-worker-inside-native-host model works in production. We also stand on [Electron](https://electronjs.org), [Tauri](https://tauri.app), and [cef-rs](https://github.com/tauri-apps/cef-rs).

## License

MIT
