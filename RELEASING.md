# Releasing

Releases are cut by pushing a `v*` tag; GitHub Actions builds the native
artifacts and publishes to npm. Nothing is published until you tag.

## One-time setup

1. **npm `@mirin` scope** — create an npm org named `mirin` (npmjs.com → Add
   Organization), or ensure the publishing account owns the scope. The bare
   `mirin` and `create-mirin` names are published by the same account.
2. **`NPM_TOKEN` secret** — create an npm **automation** access token with
   publish rights, then add it as the repo secret `NPM_TOKEN`
   (`gh secret set NPM_TOKEN`).

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
3. stages `libmirin_core.dylib` + `mirin-helper` into `@mirin/darwin-arm64`,
4. uploads `cef-darwin-arm64.tar.gz` to the GitHub Release (the CLI downloads it),
5. publishes `@mirin/darwin-arm64`, `create-mirin`, `mirin`, `@mirin/cli` to npm
   (`bun publish` rewrites `workspace:*` to the concrete version).

Pre-release tags (`-alpha`/`-beta`) are marked as GitHub pre-releases and should
be published to npm under the `alpha` dist-tag once the workflow is hardened.

## What ships where

| Package | Contents |
|---|---|
| `mirin` | runtime API (TS source) |
| `@mirin/cli` | `mirin` CLI; optional-deps the per-platform native package |
| `@mirin/darwin-arm64` | prebuilt `libmirin_core.dylib` + `mirin-helper` |
| `create-mirin` | scaffolder + starter template |
| GitHub Release asset | `cef-darwin-arm64.tar.gz` (CEF is too large for npm) |

Adding a platform later = a new `@mirin/<os>-<arch>` package + a matching CEF
release asset + a CI build matrix entry.
