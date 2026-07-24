# Mirin API Design

Status: **v1 agreed with project owner (2026-06-09).** Remaining open items in §6.

Design stance: an app is *described*, not wired up. A pure-data manifest is the app's skeleton — windows, identity, engine settings — and a free-form main module holds runtime behavior. Imperative APIs are escape hatches off live handles, not the primary model.

## 1. Manifest + main split

A mirin project has two entry points:

**`mirin.config.ts`** — a pure-data manifest. No functions, no side effects; statically analyzable so `mirin build`/`mirin dev` can read it without executing app code.

```ts
// mirin.config.ts
import { defineConfig } from "mirinjs/config";

export default defineConfig({
  id: "dev.peje.hello",
  name: "Hello",
  // Production bundles keep only these CEF locale packs. Omit `cef` to ship all.
  cef: { locales: ["en-US"] },

  windows: {
    main: {
      title: "Hello, mirin",
      width: 1024,
      height: 768,
      url: "app://ui/index.html",   // bundled assets; http(s):// also allowed
      show: "ready",                // don't flash white: show on first paint
    },
    // windows with `open: "manual"` are templates, instantiated later
    // via app.windows.open("name")
  },
});
```

**`src/main.ts`** — the runtime module, run in the Bun Worker after the manifest is loaded:

```ts
// src/main.ts
import { app } from "mirinjs";
import { router } from "./rpc";

app.serve(router);

app.on("ready", async () => {
  console.log("all auto-open windows are up");
});

app.on("window-all-closed", () => {
  app.quit();                       // default behavior; shown for clarity
});
```

Declared windows with no `open` field open automatically at launch. `ready`
fires only after every automatic window has emitted native `window.created`;
if any automatic window reports `window.create-failed`, `ready` does not fire and
Mirin requests orderly application quit. `app.windows.open(...)` uses the same
event correlation, resolving with its handle on success or rejecting and
unregistering that handle on failure. This guarantees a live native browser, but
does not promise first paint or an established renderer RPC socket. `defineConfig` is an identity
function that exists for typing/intellisense; the manifest must remain
serializable data.

The CLI validates packaging identity before it creates/cleans build directories or
starts Vite/native work. `name` is one portable ASCII filename segment (letters,
digits, spaces, `.`, `_`, `(`, `)`, `-`; no Windows device names or trailing
dot/space), `id` is a reverse-DNS identifier with at least two DNS-style labels,
`release.channel` is a flat filename-safe segment of at most 64 characters:
alphanumeric runs separated by single `.`, `_`, or `-` characters, excluding
Windows device names. The package/override version must be strict SemVer. macOS
keeps that full SemVer in updater metadata, writes its numeric
`major.minor.patch` core to `CFBundleShortVersionString`, and maps
`dev`/`preview`, `alpha`, `beta`, and `rc` prereleases to Apple's
`d`/`a`/`b`/`fc` build suffixes. Apple bundle components are limited to 4/2/2
digits, the major version must be nonzero, and prerelease iterations must be 1–255.
Platform bundle and installer sinks repeat validation before recursive removal.
When updates are enabled,
the CLI emits exactly the validated six-field `version.json` envelope (`version`,
`channel`, `baseUrl`, `publicKey`, `name`, `identifier`) and parses it back before
bundling.

`cef.locales` is an optional production-package allowlist using BCP 47 tags.
Keeping only the languages an app ships can remove tens of megabytes from CEF
and every updater, installer, and Linux package derived from it. Development
bundles retain the complete downloaded runtime.

Bundle and release assembly use unique sibling staging directories. A failed
copy, icon conversion, required signing/updater operation, or Windows installer
operation leaves the previous successful canonical output intact; the staged
directory replaces it only after the required operation succeeds. DMG and Linux
packages are best-effort: their failures are logged and a valid updater release
may atomically replace the prior output without those optional artifacts. Linux
package failures remove every expected package before that commit; if cleanup
cannot prove the release package-free, the release fails closed. Cleanup of the
old backup after a successful swap is non-fatal, and later runs prune aged
leftovers only when they have Mirin's exact PID/UUID ownership name and their
owner process is gone.

`app://` is mirin's bundled-asset scheme, served from the app bundle through a CEF scheme handler (dev mode points it at the working tree).

## 2. Imperative escape hatches

Everything declared is reachable as a live, typed handle at runtime:

```ts
const main = app.windows.get("main");        // typed: known window names
await main.setTitle("Hello again");
main.on("moved", ({ x, y }) => { ... });     // typed events
for await (const _ of main.events("focus")) { ... }  // or async iteration

// fully dynamic window — same options shape as the manifest
const scratch = await app.windows.open({
  name: "scratch",                            // optional; enables get("scratch")
  title: "Scratch", width: 400, height: 300, url: "app://ui/scratch.html",
});
await scratch.loadUrl("app://ui/other.html"); // Vite URL in dev; app:// in builds
await scratch.close();                         // closes only this window
```

