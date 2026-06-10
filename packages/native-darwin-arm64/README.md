# @mirin/darwin-arm64

Prebuilt [mirin](https://github.com/Netko-Labs/mirin) native binaries for macOS
arm64: `libmirin_core.dylib` (the CEF browser-process core) and `mirin-helper`
(the CEF subprocess).

This package is an optional, platform-gated dependency of `@mirin/cli`. The
binaries are produced by CI on each release; you should not install or use it
directly. The CEF framework itself is downloaded separately on first run.
