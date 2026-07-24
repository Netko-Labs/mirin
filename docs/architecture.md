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
3. Resolve configuration, honor any active updater handoff reservation, and
   acquire the process-lifetime app lock before user code starts.
   Single-instance processes take it exclusively; multi-instance processes take
   it shared, so the two modes cannot overlap. Windows also keeps a bundle-ID
   scoped named mutex and window class for compatibility and existing-window
   activation. Every identifier uses a domain-separated deterministic bounded
   prefix/hash identity so Win32 limits and literal compact-output collisions
   cannot prevent or conflate window creation, while
   macOS/Linux use nonblocking OS file locks. An incompatible launch exits
   without spawning a Worker.
4. Spawn the user's main-process code as a **Bun Worker** (`new Worker(appEntry)`),
   passing a versioned positive capability only when the singleton was actually
   acquired. Build/dev reject a project `mirinjs` version that differs from the
   CLI-owned host runtime; either side of an unexpected skew otherwise fails
   closed for updater apply.
5. Call `mirin_run(...)` on the **main thread**. This call never returns: Rust takes ownership of the thread, initializes CEF + AppKit (`NSApplication`), and runs the CEF message loop until quit.

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
mirin_acquire_instance_lock(config_json) -> 0|1|2     // unavailable/shared/exclusive
mirin_run(config_json, callbacks) -> never returns   // host bootstrap only
mirin_window_create(opts_json) -> u32                 // returns window id
mirin_window_set_title(id, title_ptr)
mirin_window_load_url(id, url_ptr)
mirin_window_close(id)
mirin_app_quit()
mirin_app_quit_for_update()                            // forced terminal handoff
```

Options cross the boundary as JSON for the MVP. It's measurably slower than a binary layout and we don't care yet; these are low-frequency control calls. Revisit only with profiles in hand.

**Events (Rust → Bun).** Rust appends JSON events such as `core.ready`,
`window.created`, `window.create-failed`, and `window.closed` to a process-global
queue. Creation results carry the allocated Mirin window id, so the Worker can
resolve or reject exactly the matching handle. The Worker drains
that queue through `mirin_poll_event` every 8 ms and dispatches by the event's
`type`. Polling is required because the host main thread is blocked inside
`mirin_run`; a bun:ffi callback invoked from that thread does not enter the
Worker's event loop. RPC payloads remain on the WebSocket data plane instead of
this low-frequency lifecycle queue.

**Event shape:**

```json
{ "type": "window.closed", "id": 3 }
```

## 4. Webview ↔ Bun IPC

Two planes:

**Control plane (native).** Lifecycle, navigation, and preload injection use CEF machinery directly — no sockets involved.

**Data plane (developer RPC).** The typed RPC system (`docs/api-design.md` §3) runs over a **localhost WebSocket** hosted by the Bun Worker:

1. At startup the Worker opens a `Bun.serve` WebSocket server on an ephemeral port and generates a random per-session token.
2. Rust passes `port` + `token` + `webviewId` and the browser's resolved initial URL through CEF `extra_info`.
3. `mirin-helper` parses the initial URL into a normalized `app:`, `http:`, or `https:` origin. At V8-context creation it injects the bootstrap only into the main frame and only when the current document still matches that origin. Subframes, opaque or malformed URLs, and cross-origin navigations receive no `window.mirin` capability.
4. The bootstrap connects and authenticates, then RPC frames are JSON over that socket.

Rationale: this avoids routing the data plane through CEF process messages → browser process → FFI → Worker (three hops, two serializations), and electrobun ships the same shape in production. The token gates the localhost port; payload encryption (AES-256-GCM as electrobun does) is **deferred post-MVP** — note that any local process can sniff loopback in theory, so this is a known, accepted MVP gap.

Preload injection is renderer-side: `mirin-helper` implements CEF's render-process handler and evaluates the build-time-bundled bootstrap in `on_context_created` only after the top-level trusted-origin check. The initial origin remains the capability boundary for the browser's lifetime: same-origin loads may receive the bridge again, while a cross-origin redirect or navigation does not. CEF may create a cross-origin replacement browser with the same numeric identifier before destroying the old browser, so endpoint state retains FIFO generations per identifier, uses the newest generation for contexts, and retires only the oldest generation on each destroy callback. The bootstrap is part of mirin, not user-supplied, for the MVP; user preloads come later.

A socket disconnect rejects and clears every outstanding renderer RPC promise.
Requests already sent are never replayed after reconnect because they may have
executed in the Worker; calls made after the disconnect may use the new
connection. Serialization failure removes the request before rejecting it, and
frames delivered by a replaced socket are ignored. This gives failures
at-most-once transport behavior instead of leaving promises pending forever or
allowing stale connections to settle current calls.

## 5. CEF integration

- **Version pinning.** Mirin pins one CEF version per mirin release (whatever current `cef`/`cef-dll-sys` crates target). A fetch step (`scripts/fetch-cef.ts`) downloads the matching CEF binary distribution from the Spotify CDN into `vendor/cef/` (gitignored) and the dev bundle generator copies the framework from there.
- **Installed-cache safety.** Consumer builds download release CEF archives and their SHA-256 files over HTTPS-only redirects, verify integrity before parsing, reject traversal before extraction, reject escaping symlinks afterward, verify the platform marker, and only then replace the persistent `~/.mirinjs/cef` cache from a staging directory.
- **Linking.** The framework is loaded at runtime (`cef_load_library` path on macOS), keeping `libmirin_core` itself free of hard CEF linkage.
- **Bundle requirement.** CEF on macOS effectively requires the `.app` + helpers structure even during development. `mirin dev` therefore materializes a **dev bundle**: a throwaway `.app` skeleton (ad-hoc signed) whose Resources point at the working tree, so the edit-reload loop doesn't pay a full repackage.
- **Production locales.** `cef.locales` optionally keeps only selected locale packs in production bundles. Windows/Linux copy matching `locales/*.pak`; macOS retains the matching `.lproj` directory and its grammatical-gender variants before codesigning. Omission preserves the complete CEF runtime.
- **Release scheduling.** Platform bundles and the release directory are assembled in unique sibling staging directories and replace the prior successful output only after required output succeeds. The signed app is immutable input for both updater and installer artifacts. Mirin starts DMG/Inno/Linux package creation before producing the updater tar, allowing external packaging tools and notarization to overlap zstd compression and delta generation. The installer promise is converted immediately to an always-settled result, so an early tool failure cannot terminate Bun before the release path waits for child ownership to end and cleans staging. DMG and Linux packages are best-effort and may be omitted from an otherwise valid atomic updater release; Windows installer failures remain fatal. Concurrent Linux format jobs are all settled before their shared package tree is cleaned; a failed set removes every expected output, including artifacts from rejected jobs. Failure to clean package output or shared staging aborts the release instead of committing a partial best-effort set. AppImage/deb/rpm payload copies omit standalone updater metadata because those installs update through their package channel. After a successful atomic swap, old-output cleanup is non-fatal because the new canonical output is already committed; later runs prune only aged real-directory backups with Mirin's exact PID/UUID name and a dead owner, without following links or matching prefix-sharing user directories. A standalone `mirin-codec` binary performs release-time zstd and bsdiff work without loading CEF or depending on Bun FFI; the runtime core links the same Rust codec library.
- **Updater transactions.** Packaged apps structurally parse their six-field `version.json` identity through a fixed-size read, including an Ed25519 manifest trust anchor and a safe dotted channel used consistently in artifact prefixes and support-directory paths. Every manifest has a detached signature over its exact bytes, is bounded before verification and JSON parsing, and is fetched through manual redirects that enforce HTTPS-or-loopback and a deadline on every hop/body. Only strictly newer SemVer precedence is accepted (build metadata does not make a release newer), and build tooling validates the same grammar before packaging. Manifest checks are single-flight. Each accepted manifest receives a generation tied to its version and tar hash; downloads use process/session-owned generation directories, checks are deferred while a download is active or an update is staged, and concurrent/repeated download/apply calls are rejected. A committed check may start its download directly from the `update-available` listener. Failure releases the transaction latch before nonthrowing best-effort cleanup, completed helpers remove their generation work directory, and startup prunes abandoned strict `generation-*` directories without following symlinks or deleting generations owned by live app processes or recorded apply-helper PIDs. Startup also prunes exact dead-owner `.mirin-new-<pid>-<uuid>` install siblings left by interrupted copies, while any live owner or recorded apply helper preserves them. Automatic apply requires a protocol-compatible Worker and the host's actually acquired exclusive app-lock capability, not configuration intent; apps that opt into multiple instances hold shared locks, may coexist with each other, and may check and stage an update but cannot overlap an exclusive updater-capable process or replace the shared install. The host resolves developer configuration and internal native overrides once, acquires the platform lock before spawning user code, and passes the versioned result to the Worker. Multi-instance processes receive PID-specific CEF cache directories on every platform. Before terminal handoff, Mirin copies the validated tree into a unique sibling of the installed app, revalidates the complete copy (including macOS code identity), and therefore limits the transaction itself to same-filesystem renames; managed AppImage/deb/rpm payloads omit updater metadata entirely. The detached helper validates its static prerequisites and writes a PID-bound armed acknowledgement before the updater enters terminal state. Only then does the runtime block further work and invoke the same monotonic forced quit used by the app lifecycle, rejecting pending and late window creation. A reservation beside the native app lock blocks ordinary launches after the old PID exits; only the helper's token-bearing target may cross it, and that target must acquire the exclusive lock. Reservations carry a bounded 24-hour lease so stale PID values cannot permanently block an app after process-ID reuse. The helper retains the old install until its exact launched PID reports Worker/native readiness through a private receipt. Every post-exit failure path clears owned state and relaunches a verified old canonical install; readiness failure uses bounded termination (TERM then KILL on POSIX), and an unkillable replacement preserves both trees for recovery instead of hanging or deleting the backup. Windows filesystem cmdlets use literal-path semantics. Manifest bodies, signatures, compressed artifacts, raw patches, reconstructed tars, entry counts, paths, and link targets have absolute limits; streaming reconstructed tar/decompression output is capped at 8 GiB while compressed artifacts, subprocess output, and archive structure remain independently bounded. In-memory patch inputs have a 512 MiB combined ceiling; release-time bsdiff source tars have a 128 MiB per-source ceiling because its suffix index amplifies memory. Larger deltas are skipped in favor of the full bundle. New manifests declare exact compressed sizes, `tarSize`, and patch `uncompressedSize`; bounded additive codec/FFI calls enforce decompression, patch-input, patch-output, and malformed-header ceilings while legacy codec calls remain available for trusted local use. Before apply, Mirin rejects traversal, sparse/special nodes, escaping symlinks/hardlinks, a linked/non-directory root, a missing/non-regular platform executable, and staged `version.json` identity drift. macOS requires executable mode and a stable installed designated code requirement; authenticated ad-hoc local builds fall back to codesign validity because their cdhash is build-specific. Linux extracts with permission preservation and ensures owner execute only after validating the regular host executable. Windows records the directly launched PowerShell PID before handoff. Release tar creation disables macOS AppleDouble sidecars so the archive has one expected root.

Startup cleanup begins only after any replacement-readiness receipt is written and
uses asynchronous filesystem operations, keeping recursive deletion off the helper's
30-second readiness path and the app event loop. The `.mirin-new-<pid>-<uuid>` form
above is recognized as a legacy owned sibling; new siblings use
`.mirin-new-<pid>-<session>-<createdAt>-<uuid>`. Current-PID reuse must match the
process session, while otherwise unverifiable live owner/helper PIDs have a 24-hour
lease before cleanup may reclaim their trees.

Install-filesystem updater staging preserves relative symlink text before
revalidation, so macOS framework links remain scoped to the copied app instead
of being rebound to the download generation.

### Window lifecycle guarantees

The shared `MirinHandler` owns the browser list and browser-id → window-id map.
Per-window close and navigation snapshot the matching `Browser` while holding the
handler mutex, release the mutex, and only then call CEF. `close_browser` and
`Frame::load_url` may re-enter lifecycle handlers, so they must never run under
that lock. Native close gestures route through the same targeted browser close;
only explicit app quit closes every browser.

`app.windows.open()` resolves when the matching native `window.created` event is
observed, not when the create command is merely queued. Pending creations are
reserved by Mirin window id; popup and DevTools callbacks cannot consume those
reservations. Synchronous platform/CEF creation failure tears down partial native
and OSR state, releases that exact id, and emits `window.create-failed`, which
rejects and unregisters the matching TypeScript handle.

Automatic manifest windows are all awaited before `app.ready` fires. A failure
prevents `ready` and requests orderly application quit. Pre-ready macOS Dock
policy is flushed at `core.ready`, before automatic windows are opened. Explicit
quit is monotonic: it records the process-wide request and force-closes every
current or late-created browser, even when another browser is already closing,
so `beforeunload` cancellation cannot leave the app permanently half-quit.
Queued creation tasks are canceled with correlated failures. The loop ends only
when both live browsers and pending creation ids are zero; a reservation rollback
that reaches zero schedules a UI-thread idle-finish check.

## 6. Repository layout

```
mirin/
├─ crates/
│  ├─ mirin-codec/       # shared updater codec library + release helper binary
│  ├─ mirin-core/        # cdylib: C ABI, windowing, CEF browser process, event routing
│  └─ mirin-helper/      # CEF subprocess binary (incl. render-process preload injection)
├─ packages/
│  ├─ mirin/             # runtime/config/RPC/client package (`mirinjs`)
│  ├─ mirin-cli/         # `mirin` CLI: init / dev / build / release
│  ├─ create-mirin/      # project scaffolder
│  └─ native-*/          # per-platform prebuilt core, codec, and helper packages
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

