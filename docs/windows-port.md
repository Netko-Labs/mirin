# Windows Port

Status of the Windows (CEF) port. Mirrors `docs/macos-mvp.md`. The host/Worker/FFI
model, CEF handlers, `app://` scheme, and the RPC/data plane are shared with macOS;
only `crates/mirin-core/src/win/*` (Win32) and the CLI's bundling differ. The shared
renderer helper exposes `window.mirin` only to the trusted top-level initial origin;
subframes/cross-origin navigations get no bridge, and disconnect rejects pending RPC
without replay. Engine = CEF, **windowed** (CEF owns a child HWND parented to a
mirin-owned top-level Win32 window) — not the macOS embedded-NSView/OSR model.

Targets Windows 10/11 x64 and arm64.

## Build prerequisites
- Rust `x86_64-pc-windows-msvc` or `aarch64-pc-windows-msvc` + MSVC (VS Build
  Tools, cl.exe).
- **cmake + ninja** on PATH — `cef-dll-sys` builds the libcef C++ wrapper with them.
- `bun scripts/fetch-cef.ts` populates `vendor/cef` (flat Windows distribution:
  libcef.dll, `*.pak`, `icudtl.dat`, `locales/`, …) via `export-cef-dir`.

## Milestones

### W0 — Build green + scaffolding — ✅ DONE
Cargo `windows-sys` deps; `lib.rs` `win` module; `engine` arms for `load_cef`
(no framework loader on Windows — libcef.dll resolves from the host-exe dir via the
import lib), `default_cache_dir` (`%LOCALAPPDATA%`), `derive_subprocess_path`
(`mirin-helper.exe`). Before spawning the Worker, the host takes an exclusive or
shared process-lifetime app-file handle; single-instance mode also acquires the
bundle-ID-scoped named mutex for compatibility and existing-window activation.
Only a protocol-compatible Worker's exclusive capability reaches the updater
apply path. `cargo build --workspace`
warning-clean. **The `cef` crate compiles and links on Windows** — the project's
biggest risk, cleared.

### W1 — Window MVP — ✅ DONE
`win/window/mod.rs`: mirin-owned top-level window (class + WndProc), CEF child via
`WindowInfo::set_as_child`, id↔HWND registry, child resize on `WM_SIZE`. The
`set_as_child` **close handshake** (do_close marks closing → next WM_CLOSE destroys
→ on_before_close → quit). `MIRIN_AUTOQUIT_MS` debug hook. Verified: `m1-smoke`
renders example.com (software), clean self-exit, zero orphan helpers.

### W2 — `mirin dev` runs Anko — ✅ DONE
`artifacts.ts` (win32 + dll/exe names), `bundle/windows/index.ts` (flat app folder + CEF
runtime copy), `dev.ts`/`host.ts` platform branches. Verified: Anko's React UI
renders in the CEF window, Vite HMR, typed RPC round-trips, clean close.

### W3 — `mirin build` standalone — ✅ DONE
Flat `build/<App>/` folder (host exe + dll + helper + CEF runtime + `resources/`).
`host.ts` prod path resolution per platform. Verified: cold-launch the `.exe` (no
env, no dev server) → UI from `app://`, RPC works, clean close.

### W4 — App-shell native features — ✅ DONE (gaps noted)
- **Window controls + events** — minimize/maximize/restore/fullscreen(borderless)/
  focus/show/hide/center/alwaysOnTop; `window.focus/blur/moved/resized` via the WndProc;
  set-title/position. Per-window close and `loadUrl()` use the shared browser registry,
  so one window never tears down or navigates another. `app.windows.open()` awaits
  `window.created`, and explicit quit also handles zero-window/creation-race states.
  Verified (minimize).
- **Custom title bar** — frameless (`WM_NCCALCSIZE` + DWM shadow); dragging via the
  preload → `window.maybeStartDrag` control frame (carrying click `detail`) →
  `ReleaseCapture`+`WM_NCLBUTTONDOWN` against CEF's `-webkit-app-region` regions.
  Verified: drag moves the window, **double-click (detail≥2) toggles maximize**, and the
  OS move loop gives **aero snap** (drag to top→maximize, edges→half).
