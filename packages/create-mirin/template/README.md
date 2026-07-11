# __APP_NAME__

A desktop app built with [mirin](https://github.com/Netko-Labs/mirin) — Bun +
TypeScript + Chromium.

```bash
bun install
bun run dev     # native window with Vite HMR + typed RPC
bun run build   # standalone app in ./build
```

- `mirin.config.ts` — the app manifest (windows, ids).
- `main/` — the Bun main process (RPC handlers, app lifecycle).
- `ui/` — the React UI, served via the `app://` scheme in builds.

Requires Bun on macOS arm64, Windows x64/arm64, or Linux x64/arm64. macOS
distribution builds also need the Xcode command-line tools for signing.
