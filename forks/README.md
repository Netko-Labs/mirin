# forks

Upstream crates mirin owns a fork of. Each one is a real fork with git
history, not a copied-in snapshot: the `forks-upstream` branch holds the
crates exactly as published (minus `examples/`, `Cargo.lock`,
`Cargo.toml.orig`, and packaging metadata), and mirin's changes sit on top of
it in the main history. Each fork's `MIRIN.md` lists every change and why;
changed code carries a `// mirin:` comment.

| Fork | Upstream | Used by |
| --- | --- | --- |
| `gpui` | `gpui` 0.2.2 (Zed Industries, Apache-2.0) | `crates/mirin-metal` |
| `taffy` | `taffy` 0.9.0 (DioxusLabs, MIT), the version GPUI pins | `forks/gpui` |
| `accesskit_unix` | `accesskit_unix` 0.24.1 (AccessKit, MIT OR Apache-2.0) | `crates/mirin-metal` |

`crates/mirin-metal/Cargo.toml` points `[patch.crates-io]` here. The forks are
excluded from the root Cargo workspace; each builds alone with mirin-metal's
lockfile (`forks/gpui/MIRIN.md`).

## Syncing upstream

Upstream updates are a merge, so git carries mirin's changes forward and only
real conflicts need hands:

```sh
git worktree add ../forks-upstream forks-upstream
cd ../forks-upstream
# replace forks/<name> with the new release, dropping examples/, Cargo.lock,
# Cargo.toml.orig and packaging metadata, then:
git add -A forks/<name> && git commit -m "chore(forks): <name> <version> upstream"
cd - && git merge forks-upstream    # resolve conflicts against MIRIN.md
```

Then update the fork's `MIRIN.md` (version, changes that upstream absorbed)
and run its tests and mirin-metal's.
