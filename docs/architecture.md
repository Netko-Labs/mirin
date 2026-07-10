# Mirin Architecture

This document describes mirin's process model, threading rules, the Bun↔Rust FFI boundary, and the IPC design. It is the source of truth for implementation; when code and doc disagree, fix one of them in the same change.

Decisions already made (do not relitigate casually):

| Decision | Choice |
|---|---|
| Code origin | Clean rewrite (electrobun studied as reference, MIT-attributed in README) |
| Native layer | Rust core; thin ObjC++/Swift shims only where AppKit forces it |
| Engine | CEF only on macOS/Linux; CEF default on Windows with optional WebView2 |
| CEF bindings | `cef` crate (tauri-apps/cef-rs), vendored/forked if it blocks us |
| Process model | Rust host owns main thread; user app runs in a Bun Worker |
| API flavor | Declarative/config-first with imperative escape hatches |

## 1. Process model

A running mirin app on macOS is one **browser process** plus CEF's standard subprocess fleet:

```
MyApp.app/
├─ Contents/MacOS/MyApp                  ← host executable (browser process)
├─ Contents/Frameworks/
│  ├─ Chromium Embedded Framework.framework
│  ├─ MyApp Helper.app                   ← Rust helper binary
│  ├─ MyApp Helper (Renderer).app
│  ├─ MyApp Helper (GPU).app
│  ├─ MyApp Helper (Plugin).app
│  └─ MyApp Helper (Alerts).app
└─ Contents/Resources/app/               ← user's bundled Bun code + assets
```

### The host executable

The host is produced with `bun build --compile` from a small bootstrap script. Its job, in order:

1. Resolve paths (app bundle root, resources, `libmirin_core.dylib`).
2. `dlopen` `libmirin_core` via `bun:ffi`.
3. Spawn the user's main-process code as a **Bun Worker** (`new Worker(appEntry)`).
4. Call `mirin_run(...)` on the **main thread**. This call never returns: Rust takes ownership of the thread, initializes CEF + AppKit (`NSApplication`), and runs the CEF message loop until quit.

This is the electrobun-proven model. The main thread belongs to AppKit/CEF for the process's lifetime; all user code lives on the Worker thread, where Bun's event loop runs unimpeded.

> **Spike (M1):** electrobun proves this handoff with a Zig core. Verify early that `cef`-crate initialization is happy inside a thread that Bun's runtime created (it is the real OS main thread, but Bun has touched it). This is the project's biggest derisking item.

### Helper binaries

Each CEF subprocess type is the same small Rust binary (`mirin-helper`) wrapped in per-type `.app` shells, as CEF requires on macOS. The helper calls `cef::execute_process` and, for renderer processes, installs mirin's render-process handler (preload injection — see §4).

## 2. Threading rules

- **Main thread**: AppKit and all CEF browser-process UI calls. Nothing else runs here. Rust code that must touch a window does so via `dispatch_async` to the main queue or `cef::post_task(TID_UI, …)`.
- **Bun Worker thread**: the user's entire main-process program, plus mirin's TypeScript runtime.
- **Rust internal threads**: IPC pump, CEF's own thread pool. No mirin code blocks the main thread waiting on the Worker, and vice versa — every cross-boundary call is either fire-and-forget or async with a completion callback.

## 3. The FFI boundary (Bun Worker ↔ Rust core)

`libmirin_core` exposes a flat C ABI, consumed through `bun:ffi`. Two directions:

**Commands (Bun → Rust).** Synchronous C calls that enqueue work and return immediately. Handle-returning calls (e.g. `mirin_window_create`) allocate the ID synchronously in Rust and return it; the actual AppKit/CEF work happens asynchronously on the main thread.

```
mirin_run(config_json, callbacks) -> never returns   // host bootstrap only
mirin_window_create(opts_json) -> u32                 // returns window id
mirin_window_set_title(id, title_ptr)
mirin_window_load_url(id, url_ptr)
mirin_window_close(id)
mirin_app_quit()
```

Options cross the boundary as JSON for the MVP. It's measurably slower than a binary layout and we don't care yet; these are low-frequency control calls. Revisit only with profiles in hand.

