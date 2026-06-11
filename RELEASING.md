# Releasing

Releases are cut by pushing a `v*` tag; GitHub Actions builds the native
artifacts and publishes to npm. Nothing is published until you tag.

## One-time setup

All package names are **unscoped** (`mirinjs`, `mirinjs-cli`, `mirinjs-darwin-arm64`,
`create-mirinjs`), so **no npm org is required** — they're claimed by the
publishing account on the first publish.

- **`NPM_TOKEN` secret** — create an npm **automation** access token with
  publish rights and add it as the repo secret `NPM_TOKEN`
  (`gh secret set NPM_TOKEN --repo Netko-Labs/mirin`). Already configured.

> Want the `@mirinjs/*` scope instead? Create a free npm org named `mirinjs`
> first, then rename `mirinjs-cli` → `@mirinjs/cli` and `mirinjs-darwin-arm64` →
> `@mirinjs/darwin-arm64`.

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
3. stages `libmirin_core.dylib` + `mirin-helper` into `mirinjs-darwin-arm64`,
4. uploads `cef-darwin-arm64.tar.gz` to the GitHub Release (the CLI downloads it),
5. publishes `mirinjs-darwin-arm64`, `create-mirinjs`, `mirinjs`, `mirinjs-cli` to npm
   (`bun publish` rewrites `workspace:*` to the concrete version).

Pre-release tags (`-alpha`/`-beta`) are marked as GitHub pre-releases and should
be published to npm under the `alpha` dist-tag once the workflow is hardened.

## What ships where

| Package | Contents |
|---|---|
| `mirinjs` | runtime API (TS source) |
| `mirinjs-cli` | `mirinjs` CLI; optional-deps the per-platform native package |
| `mirinjs-darwin-arm64` | prebuilt `libmirin_core.dylib` + `mirin-helper` |
| `create-mirinjs` | scaffolder + starter template |
| GitHub Release asset | `cef-darwin-arm64.tar.gz` (CEF is too large for npm) |

Adding a platform later = a new `mirinjs-<os>-<arch>` package + a matching CEF
release asset + a CI build matrix entry.
