# @mirinjs/win32-arm64

Prebuilt [mirin](https://github.com/Netko-Labs/mirin) native binaries for Windows
arm64 hosts: an x64 `mirin_core.dll`, `mirin-codec.exe` (atomic updater swap and
release codec), and `mirin-helper.exe`
compatibility payload executed through Windows 11 ARM's x64 emulation. Bun's
native Windows arm64 runtime does not currently provide `bun:ffi`; native ARM
execution will follow Mirin's Node-API bridge migration. Installed automatically
as an optional dependency of `@mirinjs/cli`; the matching x64 CEF runtime is
fetched separately on first build.
