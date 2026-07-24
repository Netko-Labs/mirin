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

The scaffold directory/app name must be lowercase kebab-case (`my-app`): letters
or digits separated by single hyphens. The command validates the name before it
copies anything, including when a Windows-style target path is supplied to the
shared scaffold API.

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

- macOS: a DMG plus `{channel}-darwin-{arch}-update.json` and its detached `.sig`,
  full `.tar.zst`, and optional delta patch.
- Windows: an Inno Setup installer when `iscc` is available, else NSIS when
  `makensis` is available, else a portable `.zip`, plus the updater artifacts.
- Linux: AppImage, deb, and rpm packages plus the updater artifacts.

Release compression uses multiple CPU cores, and Linux package formats build in
parallel with installer creation overlapping updater generation. Mirin waits for
every parallel package process before cleaning shared staging; if one format
fails, every expected artifact is removed before the release continues without
Linux packages. If package or shared-staging cleanup itself fails, the atomic
release aborts instead of committing partial package output. Apps that ship one
language can set `cef: { locales: ["en-US"] }`; omit it to retain every CEF
locale. In ephemeral CI, cache `~/.mirinjs/cef` by Mirin version and runner
platform so each target does not download and unpack the same runtime again.

Set `release.baseUrl` in `mirin.config.ts` to a flat HTTPS directory that hosts
those files, such as GitHub Releases' `.../releases/latest/download`. Safe dotted
channels such as `beta.preview-2` are supported; the same validated channel is used
in artifact prefixes, manifests, embedded identity, URLs, and updater support paths.
Before any build/dev output is created, Mirin requires a portable app `name`, a
reverse-DNS `id`, a bounded `release.channel` made of alphanumeric runs separated
by single `.`, `_`, or `-` characters, and a strict SemVer package/override
version. New scaffolds declare version `1.0.0`; projects without a package
version use the same macOS-compatible fallback. On macOS the full SemVer remains
in updater metadata while the bundle plist uses Apple's 4/2/2-digit
build-component bounds and `d`/`a`/`b`/`fc` suffixes for `dev`/`preview`,
`alpha`, `beta`, and `rc` prereleases (iterations 1–255). Sidecar and
extra-worker sources must resolve to regular files within
the canonical project root; missing paths, directories, special files, and
escaping symlinks fail preflight. App icons must resolve to a project-owned
regular file or a flat `.iconset` containing no symlinks; bundle and package
sinks revalidate them before use. Bundle and release directories are assembled
in unique sibling staging paths, so a failed required copy/sign/updater or
Windows-installer run preserves the last successful output. DMG and Linux
packages are best-effort exceptions: failures are logged and the atomic release
can still commit its signed updater artifacts without them. Cleanup of the old
backup after a successful canonical swap is non-fatal; aged leftovers are pruned
by later runs only when their exact PID/UUID ownership name matches and their
owner process is gone.

Generate a long-lived Ed25519 update key pair once:

```bash
openssl genpkey -algorithm Ed25519 -out update-private.pem
openssl pkey -in update-private.pem -pubout -outform DER | openssl base64 -A
openssl pkey -in update-private.pem -outform DER | openssl base64 -A
```

Put the first base64 value in `release.publicKey` (or
`MIRIN_UPDATE_PUBLIC_KEY`) when building. Set the second as
`MIRIN_UPDATE_PRIVATE_KEY` only in the release environment; it is a PKCS8 private
key and must never be committed or packaged. `mirin release` fails closed if the
keys are absent or do not match, signs the exact manifest bytes, and emits
`update.json.sig`.

Runtime updates reject non-HTTPS URLs except `http://localhost` / loopback for local
testing, validate every redirect hop under a 30-second metadata deadline, verify the
detached Ed25519 signature before parsing the manifest, validate its target, and accept
only strictly newer SemVer precedence. Artifact requests have a 15-minute deadline.
Checks are single-flight and defer while a download is active or an update is staged;
repeated downloads of an already staged generation are rejected. Downloads and applies
are guarded operations correlated to a version/hash generation. `mirin build` validates
the same strict SemVer grammar consumed by the runtime before packaging. Apps configured
with `singleInstance: false` may check and download, but automatic apply is rejected;
close every instance and install their update externally. The guard requires a
protocol-compatible host/Worker pair and the process-lifetime exclusive app lock
actually acquired by the native host before the Worker starts, including internal
launch overrides. `mirin build` and `mirin dev` reject mismatched CLI/project
`mirinjs` versions. Multi-instance processes hold shared locks, preventing them
from overlapping an exclusive updater-capable process. Accepted helper launch is
a terminal handoff, so manual updater work and auto-check scheduling remain
blocked until the process exits. The helper reserves the next launch for the
validated staged version and retains the backup until that successor reports
Worker/native readiness; timeout or early exit restores and relaunches the old
install. AppImage/deb/rpm payloads omit updater metadata and update through their
package channel. Failed operations release
their latch before best-effort cleanup, successful helpers remove their generation
directory, and startup prunes abandoned generations while preserving work owned by
live app processes or an apply-helper PID. Manifest bodies, downloads, decompressed patches,
archive entries, and path/link lengths are bounded; streaming reconstructed tar output
has an 8 GiB ceiling, while in-memory patch inputs have a 512 MiB combined ceiling and
release bsdiff sources a 128 MiB per-source ceiling. Larger deltas use the full bundle.
SHA-256, archive node/link safety, the real staged root
and platform executable, and staged `version.json` identity are verified before apply.
`version.json` is bounded before reading and decoding. macOS verifies executable mode
and a stable installed designated code requirement; ad-hoc local builds fall back to
codesign validity because their exact-build cdhash changes between releases;
Linux extracts with permission preservation, ensures owner execute on the validated
regular executable, and rolls back if the replacement exits immediately. Set
`release.notes` to embed at most 64 Ki characters of markdown release notes in the
update manifest for app update UIs. The final manifest is also capped at 256 KiB
before signing.

Current `mirin release` manifests add required `tarSize` and patch
`uncompressedSize` bounds. Older Mirin runtimes ignore these additive fields and
can consume the JSON payload in new releases. Hardened runtimes intentionally reject
legacy manifests that omit the bounds or detached signature; release tooling can still
publish a full update when the previous remote manifest is legacy or unsigned, but
skips delta generation against it.

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
