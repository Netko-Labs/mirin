# Linux Port

Status of the Linux (CEF) port. Mirrors `docs/windows-port.md`. The host/Worker/FFI
model, CEF handlers, `app://` scheme, and the RPC/data plane are shared with macOS
and Windows; only `crates/mirin-core/src/linux/*` and the CLI's bundling differ.

**Linux forces X11 (Ozone).** mirin appends `--ozone-platform=x11` (override with
`MIRIN_OZONE`); on a Wayland session the app runs under **XWayland**. This mirrors
Electrobun and **replaces the earlier Wayland-native / OSR design**, which was
dropped:

- On native Wayland, cosmic-comp draws **server-side decorations** and CEF exposes
  no client-side-decoration lever, so a borderless custom title bar was impossible.
- The offscreen-rendering (OSR) fallback — render the browser off-screen and
  composite into a mirin-owned Wayland surface — was **laggy and had HiDPI scaling
  bugs**. It has been **deleted** (`crates/mirin-core/src/linux/osr.rs` is gone; the
  Linux arms of the shared `engine/osr.rs` were removed — OSR is now mac/Windows
  only).

On X11 a *windowed* CEF **Views** browser is truly borderless via the WM's frameless
hint (`WindowDelegate::is_frameless`), GPU-rendered, with native input / IME / HiDPI.
So the Linux port keeps the win/mac one-concern-per-module split but does **not** own
a native toolkit window and does **not** use the Windows child-HWND (`set_as_child`)
model:

- The primary window uses CEF's **Views** framework: `window_create_top_level` owns a
  real X11 toplevel hosting a `BrowserView` (`browser_view_create`), driven through
  the Views delegates in `linux/window/mod.rs`. Frameless windows get a **fill layout**
  (`set_to_fill_layout`) so the browser view tracks resize.
- Window **management** (move / resize / live-resize, maximize / fullscreen /
  always-on-top, taskbar icon, app id) is done via **Xlib** against the CEF window's
  XID (`Window::window_handle`) — the `x11-dl` crate, which *dlopens* `libX11` at
  runtime, so there are **no build-time X11 dev libraries** required for this path.

## Build prerequisites
- Rust `x86_64-unknown-linux-gnu` or `aarch64-unknown-linux-gnu` + a C/C++
  toolchain (gcc/clang).
- **cmake + ninja** on PATH — `cef-dll-sys` builds the libcef C++ wrapper with them.
- GTK3 + X11 dev headers present (CEF Linux runtime deps). Note: mirin's own Xlib
  window management uses `x11-dl` (dlopen), so it needs no X11 dev libs of its own.
- `bun scripts/fetch-cef.ts` populates `vendor/cef` (flat Linux distribution:
  `libcef.so`, `*.pak`, `icudtl.dat`, `v8_context_snapshot.bin`, `locales/`,
  `chrome-sandbox`, …) via `export-cef-dir` (auto-selects the host Linux arch).

## Windowing (`linux/window/mod.rs`)

**CEF Views toplevel.** `MirinWindowDelegate` + `MirinBrowserViewDelegate` (via
`wrap_window_delegate!` / `wrap_browser_view_delegate!`) with an id→Window registry.
The mirin `window_id` is stamped on the BrowserView's `View::id`, read back in the
shared LifeSpanHandler's `on_after_created` to map a Browser → its window. `can_resize`
/ `can_maximize` / `can_minimize` all return **true** — CEF's `can_*` delegates default
to false, and a non-resizable window gets fixed WM size hints that make the compositor
refuse `_NET_WM_MOVERESIZE` resizes.

**Frameless windows.** `titleBarStyle: 'hidden' | 'hiddenInset'` → `is_frameless`
returns true → a truly borderless X11 window (no WM caption or resize border). The app
draws its own chrome; mirin drives window management via Xlib.

**Move / resize** — the renderer preload runs a Win32-style hit-test on left-mousedown
and forwards it as `window.maybeStartDrag` (CSS-px coords, click `detail`, and an edge
hit-test code); the core translates it into a `_NET_WM_MOVERESIZE` client message
against the window's XID (move = direction 8; the 8 resize edges = directions 0..7). A
title-bar double-click toggles maximize.

**Live resize** — before starting a resize mirin **deletes Chromium's
`_NET_WM_SYNC_REQUEST_COUNTER`** property from the window. Otherwise the compositor
blocks on Chromium's per-frame ack (basic frame sync) — a handshake that stalls under
XWayland / cosmic, so the window would only resize on mouse-release. With the counter
gone the compositor resizes live (Chromium repaints as it can).

**Maximize / fullscreen / always-on-top** — via CEF Views (`is_maximized`/`maximize`/
`restore`, `set_fullscreen`, `set_always_on_top`), which set the corresponding
`_NET_WM_STATE` atoms on X11. `control()` maps the client `windowControls.*` verbs
(minimize, maximize toggle, restore, fullscreen toggle, focus/blur, show/hide,
alwaysOnTop:on/off).

## GPU