`loadUrl()` navigates the handle's existing browser. In development it uses the
same Vite URL resolution as initial window creation (including the requested
query/hash); in a packaged app it loads the requested `app://` or HTTP(S) URL.
Closing a handle or using a native close gesture affects only that window.
`app.quit()` remains the all-window path and also terminates apps that currently
have zero windows.

Principles:
- Every imperative API takes the *same options object* as its declarative twin. Nothing is config-only or runtime-only.
- All mutating calls are `async` (they cross the FFI/main-thread boundary); reads of declared facts (`main.name`) are sync.
- Events come as `.on(type, fn)` **and** `.events(type)` async iterators, both fully typed.
- Dynamic windows are handle-first; `name` is an optional registration for later lookup. *(Defaulted decision — veto if you want handle-only.)*

## 2a. Transparent windows & native materials (macOS)

A window can be genuinely see-through and sit on a native macOS material — Apple's **Liquid Glass** or classic **vibrancy** — rendered *behind* the web UI:

```ts
windows: {
  panel: {
    url: "app://ui/index.html",
    titleBarStyle: "hidden",
    material: { type: "liquidGlass", cornerRadius: 18, tint: "#3b82f6aa" },
    // material implies a transparent window; the page uses a clear/translucent
    // background so the native material shows through.
  },
}
```

- `material` is either a name (`"liquidGlass"`, `"sidebar"`, `"hud"`, `"popover"`, `"menu"`, `"underWindowBackground"`, `"fullScreenUI"`, …) or `{ type, tint?, cornerRadius? }`. `tint` (Liquid Glass only) is a CSS hex color.
- `material` implies `transparent: true`. Transparent windows render **windowless (OSR)** — a windowed CEF browser can't be see-through — so the page should draw no opaque background.
- `"liquidGlass"` needs macOS 26+ (`NSGlassEffectView`); on older systems it falls back to a frosted vibrancy material automatically.
- Swap it live: `await win.setMaterial("popover")` / `await win.setMaterial({ type: "liquidGlass", tint: "#ec4899aa" })` / `await win.setMaterial(null)` to remove it.
- `transparent: true` with no `material` gives a plain see-through window with rounded corners.

See `examples/spotlight` (Liquid Glass command palette) and `examples/liquid-glass` (live material picker).

**Dock icon (macOS).** A resident, hotkey-summoned app can drop out of the Dock and menu bar entirely:

```ts
app.dock.hide();   // accessory app: no Dock tile, no menu bar (windows still show)
app.dock.show();   // back to a regular app
```

Calls made before the native core is ready are applied at `core.ready`, before
automatic windows are opened and before public `app.ready`. Combine with
`titleBarStyle: "hidden"` for a chromeless, Dock-less panel (the Spotlight
example does both).

## 3. Typed RPC

One router definition; both sides infer from it. No channel strings, no `any`. The router is **global** — any webview can call any procedure — and every handler receives a `ctx` identifying the caller. Per-window scoping can layer on post-MVP.

```ts
// src/rpc.ts — imported by BOTH main process and UI code
import { rpc } from "mirinjs/rpc";

export const router = rpc.router({
  // request/response (UI → main)
  getUser: rpc.query(async (id: string, ctx) => {
    ctx.window;                     // WindowHandle of the caller
    ctx.webview;                    // webview id
    return db.users.find(id);
  }),
  saveNote: rpc.mutation(async (note: { title: string; body: string }) => { ... }),

  // main → UI push
  progress: rpc.event<{ pct: number }>(),
});

export type Router = typeof router;
```

`query` and `mutation` share runtime behavior in the MVP; the distinction is semantic and reserves room for caching/invalidation later.

In the webview (any frontend stack — plain browser JS over `window.mirin`):

```ts
// ui/api.ts
import { client } from "mirinjs/client";
import type { Router } from "../src/rpc";

export const api = client<Router>();

const user = await api.getUser("42");          // typed: User
api.progress.on(({ pct }) => render(pct));     // typed push events
```

In the main process, pushing to a specific webview or broadcasting:

```ts
app.windows.get("main").rpc.progress.emit({ pct: 80 });
app.rpc.progress.broadcast({ pct: 80 });
```

Implementation notes (see architecture.md §4): JSON frames over a
token-authenticated localhost WebSocket; handlers run in the Bun Worker.
`window.mirin` is a privileged capability injected only into the top-level
`app:`, `http:`, or `https:` origin resolved for that window at creation.
Subframes and cross-origin navigations do not receive it. A transport disconnect
rejects all outstanding calls; sent requests are not replayed on reconnect, and
only later calls use the replacement connection.

## 4. Shipped feature families

The original MVP left native shell APIs out. They now exist as focused modules
off the main-process API:

- `menu.setApplicationMenu(template)` / `menu.popup(template)` for app and context menus.
- `new Tray({ title, tooltip, menu, onClick })`.
- `notification.show({ title, body? })` for a best-effort native desktop notice.
- `dialog.openFile()` / `dialog.saveFile()` / `dialog.message()`.
- `clipboard.readText()` / `clipboard.writeText(text)`.
- `globalShortcut.register(accelerator, fn)`.
- `WindowHandle` controls: minimize, maximize, restore, fullscreen, focus, show,
  hide, center, always-on-top, position, material changes.
