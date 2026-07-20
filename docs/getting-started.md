# Getting started

> **Alpha.** macOS arm64, Windows x64/arm64, and Linux x64/arm64 are supported.
> macOS is the most exercised path; expect rough edges and breaking changes.

## Requirements

- **Bun** ≥ 1.2 ([install](https://bun.sh))
- **macOS** on Apple Silicon (arm64) with Xcode command-line tools
  (`xcode-select --install`) for code signing, **Windows 10/11 x64 or arm64**,
  or a supported **Linux x64 or arm64** desktop with the CEF/GTK runtime
  dependencies.

No Rust toolchain is needed to *use* mirin; the native core ships prebuilt.

## Create an app

```bash
bun create mirinjs my-app
cd my-app
bun install
bun run dev
```

The first `dev`/`build` downloads the Chromium Embedded Framework once
(~hundreds of MB) into `~/.mirinjs/cef/<version-platform>/`.

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
| `bun run build` (`mirin build`) | `vite build` → standalone app in `./build` (`.app` on macOS, flat app folder on Windows/Linux), serving the UI from `app://`. |

Set `MIRIN_SIGN_IDENTITY="Developer ID Application: …"` before `build` to
produce a distributable, notarizable app.

## Release and updates

`mirin release` builds the app and emits installer + updater artifacts under
`build/release/`:

- macOS: a DMG plus `{channel}-darwin-{arch}-update.json`, full `.tar.zst`, and
  optional delta patch.
- Windows: an Inno Setup installer when `iscc` is available, else NSIS when
  `makensis` is available, else a portable `.zip`, plus the updater artifacts.
- Linux: AppImage, deb, and rpm packages plus the updater artifacts.

Release compression uses multiple CPU cores, and Linux package formats build in
parallel with installer creation overlapping updater generation. Apps that ship
one language can set `cef: { locales: ["en-US"] }`; omit it to retain every CEF
locale. In ephemeral CI, cache `~/.mirinjs/cef` by Mirin version and runner
platform so each target does not download and unpack the same runtime again.

Set `release.baseUrl` in `mirin.config.ts` to a flat HTTPS directory that hosts
those files, such as GitHub Releases' `.../releases/latest/download`. Runtime
updates reject non-HTTPS URLs except `http://localhost` / loopback for local
testing, validate the manifest target, and accept only strictly newer SemVer
precedence. Checks are single-flight; downloads and applies are guarded operations
correlated to a version/hash generation, so a recheck cannot apply an older staged
bundle. Manifest bodies, downloads, decompressed patches, reconstructed tars,
archive entries, and path/link lengths are bounded. SHA-256, archive node/link
safety, the real staged root and platform executable, executable mode on
macOS/Linux, and staged `version.json` identity are all verified before apply.
Set `release.notes` to embed markdown release notes in the update manifest for app
update UIs.

Current `mirin release` manifests add required `tarSize` and patch
`uncompressedSize` bounds. Older Mirin runtimes ignore these additive fields and
can consume new releases. Hardened runtimes intentionally reject legacy manifests
that omit the bounds; release tooling can still publish a full update when the
previous remote manifest is legacy, but skips delta generation against it.

## Native features

Native capabilities run in the **main process** and are invoked from the UI via
RPC. Available from `mirinjs`:

The complete list below is implemented on macOS and Windows. Linux currently
supports the core window/build/release loop and window controls; menus, tray,
dialogs, clipboard, shortcuts, and deep links remain tracked in
[`docs/linux-port.md`](linux-port.md).

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
