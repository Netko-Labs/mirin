# Windows Port

Status of the Windows (CEF) port. Mirrors `docs/macos-mvp.md`. The host/Worker/FFI
model, CEF handlers, `app://` scheme, and the RPC/data plane are shared with macOS;
only `crates/mirin-core/src/win/*` (Win32) and the CLI's bundling differ. Engine =
CEF, **windowed** (CEF owns a child HWND parented to a mirin-owned top-level Win32
window) — not the macOS embedded-NSView/OSR model.

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
(`mirin-helper.exe`). `cargo build --workspace` warning-clean. **The `cef` crate
compiles and links on Windows** — the project's biggest risk, cleared.

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
  set-title/position. Verified (minimize).
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
**NSIS installer** (`…-setup.exe`, `installer-win.ts`). Verified end-to-end: silent
install (`/S /D=`) → 252 files + Add/Remove Programs entry, the installed app
cold-launches (0 GPU failures), silent uninstall removes the folder + registry key.
Customizable via the `nsis` config (perMachine/oneClick, shortcuts, license,
publisher, runAfterFinish, installerIcon, raw `include`); needs `makensis`, else
falls back to the portable `.zip`. Anko's `build-windows` CI installs NSIS via choco. `updater/updater.ts` Windows arm: `win32` prefix,
`%LOCALAPPDATA%` support dir, bounded/generation-correlated download staging,
validated real app root + `<App>.exe` + `resources/version.json`, and a detached
PowerShell folder swap + relaunch. The launch VBScript propagates
`Win32_Process.Create` failure before the running app quits. Accepted WMI launch is
the terminal handoff, so checks, downloads, applies, and auto-check scheduling remain
blocked until exit. Successful helpers remove their generation and launcher files;
launch failures clean launcher files best-effort, and startup prunes abandoned
generations without touching live-process work. The post-exit swap still has no durable success acknowledgement and is
not field-tested.
`publish-all.ts` publishes the host-platform native package. Release-time
compression uses the standalone `mirin-codec.exe`, which has no CEF or Bun FFI
dependency.

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