- **App icon** — the bundler packs the iconset PNGs into `<App>/icon.ico` (`icons/windows/index.ts`,
  multi-size); the core loads it at runtime and sets it via `WM_SETICON` (taskbar /
  Alt-Tab / title). Verified (window has a non-null icon handle). Anko's existing
  `icon.iconset` works unchanged. (The `.exe` *file* icon in Explorer would need rcedit —
  bun's `--compile` has no `--windows-icon`.)
- **Window buttons** — app-drawn (no native caption); `mirin/client` `windowControls`
  + a control channel to FFI. Anko ships a Windows title-bar cluster. Verified.
- **Clipboard** — `CF_UNICODETEXT` read/write.
- **Global shortcuts** — `RegisterHotKey` + a message-only window for `WM_HOTKEY`.
- **Menus** — popup via `TrackPopupMenu` (custom items → `menu.click`); app menu bar
  is a no-op (frameless title bar; menus live in the app UI).
- **Tray** — `Shell_NotifyIcon` + context menu (`tray.click`/`menu.click`).
- **Dialogs** — `MessageBox` + common file open/save (single-select).
- **DPI** — Per-Monitor-v2 awareness set before CEF init.
- **Transparent windows** (`transparent: true` / `material`) — windowless (OSR), CEF's
  premultiplied-BGRA frame composited per-pixel into a layered window
  (`UpdateLayeredWindow`), input forwarded from the WndProc (`win/osr.rs`). Verified:
  a translucent box composites over the desktop.
- **Acrylic material** — transparent OSR windows take a DWM acrylic blur backdrop
  via the runtime-resolved `SetWindowCompositionAttribute` (Verified visually).
- **Folder + multi-select dialogs** — `SHBrowseForFolderW` + `GetOpenFileNameW`
  `OFN_ALLOWMULTISELECT` (buffer parsing).
- **Hardware GPU (auto)** — the default D3D11 ANGLE backend fails in the GPU process
  on hybrid laptops. `engine::angle_backend()` auto-selects `gl` when the system has
  ≥2 GPUs (`win/gpu.rs` counts display-adapter registry entries — a browser-process
  EGL probe was tried but *can't* predict the GPU-process failure, and DXGI needs the
  heavyweight `windows` crate). Zero-config: verified Anko + smoke run with no env vars
  → 0 GPU failures + clean close. `MIRIN_ANGLE=<backend>` still overrides; single-GPU
  machines keep Chromium's D3D11 default.

### W5 — Distribution — ✅ DONE (updater swap unverified)
`@mirinjs/win32-{arch}` prebuilt-native package + CLI optional dep; `artifacts.ts`
installed-mode + CEF release download (platform-generic). `mirin release` (verified)
emits `{channel}-win32-{arch}-update.json` + `.tar.zst` updater bundle + a real
**NSIS installer** (`…-setup.exe`, `installer-win.ts`). The generated script keeps
the owned payload under `$INSTDIR\\app` and the stable `Uninstall.exe` at the root.
A bundle-specific root marker gates recursive replacement and uninstall cleanup;
first install refuses a pre-existing unowned `app` collision.
A guarded migration recognizes the former flat Mirin layout from the app/core/helper/CEF/
manifest fingerprint, removes only enumerated payload files plus owned `resources` and
`locales`, and leaves unrelated root files intact. Uninstall repeats that guarded cleanup
as a fallback, removes the new payload recursively, deletes known shortcuts/registry/
uninstaller entries, then removes `$INSTDIR` non-recursively. Registry uninstall commands
quote executable paths containing spaces. Windows x64 CI covers flat → new → uninstall and
new-v1 → new-v2 → uninstall while preserving a root sentinel. Customizable via the `nsis`
config (perMachine/oneClick, shortcuts, license, publisher, runAfterFinish, installerIcon,
raw `include`); needs `makensis`, else falls back to the portable `.zip`. The Inno
alternative also replaces an owned `{app}\\app` payload on upgrade and marker-gates
enumerated cleanup of its legacy flat payload. Both generators share the ownership
marker, remove stale cross-tool uninstallers and exact bundle-keyed registry entries,
and preserve unrelated root files. Inno stores `unins000.*` under a bundle-specific
owned subdirectory, so cross-tool migration never guesses at or deletes another app's
uninstaller; it also recursively removes updater-added payload files during uninstall.
It accepts only absolute Windows install
paths or `{autopf}`/`{localappdata}` prefixes and escapes literal filesystem paths before
rendering `.iss`. Anko's
`build-windows` CI installs NSIS via choco. `updater/updater.ts` Windows arm: `win32` prefix,
`%LOCALAPPDATA%` support dir, bounded/generation-correlated download staging,
validated real app root + `<App>.exe` + `resources/version.json`, and a detached
PowerShell folder swap + relaunch. WMI launches PowerShell directly and records its
actual PID before the running app quits, so startup cleanup cannot delete its generation
and a failed marker write can terminate the complete helper. Accepted WMI launch is the
terminal handoff, so checks, downloads, applies, and auto-check scheduling remain blocked
until exit. Successful helpers remove their generation and launcher files; launch failures
clean launcher files best-effort, and startup prunes abandoned generations without touching
live app/helper work. The swap uses a unique backup, rejects stale backup collisions,
removes partial replacements before rollback, and verifies restoration. A private
handoff reservation admits only the staged version after the old PID releases its
OS lock. PowerShell keeps the backup until the replacement process writes a
Worker/native readiness receipt; early exit or timeout stops it, restores the old
folder, clears the reservation, and relaunches the prior executable. Runtime manifests
require a pinned Ed25519 signature, and every redirect hop is subject to the
HTTPS-or-loopback rule. `publish-all.ts` publishes the host-platform native package.
Release-time compression uses the standalone `mirin-codec.exe`, which has no CEF or Bun
FFI dependency.

Windows arm64 currently uses an x64 host/core/CEF compatibility payload because
Bun's native Windows arm64 runtime does not provide `bun:ffi`. Windows 11 ARM runs
that payload through its built-in x64 emulation. The arm64 package and release
asset names describe the supported host OS; native ARM execution requires the
planned Node-API bridge migration.

## Notes for contributors
- Testing local mirin against an installed-deps app (Anko): the worker bundles the
  *published* `mirinjs`, so `bun link` the local package (`bun link` in
  `packages/mirin`, `bun link mirinjs` in the app) or runtime changes won't apply.
  Clear the app's `node_modules/.vite` after changing `mirin/client` exports.
- GPU/close: a crash-looping GPU process also blocks the soft close — use
  `MIRIN_DISABLE_GPU=1` on affected machines.