mirin forces **`--ignore-gpu-blocklist --enable-gpu-rasterization
--disable-gpu-sandbox`**. Without them the GPU process couldn't reach `/dev/dri` under
the userns sandbox (mirin ships no setuid `chrome-sandbox`), and Chromium fell back to
software / SwiftShader — which made windowed rendering, and interactive resize
especially, lag badly. Dropping *only* the GPU sandbox keeps the renderer and other
processes sandboxed while letting the GPU process use the card. Now
**hardware-accelerated** (verified on amdgpu / Mesa). `MIRIN_DISABLE_GPU=1` still
forces software.

## Taskbar / window icon + app identity (X11)

cosmic's dock identifies an X11 window by its **`WM_CLASS`** (app-id) and only then
resolves an icon. A CEF Alloy Views window ships with neither `WM_CLASS` nor an icon,
and Chromium **clobbers** whatever we set at window realization — so mirin sets them
itself in `install_window_props` and **re-asserts** them post-map on delayed UI ticks
(`PROPS_REASSERT_DELAYS_MS = [50, 300, 900]` ms) so the last writer is us:

- **`WM_CLASS`** — `res_class` = the app's bundle id (`engine::wm_class`, from the init
  config `identifier`, e.g. `dev.netko.anko`), `res_name` its lowercased last segment
  (`anko`). Set via `XSetClassHint`.
- **`_NET_WM_ICON`** — the config `icon` is resolved host-side to a concrete PNG,
  passed through the init config as `icon_path`, decoded in-core (the `png` crate) to
  the ARGB CARDINAL array, and written with `XChangeProperty`. The resolver prefers a
  **128×128** icon: a 256×256 icon's property (~256 KB) exceeds X11's max request size
  and is silently dropped, whereas 128² (~64 KB) is safe.
- **`.desktop` entry** — cosmic's dock keys off `WM_CLASS → .desktop` match, so the
  CLI also generates a matching `.desktop` with `StartupWMClass=<bundle id>` and
  `Icon=<largest iconset PNG>`. This is the reliable icon path (same as Electron /
  Tauri); the bare `_NET_WM_ICON` fallback for XWayland toplevels is unreliable on
  cosmic. In dev the CLI writes `~/.local/share/applications/<id>.desktop`; prod stages
  the icon at `resources/icon.png` and the installer drops the `.desktop`.

## FFI / init config

The init config (`CoreConfig`) carries two Linux-relevant fields (both resolved
host-side, ignored on macOS/Windows which take the icon and identity from the OS
bundle):

- **`icon_path`** — the resolved concrete app-icon PNG, decoded in-core for
  `_NET_WM_ICON`.
- **`identifier`** — the app bundle id, from which the window's `WM_CLASS` is derived.

## Custom title bar

Frameless windows have no native caption buttons on Linux, so apps draw their own
min / max / close (same as Windows), wired through the `windowControls.*` client API to
control verbs (`minimize`, `maximize` toggle, `window.close`). The draggable header is
the app's `-webkit-app-region: drag` region, hit-tested in the preload and turned into
a native move via `_NET_WM_MOVERESIZE` (see Windowing above).

## Milestones