**Notifications** — `notification.show({ title, body? })` crosses the Bun FFI boundary
as one validated JSON payload and delegates to the platform notification service via
`notify-rust`. Delivery is best-effort and has no action/click lifecycle.

**Sidecars** — `sidecars: { name: "path/to/bin" | { bin, entitlements } }`. Each binary
is copied to `Contents/Resources/sidecars/<name>`, `chmod +x`, and codesigned in the
inside-out order (after `libmirin_core.dylib`, before the helpers) with the hardened
runtime + secure timestamp; per-binary `entitlements` are applied only when asked (most
CLIs need none). Spawn at runtime with `app.sidecar(name, { args, … })` — a thin
`Bun.spawn` wrapper that resolves the bundled path (`runtime().sidecarDir`) and tracks
the child so it's killed on quit. Use `resolveSidecar(name)` when the application needs
the staged path without launching it, such as installing a user-facing command. Sidecars are separate OS processes and, like the
Worker, must not touch AppKit/CEF. Sidecar names are validated as single safe filename
segments (`A-Z`, `a-z`, `0-9`, `.`, `_`, `-`). The CLI canonicalizes the project root
and each source before any build/dev output is touched, rejects lexical or symlink
escapes plus missing/directory/special sources, and copies production sidecars as new
regular files before changing destination permissions. This prevents a bundled symlink
or `chmod` from mutating the project source.

