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

Declared windows with no `open` field open automatically at launch, before `ready` fires. `defineConfig` is an identity function that exists for typing/intellisense; the manifest must remain serializable data.

`cef.locales` is an optional production-package allowlist using BCP 47 tags.
Keeping only the languages an app ships can remove tens of megabytes from CEF
and every updater, installer, and Linux package derived from it. Development
bundles retain the complete downloaded runtime.

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
await scratch.close();
```

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

Calls made before the app is ready are applied once it is. Combine with `titleBarStyle: "hidden"` for a chromeless, Dock-less panel (the Spotlight example does both).

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

Implementation notes (see architecture.md §4): JSON frames over a token-authenticated localhost WebSocket; handlers run in the Bun Worker.

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
  is single-flight and reports only releases with strictly newer SemVer precedence;
  equal versions, downgrades, and build-metadata-only changes return `null`.
  `download()` and `applyAndRelaunch()` reject concurrent operations, and rechecking
  invalidates older staged generations. Malformed embedded `version.json` metadata
  disables the updater. Downloads require generated size bounds and are not
  considered staged until archive structure, platform executable, executable mode
  (macOS/Linux), embedded identity, integrity, and platform signature checks pass.

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
