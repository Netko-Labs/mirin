# @mirinjs/win32-arm64

Prebuilt [mirin](https://github.com/Netko-Labs/mirin) native binaries for Windows
arm64: `mirin_core.dll` (the FFI core, `dlopen`ed by the host) and
`mirin-helper.exe` (the CEF subprocess). Installed automatically as an optional
dependency of `@mirinjs/cli` on Windows arm64; the CEF runtime is fetched
separately on first build.
