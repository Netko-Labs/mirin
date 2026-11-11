# forks (pristine upstream)

This branch (`forks-upstream`) holds the upstream crates mirin forks, byte for
byte as published, minus `examples/`, `Cargo.lock`, `Cargo.toml.orig`, and
packaging metadata. mirin's changes live on top of it in the main history, so
syncing upstream is a git merge of this branch, not a hand re-apply.