- macOS `app.dock.hide()` / `app.dock.show()`.
- `app.sidecar(name, opts)`, `resolveSidecar(name)`, and `resolveWorker(name)` for bundled sidecars and
  extra workers declared in `mirin.config.ts`; config names are safe filename
  segments and source paths are project-relative.
- `app.updater` for packaged apps built with `release.baseUrl`. `checkForUpdate()`
  is single-flight, resolves `null` rather than starting a check while an update is
  downloading, staged, or applying, and reports only releases with strictly newer
  SemVer precedence; equal versions, downgrades, and build-metadata-only changes
  return `null`. A listener may call `download()` directly from `update-available`;
  downloads before a check commits, repeated downloads after staging, and concurrent
  download/apply operations are rejected. Apps with `singleInstance: false` can
  check and download, but automatic apply is rejected because replacing the shared
  install while sibling app processes may be running is unsafe. Automatic apply
  requires a protocol-compatible host/Worker pair and the process-lifetime
  exclusive app lock actually acquired by the native host before the Worker
  starts, including internal launch overrides. Build/dev reject mismatched
  `mirinjs` runtime versions. Multi-instance processes hold compatible shared
  locks, so they cannot overlap an exclusive updater-capable process. Once a
  detached apply helper is accepted, the updater enters a terminal handoff:
  checks, downloads, applies, and auto-check scheduling remain blocked until
  process exit. A private handoff reservation blocks the old version from
  relaunching after the OS lock is released; the backup remains until the staged
  target acquires the lock and writes a Worker/native readiness receipt. Failure
  or timeout rolls back and reopens the prior install. Managed Linux
  AppImage/deb/rpm payloads omit updater metadata and update through their package
  channel. Malformed embedded `version.json` metadata,
  including its Ed25519 public-key trust anchor, disables
  the updater. Each manifest must have a detached `.sig` over its exact bytes;
  signature verification happens before JSON parsing, and every redirect hop must
  satisfy the HTTPS-or-loopback policy and a bounded request deadline. Embedded and
  staged `version.json` files are size-bounded before allocation/decoding.
  `release.channel` supports validated safe
  dotted names consistently across build/release output, embedded identity, manifest
  matching, artifact names, and support directories, excluding Windows reserved names.
  Downloads require
  generated size bounds; streaming reconstructed tar/decompression output is capped at
  8 GiB, in-memory patch inputs at 512 MiB combined, and release bsdiff sources at
  128 MiB each. Larger deltas fall back to the full bundle. Compressed artifacts,
  archive structure, and subprocess output are bounded separately. A download is not
  staged until archive structure, platform executable,
  embedded identity, integrity, and platform signature checks pass. macOS verifies
  executable mode, the installed app's stable designated code requirement, and
  codesign. Ad-hoc local builds use the pinned manifest key plus codesign validity
  because an ad-hoc requirement pins one exact build;
  Linux preserves archive permissions and ensures owner execute on the validated
  regular host executable. Failed operations release latches before best-effort
  cleanup, successful helpers remove their generation directory, and startup prunes
  abandoned generations while preserving work owned by live app processes and apply
  helpers recorded by PID.

`release.notes` accepts at most 64 Ki characters, and the CLI rejects a generated
manifest above the runtime's 256 KiB response ceiling before signing it.

The CLI uses `1.0.0` when package metadata omits a version, and new scaffolds
declare that value explicitly so macOS development and production bundles always
have an Apple-compatible nonzero build version.

Still future: multi-webview-per-window (BrowserView equivalent), user preload
scripts, session/cookie controls, payload encryption or a CEF IPC replacement for
the localhost RPC data plane, and a Windows WebView2 backend option.

## 5. Package layout (developer's view)

| Import | Runs in | Contents |
|---|---|---|
| `mirinjs` | Bun main process | `app` singleton, window handles, lifecycle, shell APIs |
| `mirinjs/config` | manifest (build-time) | `defineConfig` + manifest types |
| `mirinjs/rpc` | shared (types + handlers) | `rpc.router/query/mutation/event` |
| `mirinjs/client` | webview (browser) | `client<Router>()`, `window.mirin` typings, `windowControls` |
| `@mirinjs/cli` (`mirin`) | dev machine | `init`, `dev`, `build`, `release` |

## 6. Resolved & open items

Resolved 2026-06-09 with owner: split manifest+main (over single `defineApp` file); `query`/`mutation`/`event` naming (over flattened `fn`); `app://` scheme; global router + ctx (over per-window routers).

Still open (low stakes, decide when implementing):
1. `ctx` shape details (abort signal? headers-like metadata?).
2. Whether `app.on("ready")` listeners registered after ready fire immediately (lean: yes, promise-like semantics).
