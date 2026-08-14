# Releasing

Releases are cut by pushing a `v*` tag from a commit already merged into `main`;
GitHub Actions builds the native artifacts and publishes to the registry.
Nothing is published until you tag.

## One-time setup

The CLI and native packages publish under the **`@mirinjs` org scope**
(`@mirinjs/cli` and one native package per platform); `mirinjs` and
`create-mirinjs` are unscoped. The org and publish token are already configured:

- **`@mirinjs` org** — owned on the registry; the publish token has access to it.
- **`NPM_TOKEN` secret** — a registry automation token with publish rights, set as the
  repo secret (`gh secret set NPM_TOKEN --repo Netko-Labs/mirin`).
- **Blacksmith** — CI/release use Blacksmith macOS 15, Windows 2025, and Ubuntu
  24.04 runners. Install the Blacksmith GitHub app for this repository in the
  **Netko-Labs org** at <https://app.blacksmith.sh>.

## Cutting a release

```bash
bun scripts/version.ts 0.0.1-alpha.1   # bumps all packages + Cargo in sync
git commit -am "🚀 release: v0.0.1-alpha.1"
git tag -a v0.0.1-alpha.1 -m "v0.0.1-alpha.1"
git push --follow-tags
```

The tag must be **annotated** (`-a`): `--follow-tags` pushes only annotated tags,
so a lightweight `git tag v…` pushes the commit and silently skips the tag —
main moves, no release runs. Recover with `git push origin v0.0.1-alpha.1`.

`release.yml` then, on the `v*` tag:

1. verifies the tag matches `packages/mirin`, checks its commit is in `main`, and
   creates an invisible draft release,
2. builds native binaries concurrently on macOS arm64, Windows x64/arm64, and
   Linux x64/arm64,
3. stages each platform's core and helper, uploads its CEF archive plus SHA-256
   checksum to the draft, and preserves its small packed registry tarball,
4. waits for every platform, verifies all packed names and versions, then
   publishes the native packages plus `create-mirinjs`, `mirinjs`, and
   `@mirinjs/cli`,
5. publishes the GitHub release only after the registry step succeeds.

If any platform fails, the release remains a draft and no shared package is
published.

Each package is packed with `bun pm pack` and uploaded with `bun publish
<tarball>` using `NPM_CONFIG_TOKEN`. Stable versions use the `latest` registry
tag. Prereleases use their channel (`alpha`, `beta`, `rc`, and so on); unknown
prerelease channels use `next`, so a prerelease can never replace `latest`.

Pre-release tags (`-alpha`/`-beta`) are marked as GitHub pre-releases.

## What ships where

| Package | Contents |
|---|---|
| `mirinjs` | runtime API (TS source) |
| `@mirinjs/cli` | `mirinjs` CLI; optional-deps the per-platform native package |
| `@mirinjs/darwin-arm64` | prebuilt macOS core + helper |
| `@mirinjs/win32-x64` / `@mirinjs/win32-arm64` | prebuilt Windows core + helper |
| `@mirinjs/linux-x64` / `@mirinjs/linux-arm64` | prebuilt Linux core + helper |
| `create-mirinjs` | scaffolder + starter template |
| GitHub Release assets | `cef-<platform>-<arch>.tar.gz` plus `.sha256` (CEF is too large for the package registry) |

Adding a platform later = a new `@mirinjs/<os>-<arch>` package + a matching CEF
release asset + a CI build matrix entry.
