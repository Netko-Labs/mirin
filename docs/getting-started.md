# Getting started

> **Alpha.** macOS arm64 only. Expect rough edges and breaking changes.

## Requirements

- **Bun** ≥ 1.2 ([install](https://bun.sh))
- **macOS** on Apple Silicon (arm64)
- **Xcode command-line tools** (`xcode-select --install`) — for code signing

No Rust toolchain is needed to *use* mirin; the native core ships prebuilt.

## Create an app

```bash
npm create mirinjs@latest my-app
cd my-app
bun install
bun run dev
```

The first `dev`/`build` downloads the Chromium Embedded Framework once
(~hundreds of MB) into `~/.mirinjs/cef/`.

You get a native window rendering React with Vite HMR and typed RPC between the
Bun main process and the webview.

## Project layout

```
my-app/
├─ mirin.config.ts   # manifest: app id, windows (pure data)
├─ main/             # Bun main process
│  ├─ main.ts        #   app lifecycle, app.serve(router)
│  └─ rpc.ts         #   typed RPC router (query / mutation / event)
└─ ui/               # the webview (React); served via app:// in builds
   ├─ api.ts         #   client<Router>() — full type inference, no codegen
   └─ App.tsx
```

## The two commands

| Command | What it does |
|---|---|
| `bun run dev` (`mirin dev`) | Builds the dev bundle, starts Vite, opens the window at the dev server (HMR). |
| `bun run build` (`mirin build`) | `vite build` → standalone, ad-hoc-signed `.app` in `./build`, serving the UI from `app://`. |

Set `MIRIN_SIGN_IDENTITY="Developer ID Application: …"` before `build` to
produce a distributable, notarizable app.

## Native features

Native capabilities run in the **main process** and are invoked from the UI via
RPC. Available from `mirinjs`:

```ts
import { app, menu, Tray, dialog, clipboard, globalShortcut } from "mirinjs";
```

- `menu.setApplicationMenu(template)` / `menu.popup(template)` — roles + typed click handlers
- `new Tray({ title, tooltip, menu, onClick })`
- `dialog.openFile() / saveFile() / message()` — async, typed
- `clipboard.readText() / writeText(text)`
- `globalShortcut.register("Cmd+Shift+K", fn)` — system-wide
- window controls on a `WindowHandle`: `minimize / toggleFullscreen / setAlwaysOnTop / center / show / hide …`
- window options: `titleBarStyle: "hidden" | "hiddenInset"`, `transparent`, `alwaysOnTop`, `movableByBackground`, `visible`

See the [`kitchen-sink`](https://github.com/Netko-Labs/mirin/tree/main/examples/kitchen-sink)
and [`spotlight`](https://github.com/Netko-Labs/mirin/tree/main/examples/spotlight)
examples for everything wired together.
