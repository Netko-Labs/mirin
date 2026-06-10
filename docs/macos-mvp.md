# macOS MVP Plan

Goal: **a developer can `bunx mirin init`, write a typed config + RPC router, run `mirin dev`, and get a real CEF window on macOS talking to their Bun code with full type inference.** No packaging, menus, tray, or updater in this milestone.

Targets macOS 13+ (arm64 first, x64 builds once CI exists).

## Milestones

### M0 — Scaffold
- Cargo workspace (`crates/mirin-core`, `crates/mirin-helper`), Bun workspace (`packages/mirin`, `packages/mirin-cli`, `examples/hello`).
- `scripts/fetch-cef.ts`: download + cache the pinned CEF binary distribution into `vendor/cef/`.
- `scripts/dev-bundle.ts`: materialize the dev `.app` skeleton (host exe, helpers, CEF framework, ad-hoc codesign) — see architecture.md §5.

### M1 — Window (pure Rust, no Bun) ⚠ derisking milestone — ✅ DONE
- `mirin-core` + `mirin-helper` initialize CEF via the `cef` crate, open a **mirin-owned NSWindow** with a CEF browser embedded as a child view, load `https://example.com`.
- Driven by the temporary `m1-smoke` bin (`crates/mirin-core/src/bin/m1_smoke.rs`) run from inside the dev `.app` bundle, so CEF/bundle/signing issues surfaced before any FFI exists.
- **Exit criteria — all met:** window renders real Chromium; app quits cleanly via both the red button and programmatic quit (`MIRIN_AUTOQUIT_MS` debug hook); zero orphan helper processes; healthy 1 browser + 5 helper process tree, no crashes.
- **Hard-won result — embedded-view close lifecycle.** A browser parented into an app-owned NSWindow (`set_as_child`) does *not* complete CEF's close lifecycle by default — `on_before_close` never fires, so the message loop never quits. The working recipe (see `MirinHandler::do_close` + `mac::detach_browser_view`): **Alloy runtime** for the embedded browser; close via **non-force** `CloseBrowser(false)`; in `do_close` **detach CEF's view from its superview** (`removeFromSuperview`) and return false — that "host view destroyed via view hierarchy tear-down" is what makes CEF destroy the browser and fire `on_before_close`. Also required: never hold the handler mutex across `close_browser` (it re-enters `on_before_close` → deadlock), and drive the red-button path through `windowShouldClose:` (initiate CEF close, return NO; allow once `is_closing`).
- **Environment notes:** needs Rust ≥ 1.91 (cef-rs deps); `use-mock-keychain` switch suppresses the repeated keychain prompt that ad-hoc re-signing otherwise triggers; `root_cache_path` must be set (cef-rs #287).

### M1.5 — Main-thread handoff spike ⚠ — ✅ DONE
- Bun-compiled host `dlopen`s libmirin_core via `bun:ffi`, spawns the user app as a Worker, and calls `mirin_run()` on the main thread (which hands the thread to CEF+AppKit). The Worker stays responsive; CEF is happy on the Bun-owned main thread. The architecture's riskiest assumption holds — no two-process fallback needed.
- **Key finding — event delivery is polled, not callback-based.** A bun:ffi threadsafe `JSCallback` invoked from the host's main thread does **not** reach the Worker's event loop, because that thread is blocked inside `mirin_run` (the CEF loop). But the host's and Worker's `dlopen` of the same dylib **share Rust statics** (verified: the Worker reads a flag the host set). So events go through a queue: Rust buffers them (`EVENT_QUEUE`), the Worker drains via `mirin_poll_event` on an 8ms interval. The RPC data plane stays on its own WebSocket (low latency); only low-frequency control events poll.

### M2 — FFI surface + declarative boot — ✅ DONE
- C ABI (lib.rs): `mirin_run`, `mirin_poll_event`, `mirin_set_rpc_endpoint`, `mirin_is_ready`, `mirin_window_create/close/load_url/set_title`, `mirin_app_quit`. Window registry keyed by id; close events route back by mapping browser→window.
- `packages/mirin`: `app` singleton + `WindowHandle`, manifest-driven window opening on `core.ready`, typed events. Host bootstrap (`host.ts`) `bun build --compile`d into the bundle's `Contents/MacOS/<exe>`.
- **Exit criteria — met:** manifest window opens from config; `app.on("ready")` fires; `window.closed`/`window-all-closed` deliver; quit tears everything down with **zero orphan helpers** (verified 6→0).
- *Deferred:* per-window `loadUrl` on a live browser (needs the window→browser map exercised; M2.x).

### M3 — Typed RPC — ✅ DONE (dev transport)
- Preload bootstrap injected by `mirin-helper`'s render-process handler at V8-context creation, using rpc port/token/window-id from per-browser `extra_info`. Token-authenticated localhost WebSocket data plane to the Bun Worker (`RpcServer`).
- `mirin/rpc` router + `mirin/client` with full inference; typed `query`/`mutation` round-trips and `event` push main→webview.
- **Exit criteria — met:** the React example round-trips a typed `greet` query and receives live typed `tick` push events; the socket is token-gated.
- *Deferred:* `app://` scheme handler (dev loads the Vite URL directly for HMR; `app://` is needed for `mirin build`); payload encryption.

### M4 — Developer experience — ✅ DONE (dev loop)
- `mirin-cli dev`: cargo-build core+helper → compile host + bundle Worker → assemble/sign dev `.app` → start rolldown-vite → launch app at the Vite URL with RPC injected. HMR comes free from Vite.
- `examples/hello-react`: Vite + React 19 + rolldown-vite, typed RPC.
- **Exit criteria — met:** `bun mirin-cli dev` from the example brings up a React window with working typed RPC.
- *Deferred:* `mirin init` (scaffold), `mirin build` (distributable `.app`), published-package artifact resolution (dev assumes in-repo layout).

## Risk register

| Risk | Exposure | Mitigation |
|---|---|---|
| `cef` crate immature / API gaps (scheme handler, render-process handler coverage) | M1, M3 | Vendor/fork cef-rs early; we accepted this when choosing it |
| Bun-owned main thread upsets CEF/AppKit | M1.5 | Dedicated spike; two-process fallback documented above |
| Threadsafe `JSCallback` reliability under event load | M2 | Fallback: socketpair event pipe (same envelope), architecture.md §3 |
| Ad-hoc signing / entitlements blocking dev bundles on newer macOS | M0–M1 | Dev-bundle script owns signing; document Gatekeeper workarounds |
| CEF version drift vs cef-rs pin | ongoing | Mirin pins per release; fetch script verifies hash |

### M5 — `mirin build`: standalone signed .app — ✅ DONE
- `mirin build`: vite build → cargo `--release` → compile host (minified) → bundle Worker (minified) → assemble + sign a standalone `.app` under `build/`. Output runs with **no env and no dev server**.
- `app://` scheme handler (`crates/mirin-core/src/scheme.rs`): a SchemeHandlerFactory + in-memory ResourceHandler serving `Contents/Resources/ui/` with correct MIME types and an SPA fallback; registered in **every** process's `on_register_custom_schemes` (browser + helper) and wired to the global request context after init.
- Host production mode (`host.ts`): with no `MIRIN_*` env, resolves the core dylib (`MacOS/`), Worker + manifest (`Resources/`) relative to its own executable; windows load their manifest `app://` URLs.
- A `DisplayHandler::on_console_message` surfaces webview console output to host stderr (dev + diagnostics).
- **Exit criteria — met:** `mirin build` then Finder-launch the `.app` cold → React renders from `app://`, typed RPC round-trips, live events stream, clean quit (6→0).
- **Two findings (saved to memory):**
  1. `app://` must NOT be registered `SECURE` — as a secure origin, the RPC `ws://127.0.0.1` is blocked as mixed content (a non-localhost secure scheme gets no loopback exception). Standard + CORS + Fetch is enough.
  2. Even non-secure, the `app://` origin isn't "local" address space, so **Local Network Access** checks (Chromium 148; the successor to Private Network Access) block the loopback `ws://`. Disabled via `--disable-features=LocalNetworkAccessChecks,…` (targeted; not the broad `--disable-web-security`). Feature names are Chromium-version-sensitive.
- *Deferred:* notarization + Developer-ID hardened runtime (hooks exist via `MIRIN_SIGN_IDENTITY`), `.dmg`/`.zip` packaging, published-package artifact resolution.

### M6 — App-shell features (macOS) — ✅ DONE
Native capabilities, restructured into per-concern modules (`mac/{menu,tray,dialog,clipboard,shortcut,window}.rs`, `engine/{menu,tray,dialog,clipboard,shortcut}.rs`, `ffi.rs`; TS `app.ts`/`runtime.ts` + `menu/tray/dialog/clipboard/shortcut.ts`). Conventions codified in `AGENTS.md` (TanStack-style). Verified by running:
- **Application menu + context menus** — declarative template with `role` items (AppKit responder-chain selectors) and custom items routed by id as `menu.click`. Verified: File/Edit/View live; "File → Say Hello" pushed `menu: hello` to the UI.
- **Tray** — `NSStatusItem` with title/tooltip/menu. Verified: 🍴 status item present; its menu pushed `tray: hello`.
- **Global shortcuts** — Carbon `RegisterEventHotKey` (system-wide, no accessibility prompt). Verified: the Spotlight panel is summoned by ⌘⇧J. (Avoid combos other apps claim — ⌘⇧Space is 1Password's.)
- **Dialogs** — `NSOpenPanel`/`NSSavePanel`/`NSAlert`, run modally on the UI thread; async via a `requestId` echoed in `dialog.result`. Code-complete; interactively untested (AX can't coordinate-click the webview) but uses the proven RPC + event pipeline.
- **Clipboard** — `NSPasteboard` text read/write (sync, off the UI thread).
- **Window controls + multi-window** — minimize/maximize/restore/fullscreen/focus/show/hide/center/alwaysOnTop; `window.focus/blur/moved/resized` events; `app.windows.open()`.
- **Custom title bar + frameless** — `titleBarStyle: "hiddenInset" | "hidden"`, `transparent`, `alwaysOnTop`, `movableByBackground`, `visible:false`. CEF ignores `-webkit-app-region`, so a transparent `TitleBarDragView` (overriding `mouseDownCanMoveWindow`) is overlaid on the title strip for real dragging. Verified via the kitchen-sink (draggable custom title bar) and Spotlight (borderless translucent panel, traffic lights hidden, clear background).
- **Examples** — `examples/kitchen-sink` (all features) and `examples/spotlight` (hotkey-summoned frameless command palette: type-to-filter over RPC, Esc to dismiss, resident).

## Post-MVP queue (ordered, tentative)
1. `mirin init` (scaffold), notarization + dmg/zip for `mirin build`
2. Dialogs interactive test harness; payload encryption on the RPC plane; user preload scripts
3. Multi-webview windows (BrowserView equivalent); per-window `loadUrl`
4. Windows port (CEF default + WebView2 option), then Linux
5. Auto-updater (bsdiff-style incremental, electrobun-inspired)
6. Consider a CEF-IPC RPC transport (message router) to avoid loopback-origin policy friction entirely
