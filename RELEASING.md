# Releasing

Releases are cut by pushing a `v*` tag; GitHub Actions builds the native
artifacts and publishes to the registry. Nothing is published until you tag.

## One-time setup

The CLI and native packages publish under the **`@mirinjs` org scope**
(`@mirinjs/cli`, `@mirinjs/darwin-arm64`); `mirinjs` and `create-mirinjs` are
unscoped. The org and the publish token are already configured:

- **`@mirinjs` org** — owned on the registry; the publish token has access to it.
- **`NPM_TOKEN` secret** — an automation token with publish rights, set as the
  repo secret (`gh secret set NPM_TOKEN --repo Netko-Labs/mirin`).
- **Blacksmith** — CI/release run on Blacksmith's Apple Silicon macOS runners
  (`blacksmith-6vcpu-macos-15`). Install the Blacksmith GitHub app on the
  **Netko-Labs org** at <https://app.blacksmith.sh> (Blacksmith is org-only). To
  fall back to GitHub-hosted runners, change `runs-on` to `macos-14`.

## Cutting a release

```bash
bun scripts/version.ts 0.0.1-alpha.1   # bumps all packages + Cargo in sync
git commit -am "v0.0.1-alpha.1"
git tag v0.0.1-alpha.1
git push --follow-tags
```

`release.yml` then, on the `v*` tag:

1. verifies the tag matches `packages/mirin`'s version,
2. fetches CEF and builds the release native binaries,
3. stages `libmirin_core.dylib` + `mirin-helper` into `@mirinjs/darwin-arm64`,
4. uploads `cef-darwin-arm64.tar.gz` to the GitHub Release (the CLI downloads it),
5. publishes `@mirinjs/darwin-arm64`, `create-mirinjs`, `mirinjs`, `@mirinjs/cli` to the registry.
   Each is packed with `bun pm pack` (which rewrites `workspace:*` to the concrete
   version) and uploaded with `npm publish <tarball>` — `bun publish` doesn't read
   `~/.npmrc` auth in CI (oven-sh/bun#24124).

Pre-release tags (`-alpha`/`-beta`) are marked as GitHub pre-releases and should
be published to the registry under the `alpha` dist-tag once the workflow is hardened.

## What ships where

| Package | Contents |
|---|---|
| `mirinjs` | runtime API (TS source) |
| `@mirinjs/cli` | `mirinjs` CLI; optional-deps the per-platform native package |
| `@mirinjs/darwin-arm64` | prebuilt `libmirin_core.dylib` + `mirin-helper` |
| `create-mirinjs` | scaffolder + starter template |
| GitHub Release asset | `cef-darwin-arm64.tar.gz` (CEF is too large for npm) |

Adding a platform later = a new `@mirinjs/<os>-<arch>` package + a matching CEF
release asset + a CI build matrix entry.
