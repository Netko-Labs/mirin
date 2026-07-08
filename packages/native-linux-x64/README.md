# @mirinjs/linux-x64

Prebuilt [mirin](https://github.com/Netko-Labs/mirin) native binaries for Linux
x64: `libmirin_core.so` (the CEF browser-process core, `dlopen`ed by the host) and
`mirin-helper` (the CEF subprocess).

This package is an optional, platform-gated dependency of `@mirinjs/cli`. The
binaries are produced by CI on each release; you should not install or use it
directly. The CEF runtime itself is downloaded separately on first build.
