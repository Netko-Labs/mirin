# __APP_NAME__

A desktop app built with [mirin](https://github.com/Netko-Labs/mirin) — Bun +
TypeScript + Chromium.

```bash
bun install
bun run dev      # native window with Vite HMR + typed RPC
bun run check    # boot once, capture a screenshot + UI snapshot, exit non-zero on errors
bun run doctor   # check the project and environment without building
bun run build    # standalone app in ./build
```

- `mirin.config.ts` — the app manifest (windows, ids).
- `main/` — the Bun main process (RPC handlers, app lifecycle).
- `ui/` — the React UI, served via the `app://` scheme in builds.
- `AGENTS.md` — how to inspect a running app (structured logs, screenshots, UI
  snapshots), for AI coding tools and for you.

Requires Bun on macOS arm64, Windows x64/arm64, or Linux x64/arm64. macOS
distribution builds also need the Xcode command-line tools for signing.
