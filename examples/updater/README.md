# mirin updater example

Shows mirin's built-in auto-updater: `app.updater` (check / download / apply) and
the `mirin release` artifacts, hostable on **GitHub Releases** or **any static host**.

## How it works

- `mirin.config.ts` sets `release.baseUrl` + `channel`.
- `mirin release` builds the signed `.app` and emits, under `build/release/`:
  - `stable-darwin-<arch>-update.json` — the manifest the app polls
  - `stable-darwin-<arch>-UpdaterExample.app.tar.zst` — the full bundle (fallback)
  - `stable-darwin-<arch>-<prevVersion>.patch` — a small **delta** from the previous release
- The running app's `app.updater` polls `${baseUrl}/${channel}-darwin-${arch}-update.json`,
  accepts only a strictly newer SemVer than the structured embedded `version.json`,
  and downloads a delta patch from its installed version when available (else the
  full bundle). Checks are single-flight and each download is tied to the checked
  version/hash generation. The updater enforces declared compressed, patch, and tar
  sizes; verifies SHA-256; rejects unsafe tar node/link layouts; validates the real
  staged root, executable, executable mode, and embedded identity; then **swaps the
  whole `.app`** and relaunches. (A signed/notarized `.app` must be replaced whole —
  never edited in place.)

> Production update hosts must use HTTPS. The runtime only allows HTTP for
> loopback local testing (`localhost`, `127.0.0.1`, `[::1]`). Current manifests
> include required `tarSize` and patch `uncompressedSize` bounds. Older runtimes
> ignore those additive fields; hardened runtimes reject older manifests that omit
> them.

**Small updates:** because the bundle is dominated by the unchanging Chromium framework,
a release where only your app code changed produces a **few-KB patch** instead of a
100 MB+ download. The first update on a fresh install is full (no local base to patch
from); subsequent ones are deltas.

> Updates run only in a packaged build with `release` set. In `mirin dev` the updater is inert.

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

The app finds v1.0.1, downloads it with a progress bar, and relaunches into the new version.

## Host on GitHub Releases

Point `release.baseUrl` at your repo's latest release:

```ts
release: { baseUrl: "https://github.com/<org>/<repo>/releases/latest/download", channel: "stable" }
```

Then publish on a tag with the included workflow (`.github/workflows/release.yml`), which
builds, runs `mirin release`, codesigns + notarizes (Developer ID), and uploads everything
in `build/release/` as release assets. `…/releases/latest/download/<file>` resolves to the
newest non-prerelease — so `stable` updates work with zero servers.

Other channels (e.g. `beta`) use a pre-release tag or a separate `baseUrl`/path.
Keep the uploaded artifact names flat; `app.updater` accepts the filenames emitted
by `mirin release`.