**Extra workers** — `workers: { name: "src/foo.worker.ts" }`. Each entry is bundled by
the CLI to `Contents/Resources/workers/<name>.js` (alongside the main `worker.js`).
Resolve one with `resolveWorker(name)` and hand it to `new Worker(...)`
(`node:worker_threads`) for CPU/IO offload. Same threading rule (§2): extra workers
run off the main thread and **cannot** issue window/native FFI — anything native is
requested from the app worker. They may `dlopen` the core for pure functions (as the
updater's codec does), but not UI commands. Worker names and entry paths follow the same
single-segment, canonical containment, and regular-file validation as sidecars.

Dev (`mirin dev`) stages both under `.mirin/{sidecars,workers}` and points the host at
them via `MIRIN_SIDECAR_DIR` / `MIRIN_WORKERS_DIR`; prod resolves them in-bundle
relative to `Contents/Resources`. The host threads both dirs to the Worker through
`workerData` (see `host.ts`, `runtime.ts`).

**Deep links** — `urlSchemes: ["anko"]` registers the app as the macOS handler for
`anko://…` URLs (written to `Info.plist` `CFBundleURLTypes` by
`bundle/macos/app.ts`). macOS
launches the app (or routes to the running instance — the native per-app lock is
acquired before user code starts) and delivers the URL to the AppKit delegate's
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

- **Close lifecycle.** `CloseBrowser(false)` → `do_close` (which marks that exact
  window closing) → CEF sends `WM_CLOSE` to the top-level owner → the WndProc lets
  the *next* `WM_CLOSE` `DestroyWindow`, which tears down the CEF child and fires
  `on_before_close`. This per-window acknowledgement is the Windows analogue of
  macOS's view-detach dance (`win/window/mod.rs`). Explicit app quit upgrades all
  current and later closes to `CloseBrowser(true)`.
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
`resources/{ui, worker.js, mirin.manifest.json, version.json}`. The six-field
`version.json`, including its Ed25519 manifest trust anchor, is serialized and
parsed back by CLI-private validation, and every
platform bundle revalidates app name/id/channel/version plus icon and extra-asset
sinks before assembling a unique sibling stage. The stage replaces the prior
output only after the complete bundle succeeds. `mirin dev`/`build`/`release` branch on `process.platform`
(`bundle/windows/index.ts`). `mirin release` emits an **NSIS installer**
(`…-setup.exe` — Program Files / per-user install, Start Menu + Desktop shortcuts,
uninstaller, Add/Remove Programs; customizable via the `nsis` config,
`installer-win.ts`; needs `makensis`, falls back to a portable `.zip`). Its owned app
payload lives under `$INSTDIR\\app`; upgrades remove that directory only when a
bundle-specific root marker proves ownership. A first install refuses a pre-existing
unowned `app` collision.
A five-marker fingerprint gates cleanup of the former flat NSIS/Inno payload, which deletes
only enumerated root files and owned `resources`/`locales`. `Uninstall.exe` remains at
`$INSTDIR`; uninstall repeats the guarded legacy cleanup, recursively removes only `app`,
deletes known shortcuts/registry/uninstaller entries, then attempts a non-recursive root
removal so unrelated user files survive. Inno uses the same ownership marker and
`app` payload boundary, recursively cleans updater-added payload files on uninstall,
applies the same marker-gated enumerated cleanup to legacy flat payloads, and stores
`unins000.*` under a bundle-specific owned directory. Switching installer toolchains
removes only the prior tool's exact owned uninstaller and
bundle-keyed registry entry only after the flat fingerprint or shared ownership
marker matches. Inno accepts absolute Windows install paths or
`{autopf}`/`{localappdata}` prefixes, and escapes literal script paths. It also emits
a `.tar.zst` updater bundle + `{channel}-win32-{arch}-update.json`; the updater
swaps the folder via a detached PowerShell relauncher. WMI directly launches
PowerShell and records its actual PID. The helper preflights its literal app,
backup, and same-volume stage paths and writes an armed acknowledgement, so the
running app quits only after the complete helper is accepted. That acceptance is the terminal handoff point: updater
operations and auto-check scheduling remain blocked through process exit. Successful
helpers remove their generation and temporary launcher files; launch failures clean
temporary files best-effort, and the next startup prunes abandoned generations while
preserving work owned by live app processes.
Runtime updates require HTTPS artifact hosts except loopback HTTP for local testing,
enforce the bounded generation transaction above, verify SHA-256 hashes, and validate
the extracted root, executable, and embedded identity before apply. The post-exit
folder swap keeps its backup until the exact token-bearing replacement PID acquires
the exclusive lock and writes a durable readiness receipt; every post-exit failure
rolls back and reopens the prior install. Consumers
install the prebuilt `@mirinjs/win32-{arch}` native package + a CEF release download
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
  `build`/`release` branch on `process.platform` (`bundle/linux/index.ts`). Updater tar
  extraction uses `tar -xpf`; structural validation rejects linked/special executables
  before ensuring owner execute on the regular host file. Detached relaunch enters the
  terminal handoff, reserves the app lock for the staged version, and removes the
  successful generation only after a readiness receipt, while startup prunes abandoned
  generations without touching live-process work. Managed AppImage / `.deb` / `.rpm`
  payloads omit updater metadata and use their package channel instead. See
  `docs/linux-port.md` §L5.

Full status and rationale: `docs/linux-port.md`.
