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
- [x] Support authenticated ad-hoc macOS updates without pinning a build-specific cdhash.
- [x] Bound `version.json` before allocating or decoding it.
- [x] Reject repeated downloads after a generation is staged.
- [x] Put redirect hops and response bodies under metadata/artifact deadlines.
- [x] Record and terminate the directly launched Windows PowerShell helper.
- [x] Validate release versions with the runtime's strict SemVer grammar.
- [x] Share the exact six-field signed updater metadata contract across CLI bundle sinks and runtime parsing.
- [x] Compose signed release generation with owned atomic output staging and installer settlement.
- [x] Keep scaffold/fallback versions compatible with macOS bundle metadata.
- [x] Reject automatic apply for apps that permit multiple running instances.
- [x] Settle every parallel Linux package job before cleaning shared release staging.
- [x] Bound release notes and generated manifest bytes to the runtime parser limits.
- [x] Document DMG/Linux packages as intentional best-effort atomic-release exceptions.
- [x] Share the effective native single-instance override with the updater Worker.
- [x] Remove every expected Linux package output before best-effort failure recovery.
- [x] Keep post-commit atomic backup cleanup non-fatal and prune aged leftovers.
- [x] Acquire the cross-platform exclusive/shared app lock before starting user code.
- [x] Gate automatic apply on the acquired native capability, not configuration.
- [x] Prune only exact PID/UUID atomic backups and preserve prefix lookalikes.
- [x] Fail closed across host/Worker skew and reject mismatched runtime packages.
- [x] Reserve the post-exit launch for the validated staged updater version.
- [x] Retain backups until the replacement writes a durable readiness receipt.
- [x] Disable the standalone updater inside managed Linux package payloads.
- [x] Force terminal updater shutdown through zero-window and beforeunload cases.
- [x] Scope the Windows compatibility mutex to the bundle identifier.
- [x] Reuse monotonic lifecycle quit so pending and late windows cannot defeat handoff.
- [x] Bind reservation and readiness to the exact helper-launched PID and exclusive lock.
- [x] Use literal PowerShell filesystem paths for wildcard-bearing install locations.
- [x] Acknowledge helper prerequisites before quit and relaunch after every post-exit failure.
- [x] Bound POSIX replacement termination and preserve recoverable trees if it cannot stop.
- [x] Copy and revalidate the staged app beside the install before terminal handoff.
- [x] Scope Windows existing-window activation to the bundle-specific window class.

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
- Second clean-context review remediation: authenticated ad-hoc identity fallback,
  bounded metadata reads, staged-download rejection, network deadlines, direct
  Windows helper ownership, and build/runtime SemVer parity implemented.
- Second-review full TypeScript: `bun run fmt-lint` passed with the same 55
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 64/64.
- Second-review full Rust: `cargo fmt --all --check`, workspace clippy with warnings
  denied, and workspace tests passed (8 tests).
- Integration review remediation: stacked the packaging-safety branch without history
  rewriting, unified channel/SemVer/public-key validation, and preserved both atomic
  release staging and signed/bounded updater generation.
- Integration full TypeScript: `bun run fmt-lint` passed with the same 55
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 202 tests
  with the two expected Windows lifecycle skips on macOS.
- Integration full Rust: `cargo fmt --all --check`, workspace clippy with warnings
  denied, and workspace tests passed (8 tests).
- Third clean-context review remediation: restored a nonzero scaffold/fallback app
  version, rejected unsafe multi-instance automatic apply, and settled every Linux
  package child before cleanup while removing partial successful siblings.
- Third clean-context follow-up: bounded release notes and generated manifests to
  the runtime parser limits and documented DMG/Linux package failures as deliberate
  best-effort exceptions to required atomic release output.
- Third-review full TypeScript: `bun run fmt-lint` passed with 52 pre-existing
  warnings (three warnings removed in touched Linux packaging code);
  `bun run typecheck` passed; `bun run test` passed 208 tests with the two expected
  Windows lifecycle skips on macOS; `git diff --check` passed.
- Fourth clean-context review remediation: passed the effective native
  single-instance value to the Worker, removed rejected-job and successful-sibling
  Linux package output before best-effort recovery, failed closed on staging/output
  cleanup errors, and made post-commit atomic backup cleanup recoverable.
- Fourth-review full TypeScript: `bun run fmt-lint` passed with the same 52
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 212
  tests with the two expected Windows lifecycle skips on macOS;
  `git diff --check` passed.
- Fifth clean-context review remediation: acquired a process-lifetime exclusive
  or shared native app lock before starting user code, passed the actual
  exclusive capability to the updater, gave every multi-instance process a
  PID-specific CEF cache, and limited stale atomic-backup pruning to exact
  PID/UUID-owned directories whose owner is gone.
- Fifth-review full TypeScript: `bun run fmt-lint` passed with the same 52
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 214
  tests with the two expected Windows lifecycle skips on macOS; changed-file
  Biome and `git diff --check` passed.
- Fifth-review full Rust: `cargo fmt --all --check`, workspace clippy with
  warnings denied, workspace build, and workspace tests passed (9 tests,
  including shared/exclusive lock exclusion).
- Sixth clean-context review remediation: made updater capability negotiation
  protocol-versioned and build-version checked, reserved the lock handoff for
  the staged version, required a Worker/native readiness receipt before deleting
  backups, removed updater metadata from managed Linux packages, added forced
  zero-window-safe shutdown, and bundle-scoped the Windows compatibility mutex.
- Sixth-review full TypeScript: `bun run fmt-lint` passed with the same 52
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 220
  tests with the two expected Windows lifecycle skips on macOS;
  `git diff --check` passed.
- Sixth-review full Rust: `cargo fmt --all --check`, workspace clippy with
  warnings denied, and workspace tests passed (9 tests). Windows mutex identity
  and PowerShell parser coverage are enforced in the Windows x64 CI job.
- Stacked lifecycle integration: the readiness receipt is queued from the app
  bootstrap's `ready` listener, so the lifecycle branch can wait for every
  automatic native window without conflicting in the shared event-wiring block.
- Seventh clean-context review remediation: merged the lifecycle branch without
  rewriting history, made updater quit monotonic, bound the token/lock/receipt
  to the exact successor PID, moved validated staging onto the install
  filesystem, added helper arming and uniform rollback/relaunch, bounded POSIX
  termination, made PowerShell paths literal, and bundle-scoped Windows
  existing-window activation.
- Seventh-review full TypeScript: `bun run fmt-lint` passed with the same 52
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 236
  tests with the two expected Windows lifecycle skips on macOS; the focused
  updater/lifecycle suite passed 26 tests; `git diff --check` passed.
- Seventh-review full Rust: `cargo fmt --all --check`, workspace clippy with
  warnings denied, and workspace tests passed (19 tests across codec, core, and
  helper). Windows window-class identity and generated PowerShell parsing remain
  enforced by the Windows x64 CI job.