### L0 — Build green + scaffolding — ✅ DONE
Cargo builds `cef`/`cef-dll-sys` on Linux (the project's biggest risk — **cleared**).
`lib.rs` `linux` module; engine `#[cfg]` arms for `load_cef` (no framework loader —
`libcef.so` resolves via the link path / rpath), `default_cache_dir`
(`$XDG_CACHE_HOME`), `derive_subprocess_path` (`mirin-helper`). `linux/window/mod.rs` holds
the CEF **Views** integration and the id→Window registry. `cargo build --workspace`
warning-clean.

### L1 — Window MVP (m1-smoke) — ✅ DONE
`m1-smoke` renders a page in a native CEF **Views** X11 toplevel, full CEF subprocess
fleet, clean self-exit (code 0), zero orphan helpers via the autoquit →
`close_all_browsers` → `on_before_close` → `quit_message_loop` path. The window-button
close routes through `WindowDelegate::can_close` → `try_close_browser`. Uses the CEF
namespace sandbox (unprivileged userns; no setuid `chrome-sandbox`).

### L2 — `mirin dev` runs Anko — ✅ DONE
CLI wired for Linux: `artifacts.ts` (linux `libmirin_core.so`, `mirin-helper`,
`libcef.so` marker), `bundle/linux/index.ts` (flat app dir + CEF runtime copy), `dev.ts`/
`host.ts` linux branches (flat `resources/` layout, `MIRIN_CORE=…/libmirin_core.so`,
`LD_LIBRARY_PATH`=app dir). **Verified:** `mirin dev` builds the Rust core + helper,
compiles the host + bundles the Worker, assembles the Linux app dir, starts Vite, and
launches Anko — Anko's full React UI renders in a CEF Views window loaded from Vite,
with the typed RPC data plane connected.

Two Linux-specific fixes beyond the platform branches: (1) the FFI
`mirin_window_create` path (`CreateWindowTask::execute`) was gated to macOS/Windows —
added the `linux` arm; (2) Vite bound `[::1]` while Chromium resolves `localhost` →
`127.0.0.1`, so `dev.ts` now pins Vite and the dev URL to `127.0.0.1` (also matches the
loopback RPC server).

**Contributor note:** test the local mirin against an installed-deps app by
`bun link`-ing `mirinjs` + `@mirinjs/cli` into it (the CLI's in-repo detection then
builds the Rust from source and uses `vendor/cef`). Requires `cmake`/`ninja`.

### L3 — `mirin build` standalone — ✅ DONE
`build.ts` linux branch → `buildLinuxBundle` with prod `resources/` (dist ui, worker,
manifest, version.json, sidecars). Flat `build/<App>/`: host bin + `libmirin_core.so` +
`mirin-helper` + CEF runtime + `resources/`. **`$ORIGIN` rpath** baked into the core
lib + helper + m1-smoke (`.cargo/config.toml` rustflags), so `libcef.so` resolves with
**no `LD_LIBRARY_PATH`** — a fully self-contained bundle. **Verified:** the standalone
`build/Anko/Anko` cold-launches with a clean env → renders Anko's UI from **`app://`**
with the typed RPC data plane connected; `ldd` confirms `libcef.so` resolves via
`$ORIGIN`. The portable-folder updater extracts with `tar -xpf`, requires a real
staged root and regular `<App>` executable, then ensures owner execute only after
that validation. It also requires matching `resources/version.json`, bounded
manifest/download/codec output with an 8 GiB reconstructed-tar/decompression ceiling,
and safe tar entry/link types before launching the asynchronous folder swap. Accepted
helper launch is a terminal handoff; successful helpers remove their generation and
startup prunes abandoned generations. This does not redesign Linux updates around
deb/rpm/AppImage package managers; that remains out of scope.

### L4 — App-shell native features — 🚧 PARTIAL
`examples/kitchen-sink` renders and runs the full "Native feature tour" over RPC.
Feature status:

- **Window controls** — ✅ minimize / maximize (toggle) / restore / fullscreen /
  always-on-top / activate / show / hide via CEF Views (`linux::control`).
- **Custom title bar / frameless** — ✅ **works on X11.** `is_frameless` yields a truly
  borderless window; the app draws its own header + min/max/close, and mirin drives
  native move / resize / live-resize / double-click-maximize via `_NET_WM_MOVERESIZE`
  against the XID (see Windowing). This is what the dropped Wayland-native/OSR plan
  could not achieve, and is the reason for the X11 pivot.
- **Window / taskbar icon** — ✅ `WM_CLASS` + `_NET_WM_ICON` (re-asserted post-map) +
  a matching `.desktop` (`StartupWMClass`). See "Taskbar / window icon" above.
- **GPU** — ✅ hardware-accelerated (blocklist ignored, GPU sandbox dropped). See "GPU".
- **Clipboard** — ⬜ TODO (engine `not(any(macos,windows))` no-op fallback for now).
- **Global shortcuts** — ⬜ TODO (mechanism TBD; likely the `GlobalShortcuts`
  xdg-portal).
- **Menus** — app menu bar is a no-op (like Windows; menus live in the app UI);
  context/popup menus ⬜ TODO (Views `MenuModel`).
- **Tray** — ⬜ TODO (StatusNotifierItem, e.g. `ksni`).
- **Dialogs** — ⬜ TODO (`xdg-desktop-portal` FileChooser, e.g. `ashpd`/`rfd`).
- **Deep links** (`urlSchemes`) — ⬜ TODO (`.desktop` MIME registration).
- **Transparent / material** — ⬜ TODO. A windowed X11 CEF browser is always opaque;
  true transparency would need OSR (as `win/` does), which the Linux port currently
  does not have (the OSR path was removed in the X11 pivot).

### L5 — Distribution — ✅ DONE
Linux packaging lives in `packages/mirin-cli`:

- `@mirinjs/linux-x64` and `@mirinjs/linux-arm64` prebuilt-native packages ship
  the core lib and helper for installed consumers.
- `mirin build --linux` and `mirin release` can emit **AppImage** (`appimagetool`) plus
  **`.deb` / `.rpm`** (`fpm`) from the assembled flat app folder.
- Each package stages a `.desktop` entry with a matching `StartupWMClass`, a hicolor
  icon, and a wrapper/AppRun that executes the real host binary inside the payload.
- Package metadata is validated before writing launchers or desktop files: app ids are
  single path segments, desktop fields reject line injection, and CLI/config package
  formats are restricted to `appimage`, `deb`, and `rpm`.

## Notes for contributors
- App-shell features not yet ported are handled by the engine's
  `not(any(macos, windows))` fallback arms (no-ops) so the build stays green; they
  grow into `linux/` submodules.
- The Linux port owns no native toolkit window: window management is Xlib-against-the-
  CEF-XID, not a mirin-owned toplevel. Don't port the Windows child-HWND model, and
  don't reach for the deleted OSR path — see `docs/architecture.md` §8.
