# Updater transaction hardening follow-up

## Acceptance criteria

- [x] Preserve and complete the partial terminal handoff transaction state.
- [x] Stop auto-check and block check, download, and apply after helper handoff.
- [x] Reject or defer checks while download is active.
- [x] Guard every post-`beginDownload()` filesystem operation and release latches before best-effort cleanup.
- [x] Ensure cleanup failures never mask the original failure or make `checkForUpdate()` throw.
- [x] Remove successful generation work directories and prune abandoned generation directories at startup.
- [x] Give generations process/session ownership and preserve work owned by live app processes.
- [x] Allow `download()` directly from a committed check's `update-available` listener.
- [x] Keep the macOS backup through replacement launch; rollback and reopen the old app when launch fails.
- [x] Preserve Linux modes with `tar -xpf` and ensure owner execute on the validated regular executable.
- [x] Accept only consistently safe dotted channels.
- [x] Raise reconstructed tar/decompression limits to 8 GiB while retaining bounded subprocess and artifact output.
- [x] Bound in-memory patch inputs and release bsdiff sources separately from streaming tar output.
- [x] Add transaction, orchestration/failure, apply-script, channel, staged-bundle, pruning, and codec limit coverage.
- [x] Update updater architecture/API/platform/example documentation.
- [x] Run targeted and full TypeScript/Rust verification.
- [x] Commit in new commits and push normally to `security/updater-transaction-hardening`.
- [x] Authenticate exact manifest bytes with an embedded Ed25519 trust anchor.
- [x] Validate every update redirect hop before requesting it.
- [x] Reject hostile BSDIFF headers before entering the patch codec.
- [x] Preserve staged updates across checks and helper-owned generations across cleanup.
- [x] Make platform rollback remove partial replacements and verify restoration.
- [x] Detect an immediately failed Linux replacement launch.
- [x] Use topic-specific task filenames so the security PRs compose cleanly.

## Checkpoints

- Baseline: worktree started with only the existing partial `transaction.ts` edit; updater tests were 26 pass / 1 expected-behavior failure, codec tests were 3 pass.
- Targeted after remediation: updater/release tests 34/34; codec tests 4/4.
- Full TypeScript: `bun run fmt-lint` passed with 55 pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 48/48.
- Full Rust: `cargo fmt --all --check`, workspace clippy with warnings denied, workspace build, and workspace tests passed (6 tests).
- Patch hygiene: changed-file Biome check and `git diff --check` passed.
- Residual manual verification: signed/notarized macOS replacement-open rollback, Windows installed folder swap, and Linux packaged folder swap remain platform smokes.
- First clean-context review remediation: manifest signing, per-hop redirects,
  BSDIFF validation, staged-check preservation, helper PID ownership, and platform
  rollback hardening implemented.
- Post-review full TypeScript: `bun run fmt-lint` passed with the same 55
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 59/59.
- Post-review full Rust: `cargo fmt --all --check`, workspace clippy with warnings
  denied, and workspace tests passed (8 tests).