**Events (Rust → Bun).** Rust delivers events (window closed, webview ready, RPC payloads from webviews) through a `JSCallback` (threadsafe) registered at startup, carrying a JSON-encoded event. The TS runtime dispatches to typed emitters. If `JSCallback` throughput or threading proves flaky, fallback design: a `socketpair` between core and Worker with a length-prefixed JSON frame protocol — same envelope, different pipe.

**Envelope** (both directions where applicable):

```json
{ "v": 1, "kind": "event" | "cmd", "type": "window.closed", "target": 3, "payload": { } }
```

## 4. Webview ↔ Bun IPC

Two planes:

**Control plane (native).** Lifecycle, navigation, and preload injection use CEF machinery directly — no sockets involved.

**Data plane (developer RPC).** The typed RPC system (`docs/api-design.md` §3) runs over a **localhost WebSocket** hosted by the Bun Worker:

1. At startup the Worker opens a `Bun.serve` WebSocket server on an ephemeral port and generates a random per-session token.
2. Rust passes `port`+`token`+`webviewId` into each webview's preload environment.
3. The preload bootstrap (injected by `mirin-helper`'s render-process handler at V8-context creation, before any page script runs) connects and authenticates, then exposes `window.mirin` to page code.
4. RPC frames are JSON over that socket.

Rationale: this avoids routing the data plane through CEF process messages → browser process → FFI → Worker (three hops, two serializations), and electrobun ships the same shape in production. The token gates the localhost port; payload encryption (AES-256-GCM as electrobun does) is **deferred post-MVP** — note that any local process can sniff loopback in theory, so this is a known, accepted MVP gap.

Preload injection is renderer-side: `mirin-helper` implements CEF's render-process handler and evaluates the (build-time-bundled) preload bootstrap in `on_context_created`. The bootstrap is part of mirin, not user-supplied, for the MVP; user preloads come later.

## 5. CEF integration

- **Version pinning.** Mirin pins one CEF version per mirin release (whatever current `cef`/`cef-dll-sys` crates target). A fetch step (`scripts/fetch-cef.ts`) downloads the matching CEF binary distribution from the Spotify CDN into `vendor/cef/` (gitignored) and the dev bundle generator copies the framework from there.
- **Installed-cache safety.** Consumer builds download release CEF archives and their SHA-256 files over HTTPS-only redirects, verify integrity before parsing, reject traversal before extraction, reject escaping symlinks afterward, verify the platform marker, and only then replace the persistent `~/.mirinjs/cef` cache from a staging directory.
- **Linking.** The framework is loaded at runtime (`cef_load_library` path on macOS), keeping `libmirin_core` itself free of hard CEF linkage.
- **Bundle requirement.** CEF on macOS effectively requires the `.app` + helpers structure even during development. `mirin dev` therefore materializes a **dev bundle**: a throwaway `.app` skeleton (ad-hoc signed) whose Resources point at the working tree, so the edit-reload loop doesn't pay a full repackage.
- **Production locales.** `cef.locales` optionally keeps only selected locale packs in production bundles. Windows/Linux copy matching `locales/*.pak`; macOS retains the matching `.lproj` directory and its grammatical-gender variants before codesigning. Omission preserves the complete CEF runtime.
- **Release scheduling.** The signed app is immutable input for both updater and installer artifacts. Mirin starts DMG/Inno/Linux package creation before producing the updater tar, allowing external packaging tools and notarization to overlap zstd compression and delta generation.

## 6. Repository layout

```
mirin/
├─ crates/
│  ├─ mirin-core/        # cdylib: C ABI, windowing, CEF browser process, event routing
│  └─ mirin-helper/      # CEF subprocess binary (incl. render-process preload injection)
├─ packages/
│  ├─ mirin/             # runtime/config/RPC/client package (`mirinjs`)
│  ├─ mirin-cli/         # `mirin` CLI: init / dev / build / release
│  ├─ create-mirin/      # project scaffolder
│  └─ native-*/          # per-platform prebuilt core + helper packages
├─ examples/             # hello-react, kitchen-sink, spotlight, materials, updater
├─ scripts/              # CEF fetch, versioning, package, and release helpers
└─ docs/
```

Bun workspaces for `packages/*` + `examples/*`; a Cargo workspace for `crates/*`.

## 7. Sidecars & extra workers

The app runs in a single Bun Worker, but it's a full Bun runtime — so app code can
already `Bun.spawn(...)` and `new Worker(...)`. What it can't do alone is **bundle**
assets into the signed `.app`, **codesign/notarize** them, and **resolve their paths**
across dev vs prod. Two opt-in config blocks fill that gap (both macOS, both off by
default):

**Sidecars** — `sidecars: { name: "path/to/bin" | { bin, entitlements } }`. Each binary
is copied to `Contents/Resources/sidecars/<name>`, `chmod +x`, and codesigned in the
inside-out order (after `libmirin_core.dylib`, before the helpers) with the hardened
runtime + secure timestamp; per-binary `entitlements` are applied only when asked (most
CLIs need none). Spawn at runtime with `app.sidecar(name, { args, … })` — a thin
`Bun.spawn` wrapper that resolves the bundled path (`runtime().sidecarDir`) and tracks
the child so it's killed on quit. Sidecars are separate OS processes and, like the
Worker, must not touch AppKit/CEF. Sidecar names are validated as single safe filename
segments (`A-Z`, `a-z`, `0-9`, `.`, `_`, `-`), and source paths must be project-relative
without escaping the project root.

**Extra workers** — `workers: { name: "src/foo.worker.ts" }`. Each entry is bundled by
the CLI to `Contents/Resources/workers/<name>.js` (alongside the main `worker.js`).
Resolve one with `resolveWorker(name)` and hand it to `new Worker(...)`
(`node:worker_threads`) for CPU/IO offload. Same threading rule (§2): extra workers
run off the main thread and **cannot** issue window/native FFI — anything native is
requested from the app worker. They may `dlopen` the core for pure functions (as the
updater's codec does), but not UI commands. Worker names and entry paths follow the same
single-segment / project-root validation as sidecars.

Dev (`mirin dev`) stages both under `.mirin/{sidecars,workers}` and points the host at
them via `MIRIN_SIDECAR_DIR` / `MIRIN_WORKERS_DIR`; prod resolves them in-bundle
relative to `Contents/Resources`. The host threads both dirs to the Worker through
`workerData` (see `host.ts`, `runtime.ts`).

**Deep links** — `urlSchemes: ["anko"]` registers the app as the macOS handler for
`anko://…` URLs (written to `Info.plist` `CFBundleURLTypes` by
`bundle/macos/app.ts`). macOS
launches the app (or routes to the running instance — the per-app CEF cache dir makes
mirin apps single-instance) and delivers the URL to the AppKit delegate's
`application:openURLs:` (`mac/app.rs`), which emits an `app.open-url` native event the
Worker surfaces as `app.on("open-url", (url) => …)` — including the URL the app was
launched with.

## 8. Windows & Linux (implemented)

The host/Worker/FFI model is platform-independent — the FFI surface, CEF handlers,
`app://` scheme, event queue, and the whole RPC/data plane are shared. Only the
native layer (`mac/` vs `win/` vs `linux/`) and the bundle layout differ. `win/` and
`linux/` mirror `mac/` one-concern-per-module (`window`, `menu`, `tray`, `dialog`,
`clipboard`, `shortcut`); `engine/` routes to the platform module via `#[cfg]` arms.

**Windows is CEF, windowed.** CEF creates and owns a child HWND parented to a
mirin-owned top-level Win32 window (`WindowInfo::set_as_child`) — not the macOS
embedded-NSView/OSR model. Consequences:

- **Close lifecycle.** `CloseBrowser(false)` → `do_close` (which marks the window
  closing) → CEF sends `WM_CLOSE` to the top-level owner → the WndProc lets the
  *next* `WM_CLOSE` `DestroyWindow`, which tears down the CEF child and fires
  `on_before_close`. This is-closing handshake is the Windows analogue of macOS's
  view-detach dance (`win/window/mod.rs`).
- **Custom title bar** (`titleBarStyle: hidden | hiddenInset`): frameless via
  `WM_NCCALCSIZE` (client == window; maximized inset), DWM shadow restored with
  `DwmExtendFrameIntoClientArea`. The webview child consumes mouse input, so
  dragging can't be hit-tested on the parent — the preload bootstrap forwards each
  left-mousedown's coords as an internal `control` frame; the core checks them
  against CEF's `-webkit-app-region` regions and starts a native move via
  `ReleaseCapture` + `WM_NCLBUTTONDOWN`/`HTCAPTION` (the electrobun/tao approach).
  Native min/max/close are app-drawn (no native caption); the renderer calls
  `windowControls.{minimize,maximize,close}()` (`mirin/client`), which sends control
  frames the runtime maps to FFI window commands. App menu bar is a no-op on Windows
  (the app puts menus in its custom title bar).
- **GPU.** Auto-falls-back to software (`--disable-gpu`) in RDP sessions
  (`SM_REMOTESESSION`). On hybrid iGPU/dGPU laptops the default D3D11 ANGLE backend
  fails in the GPU process; `engine::angle_backend()` **auto-selects `gl`** when ≥2
  GPUs are present (`win/gpu.rs` counts display-adapter registry entries) to keep
  *hardware* acceleration with zero config. `MIRIN_ANGLE=<gl|d3d9|d3d11|vulkan|
  swiftshader>` overrides; `MIRIN_DISABLE_GPU=1` forces software. Per-Monitor-v2 DPI
  awareness is set before CEF init for crisp HiDPI.
- **Transparent / material windows** (`transparent: true`, `material`): like macOS,
  these render **windowless** (OSR) — a windowed CEF browser is always opaque. CEF
  paints a premultiplied-BGRA frame (`engine::osr`) that `win/osr.rs` composites with
  per-pixel alpha into a borderless layered window via `UpdateLayeredWindow`; input is
  forwarded from the WndProc into CEF. The macOS native vibrancy/Liquid-Glass backdrop
  has no clean CEF-windowed equivalent — plain per-pixel transparency is the baseline
  (matching electrobun); a DWM Mica/Acrylic blur backdrop is a future refinement.

**Bundle + distribution.** No `.app`/codesign — a flat app folder: `<App>.exe` (bun
host) + `mirin_core.dll` + `mirin-helper.exe` + the CEF runtime (libcef.dll, `*.pak`,
`icudtl.dat`, `locales/`) all beside the exe (so the OS loader resolves libcef), and
`resources/{ui, worker.js, mirin.manifest.json, version.json}`. `mirin dev`/`build`/
`release` branch on `process.platform` (`bundle/windows/index.ts`). `mirin release` emits an
**NSIS installer** (`…-setup.exe` — Program Files / per-user install, Start Menu +
Desktop shortcuts, uninstaller, Add/Remove Programs; customizable via the `nsis`
config, `installer-win.ts`; needs `makensis`, falls back to a portable `.zip`) +
a `.tar.zst` updater bundle + `{channel}-win32-{arch}-update.json`; the updater
swaps the folder via a detached PowerShell relauncher. Runtime updates require
HTTPS artifact hosts except loopback HTTP for local testing, validate that the
manifest matches channel/platform/arch, verify SHA-256 hashes, and reject update
tars whose entries escape the expected app root before extraction. Consumers
install the prebuilt `@mirinjs/win32-x64` native package + a CEF release download
(no Rust).
Build prereqs: cmake + ninja (for `cef-dll-sys`'s C++ wrapper) + MSVC.

**Material:** transparent OSR windows take a DWM acrylic blur backdrop via the
(runtime-resolved) `SetWindowCompositionAttribute`. **GPU:** the default D3D11 ANGLE
backend fails on some hybrid laptops — `MIRIN_ANGLE=gl` restores hardware accel.

**Known gaps (minor):** the updater's runtime folder-swap is implemented but not yet
field-tested; Mica (vs acrylic) backdrop; arm64-windows.

**Linux is CEF, X11 (Ozone), via CEF Views.** mirin forces `--ozone-platform=x11`
(env override `MIRIN_OZONE`); on a Wayland session the app runs under **XWayland**.
This mirrors Electrobun and replaces an earlier Wayland-native / OSR design that was
dropped — cosmic-comp draws server-side decorations with no CEF client-side-decoration
lever (so a borderless custom title bar was impossible on native Wayland), and the OSR
fallback was laggy with HiDPI scaling bugs. That OSR code was **deleted** — OSR is now
mac/Windows only. Unlike Windows' child-HWND model or macOS' embedded NSView, the Linux
port **owns no native toolkit window**:

- **Windowing (CEF Views).** The primary window uses CEF's Views framework:
  `window_create_top_level` owns a real X11 toplevel hosting a `BrowserView`
  (`browser_view_create`), driven through the Views delegates in `linux/window/mod.rs`.
  The mirin `window_id` is stamped on the BrowserView's `View::id` and read back in the
  shared `on_after_created` to map Browser → window. Frameless windows get a fill
  layout (`set_to_fill_layout`) so the view tracks resize; `can_resize`/`can_maximize`/
  `can_minimize` return true (else the WM sets fixed size hints).
- **Window management (Xlib).** Move/resize/live-resize, maximize/fullscreen/
  always-on-top, and the taskbar icon are driven via **Xlib** against the CEF window's
  XID (`Window::window_handle`), using the `x11-dl` crate (dlopens `libX11` — **no
  build-time X11 dev libs**). Move/resize use `_NET_WM_MOVERESIZE` (triggered from the
  preload's Win32-style hit-test on mousedown); before a resize mirin **deletes
  Chromium's `_NET_WM_SYNC_REQUEST_COUNTER`** so the compositor resizes live instead of
  blocking on Chromium's per-frame ack (which stalls under XWayland/cosmic). Maximize/
  fullscreen/always-on-top go through `_NET_WM_STATE`.
- **Custom title bar** (`titleBarStyle: hidden | hiddenInset`): `WindowDelegate::
  is_frameless` returns true → a truly borderless, GPU-rendered X11 window. The app
  draws its own header + min/max/close (no native caption, same as Windows), wired via
  `windowControls.{minimize,maximize,close}` (`mirin/client`) → control verbs.
- **Taskbar / window icon + app identity.** cosmic's dock keys off an X11 window's
  `WM_CLASS` and then an icon. A CEF Alloy Views window ships with neither, and Chromium
  clobbers them at realization, so mirin sets **`WM_CLASS`** (`XSetClassHint`; res_class
  = bundle id, res_name = its short name) and **`_NET_WM_ICON`** (a config PNG decoded
  in-core with the `png` crate to ARGB cardinals; 128×128 to stay under X11's max
  request size) and **re-asserts** both on delayed ticks (50/300/900 ms). A matching
  `.desktop` (`StartupWMClass`) is also generated — cosmic's reliable icon path.
- **GPU.** Forces `--ignore-gpu-blocklist --enable-gpu-rasterization
  --disable-gpu-sandbox` — without these the GPU process couldn't reach `/dev/dri`
  under the userns sandbox (no setuid chrome-sandbox) and Chromium fell back to
  software/SwiftShader. Now hardware-accelerated (amdgpu/Mesa verified);
  `MIRIN_DISABLE_GPU=1` still forces software.
- **Init config.** `CoreConfig` gained `icon_path` (resolved app-icon PNG for
  `_NET_WM_ICON`) and reuses `identifier` (bundle id → `WM_CLASS`); both are resolved
  host-side and ignored on macOS/Windows (which take icon + identity from the OS
  bundle).
- **Bundle + distribution.** No `.app`/codesign — a flat app folder like Windows:
  `<App>` (bun host) + `libmirin_core.so` + `mirin-helper` + the CEF runtime (libcef.so,
  `*.pak`, `icudtl.dat`, `v8_context_snapshot.bin`, `locales/`), all beside the host
  with an `$ORIGIN` rpath so `libcef.so` resolves without `LD_LIBRARY_PATH`, plus
  `resources/{ui, worker.js, mirin.manifest.json, version.json, icon.png}`. `mirin dev`/
  `build`/`release` branch on `process.platform` (`bundle/linux/index.ts`). Packaging
  (AppImage / `.deb` / `.rpm`) is landing this release — see `docs/linux-port.md` §L5.

Full status and rationale: `docs/linux-port.md`.
