# mirin updater example

Shows mirin's built-in auto-updater: `app.updater` (check / download / apply) and
the `mirin release` artifacts, hostable on **GitHub Releases** or **any static host**.

## How it works

- `mirin.config.ts` sets `release.baseUrl` + `channel` and receives the public
  update key through `MIRIN_UPDATE_PUBLIC_KEY`.
- `mirin release` builds the signed `.app` and emits, under `build/release/`:
  - `stable-darwin-<arch>-update.json` — the manifest the app polls
  - `stable-darwin-<arch>-update.json.sig` — its detached Ed25519 signature
  - `stable-darwin-<arch>-UpdaterExample.app.tar.zst` — the full bundle (fallback)
  - `stable-darwin-<arch>-<prevVersion>.patch` — a small **delta** from the previous release
- The running app's `app.updater` polls `${baseUrl}/${channel}-darwin-${arch}-update.json`,
  verifies its exact bytes against the public key in the structured embedded
  `version.json`, accepts only a strictly newer SemVer,
  and downloads a delta patch from its installed version when available (else the
  full bundle). Checks are single-flight, defer during an active download, and each
  download is tied to the checked version/hash generation. The updater enforces
  declared compressed and patch sizes plus an 8 GiB streaming reconstructed-tar ceiling
  and a 512 MiB combined in-memory patch-input ceiling; larger deltas use the full bundle.
  It verifies SHA-256; rejects unsafe tar node/link layouts; validates the real
  staged root, executable mode, embedded identity, and either the installed app's
  stable designated code requirement or (for authenticated ad-hoc local builds)
  codesign validity; then **swaps the whole `.app`** and relaunches. Accepted helper
  launch is a terminal handoff that blocks
  further check/download/apply and auto-check work until exit. The helper retains the
  old app through replacement launch, restores and reopens it if `open` fails, removes
  successful generation state, and the next startup prunes abandoned generations without
  touching live-process work. (A
  signed/notarized `.app` must be replaced whole — never edited in place.)

> Production update hosts must use HTTPS. The runtime only allows HTTP for
> loopback local testing (`localhost`, `127.0.0.1`, `[::1]`) and checks every
> redirect hop under a deadline. Current manifests
> include required `tarSize` and patch `uncompressedSize` bounds. Older runtimes
> ignore those additive fields; hardened runtimes reject older manifests that omit
> them.

**Small updates:** because the bundle is dominated by the unchanging Chromium framework,
a release where only your app code changed produces a **few-KB patch** instead of a
100 MB+ download. The first update on a fresh install is full (no local base to patch
from); subsequent ones are deltas.

> Updates run only in a packaged build with `release` set. In `mirin dev` the updater is inert.

## Create update keys

Generate the app's long-lived Ed25519 update key pair once:

```bash
openssl genpkey -algorithm Ed25519 -out update-private.pem
export MIRIN_UPDATE_PUBLIC_KEY="$(
  openssl pkey -in update-private.pem -pubout -outform DER | openssl base64 -A
)"
export MIRIN_UPDATE_PRIVATE_KEY="$(
  openssl pkey -in update-private.pem -outform DER | openssl base64 -A
)"
```

Keep the private key out of source control and provide it only to `mirin release`.
The public-key variable must also be present when building the installed app. In CI,
store both values as secrets; the public value may alternatively be committed as
`release.publicKey`.

## Try it locally (self-host)

```bash
bun install

# 1. Build + publish v1.0.0, then install it
bun run release
cp -R build/"Updater Example".app /Applications/

# 2. Serve the release dir (acts as local-test baseUrl http://localhost:4000)
bun run serve            # leave running

# 3. Bump the version, release v1.0.1
#    (edit "version" in package.json → 1.0.1)
bun run release          # overwrites build/release with v1.0.1 artifacts

# 4. Launch the installed v1.0.0 and click "Check for updates" → Download → Restart.
open /Applications/"Updater Example".app
```

Restart begins the terminal helper handoff. The app finds v1.0.1, verifies its signed
manifest, downloads it with a progress bar, and relaunches into the new version; if
the replacement cannot open, the helper restores and reopens the installed version.

## Host on GitHub Releases

Point `release.baseUrl` at your repo's latest release:

```ts
release: { baseUrl: "https://github.com/<org>/<repo>/releases/latest/download", channel: "stable" }
```

Then publish on a tag with the included workflow (`.github/workflows/release.yml`), which
builds, runs `mirin release`, codesigns + notarizes (Developer ID), and uploads everything
in `build/release/` as release assets. `…/releases/latest/download/<file>` resolves to the
newest non-prerelease — so `stable` updates work with zero servers.

Other channels (for example `beta.preview-2`) use a pre-release tag or a separate
`baseUrl`/path. Channel names use the same safe dotted grammar in release artifact
prefixes, manifests, embedded identity, URLs, and updater support directories. Keep
the uploaded artifact names flat; `app.updater` accepts the filenames emitted by
`mirin release`.
