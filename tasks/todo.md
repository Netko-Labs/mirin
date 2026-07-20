# Runtime Capability Lifecycle Remediation

## Acceptance criteria

- [x] Correlate native pending window-creation reservations by Mirin window ID.
- [x] Reject platform browser creation failures, clean native shell/state, release the exact reservation, and emit `window.create-failed`.
- [x] Reject and unregister failed TypeScript window handles; automatic-window failure does not emit ready and quits orderly.
- [x] Replace global close state with per-window/browser tracking; explicit quit is monotonic, force-closes all current/late browsers, and resists beforeunload cancellation.
- [x] Finish a requested quit when reservation rollback or UI-task-post failure reaches zero live/pending windows.
- [x] Delete pending bootstrap requests on serialization failure and ignore messages from stale sockets.
- [x] Preserve pre-ready Dock policy at native core readiness before automatic windows open.
- [x] Add focused tests for the verified creation, close/quit, rollback, Dock, and bootstrap interleavings.
- [x] Run targeted and full applicable verification, then commit and push the existing branch without rewriting history.

## Checkpoints

- [x] Confirmed clean `fix/runtime-capability-lifecycle` worktree at `60f5268`.
- [x] Read repository instructions and verification requirements.
- [x] Focused lifecycle/bootstrap tests: 12 passed.
- [x] Runtime package and full monorepo TypeScript typechecks passed.
- [x] Full TypeScript tests: 36 passed.
- [x] Full Rust format, Clippy (`-D warnings`), build, and workspace tests passed (13 tests).
- [x] `bun audit`: no vulnerabilities found.
- [x] Native hello-react smoke reached `all windows ready`, connected/rendered through Vite, autoquit with exit code 0, and left no helper processes.
- [ ] `cargo-audit`: unavailable because the command is not installed.
- [ ] Residual native smokes: multi-window close ordering, DevTools/popup reservation ordering, beforeunload escalation, foreground Dock observation, and Windows/Linux runtime execution.
