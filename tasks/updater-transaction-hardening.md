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
- [x] Observe concurrent installer rejection immediately so atomic cleanup always runs.
- [x] Bound long Win32 identities and fail closed when window-class registration fails.
- [x] Hash every Windows identity so compact output cannot collide with a literal app id.
- [x] Keep validated app ids below portable filesystem component limits.
- [x] Remove Windows generation work before rollback relaunch.
- [x] Expire stale handoff reservations so PID reuse cannot block launch indefinitely.
- [x] Retire renderer RPC endpoints without deleting a same-id replacement generation.
- [x] Preserve relative macOS framework symlinks in install-filesystem staging.
- [x] Prune abandoned install-side staging siblings without touching live owner/helper work.
- [x] Keep recursive startup pruning off the replacement-readiness critical path.
- [x] Bound install-stage and helper PID reuse with session/creation leases.
- [x] Bound non-current generation-owner PID reuse with a modification-time lease.
- [x] Request terminal native quit before synchronous completion listeners.
- [x] Write replacement readiness before synchronous user ready listeners.
- [x] Keep public updater-instance generation work directories disjoint.
- [x] Require parent activation before a detached helper may arm or swap.
- [x] Share apply and terminal latches across every public updater instance.
- [x] Probe a packaged native atomic directory exchange before terminal handoff.
- [x] Keep the canonical launch path present through interruption and atomic rollback.
- [x] Atomically publish helper arming and replacement readiness receipts.
- [x] Force and confirm parent termination after an accepted graceful-shutdown deadline.
- [x] Confirm activated-helper death before abandoning ownership or preserve all recovery state.
- [x] Flush the complete install-side stage and durably order namespace and journal transitions.
- [x] Recover inactive pre-commit or committed transactions during host bootstrap after helper death or reboot.
- [x] Bind ownership, waiting, termination, arming, and readiness to OS process creation identity.
- [x] Validate the real swap operands' device/volume identity and reject Windows reparse points.
- [x] Exercise real Windows WMI/PowerShell/TxF rollback and successful readiness commit paths in CI.

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
- Eighth clean-context review remediation: observed installer rejection at task
  creation so Bun cannot bypass release cleanup, bounded long Win32 identities
  with a deterministic SHA-256-derived suffix, and failed closed when window
  class registration fails.
- Eighth-review full TypeScript: `bun run fmt-lint` passed with the same 52
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 237
  tests with the two expected Windows lifecycle skips on macOS; `git diff
  --check` passed.
- Eighth-review local Rust: `cargo fmt --all --check`, workspace clippy with
  warnings denied, and workspace tests passed (19 tests). A macOS-to-MSVC check
  could not pass the existing native C dependencies without Windows SDK headers;
  Windows compilation and the maximum-length identity test remain enforced by
  the Windows x64 CI job.
- Eighth-review CI follow-up: Windows x64 exposed and received a minimal fix for
  a target-gated borrow-after-move in identity compaction; the algorithm and its
  bounds are unchanged.
- Ninth/tenth clean-context review remediation: hash every Win32 identity, cap app
  ids at 233 portable characters, clean Windows rollback generations before
  relaunch, expire stale reservations after 24 hours, and retain same-id renderer
  endpoint generations across CEF cross-origin browser replacement.
- Ninth/tenth-review full TypeScript: `bun run fmt-lint` passed with the same 52
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 239
  tests with the two expected Windows lifecycle skips on macOS.
- Ninth/tenth-review local Rust: `cargo fmt --all --check`, workspace clippy with
  warnings denied, and workspace tests passed (20 tests across codec, core, and
  helper). The all-identity collision regression remains enforced by Windows CI.
- Ninth/tenth-review CI follow-up: Windows x64 passed build, clippy, and the new
  compact/literal collision regression, then exposed a stale 253-character test
  fixture index after the app-id cap moved to 233; the distinctness fixture now
  mutates its final character without a fixed index.
- Twelfth clean-context review remediation: preserve verbatim relative symlink
  targets while copying the validated macOS bundle beside its install, so CEF
  framework links remain inside the copied app during immediate revalidation.
- Twelfth-review full TypeScript: `bun run fmt-lint` passed with the same 52
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 240
  tests with the two expected Windows lifecycle skips on macOS.
- Thirteenth clean-context review remediation: prune only exact dead-owner
  install-side staging siblings at startup while preserving live owner PIDs,
  recorded apply-helper work, symlinks, and prefix lookalikes.
- Thirteenth-review full TypeScript: `bun run fmt-lint` passed with the same 52
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 241
  tests with the two expected Windows lifecycle skips on macOS; focused cleanup
  and staged-bundle coverage passed 8 tests; `git diff --check` passed.
- Fourteenth clean-context review remediation: write replacement readiness before
  asynchronous startup pruning, bind install stages to process sessions and creation
  timestamps, reject current-PID reuse, and expire unverifiable live owner/helper
  preservation after 24 hours.
- Fourteenth-review full TypeScript: `bun run fmt-lint` passed with the same 52
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 241
  tests with the two expected Windows lifecycle skips on macOS; focused cleanup
  and staged-bundle coverage passed 8 tests; `git diff --check` passed.
- Fifteenth clean-context review remediation: expire non-current live generation
  owners after the shared 24-hour handoff lease so recycled PIDs cannot retain
  abandoned generation trees indefinitely.
- Fifteenth-review full TypeScript: `bun run fmt-lint` passed with the same 52
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 241
  tests with the two expected Windows lifecycle skips on macOS; the focused
  startup-cleanup suite passed 3 tests; `git diff --check` passed.
- Sixteenth clean-context review remediation: request native terminal quit before
  completion observers, synchronously acknowledge replacement readiness before user
  `ready` listeners while deferring cleanup, and allocate generations process-wide
  across public updater instances.
- Sixteenth-review full TypeScript: `bun run fmt-lint` passed with the same 52
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 244
  tests with the two expected Windows lifecycle skips on macOS; the focused
  lifecycle/transaction suite passed 9 tests; `git diff --check` passed.
- Seventeenth clean-context review remediation: add a two-way helper activation
  barrier after the exact helper PID is recorded in the reservation, and share
  apply ownership, terminal state, and auto-check shutdown process-wide.
- Seventeenth-review full TypeScript: `bun run fmt-lint` passed with the same 52
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 246
  tests with the two expected Windows lifecycle skips on macOS; focused handoff,
  apply, cleanup, lifecycle, and transaction coverage passed 23 tests; `git diff
  --check` passed.
- Eighteenth clean-context review remediation: bundle and preflight the native
  atomic swap tool, use OS-level directory exchange so the canonical path is
  never absent, force/confirm accepted parent shutdown, atomically publish armed
  and readiness receipts, and retain terminal ownership plus recovery trees when
  activated-helper termination cannot be confirmed.
- Eighteenth-review full TypeScript: `bun run fmt-lint` passed with the same 52
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 246
  tests with the two expected Windows lifecycle skips on macOS; focused updater,
  handoff, and bundle coverage passed 38 tests; `git diff --check` passed.
- Eighteenth-review local Rust: `cargo fmt --all --check`, workspace clippy with
  warnings denied, and workspace tests passed (22 tests across codec, core, and
  helper). The native atomic-swap module also cross-compiled warning-free for
  `x86_64-pc-windows-msvc`; the full Windows workspace remains covered by CI
  because its existing C dependencies require Windows SDK headers unavailable on
  the macOS host.
- Nineteenth clean-context review remediation: recursively flush install-side
  stages, durably journal every helper namespace transition, reconcile inactive
  transactions before native runtime loading, use OS creation identities and
  handle-based wait/termination, validate the actual swap operands, and execute
  real Windows rollback and commit helpers in CI.
- Nineteenth-review focused verification: updater handoff/apply/staging/cleanup
  coverage passed 23 tests; codec clippy with warnings denied and 12 codec tests
  passed. The Windows-gated codec modules cross-compiled warning-free for
  `x86_64-pc-windows-msvc`; full workspace and native-platform verification
  follows before commit.
- Nineteenth-review full TypeScript: `bun run fmt-lint` passed with the same 52
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 251
  tests with the two expected Windows lifecycle skips on macOS; `git diff
  --check` passed.
- Nineteenth-review full Rust: `cargo fmt --all --check`, workspace clippy with
  warnings denied, and workspace tests passed (26 tests across codec, core, and
  helper).
- Twentieth clean-context review remediation: claim inactive recovery journals
  through an exact-owner single-winner namespace transition before native-core
  loading, flush marker/claim parent-directory transitions through the native
  codec on Windows, avoid deleting untrusted phase paths from invalid markers,
  recover marker-without-phase crashes while the source tree is canonical, have
  helpers self-publish their creation identity before parent activation, pin
  Linux pidfds before identity validation, and refuse unsafe numeric-PID forced
  termination on macOS. Bundle/release output now recursively flushes its stage
  and uses the native directory exchange, with durable first-output moves and
  legacy missing-canonical backup restoration.
- Twentieth-review full TypeScript: `bun run fmt-lint` passed with the same 52
  pre-existing warnings; `bun run typecheck` passed; `bun run test` passed 255
  tests with the two expected Windows lifecycle skips on macOS; focused
  handoff/apply/atomic-output coverage passed 25 tests; `git diff --check`
  passed.
- Twentieth-review full Rust: `cargo fmt --all --check`, workspace clippy with
  warnings denied, and workspace tests passed (26 tests across codec, core, and
  helper).
- Twenty-first clean-context review remediation: persist the launched
  replacement's exact process identity from both helper and target, block startup
  recovery while that process is live, require exact exit/termination before a
  rollback exchange, and make commit/rollback teardown remove the durable
  ownership marker before phase and receipt cleanup. The Windows success
  integration now launches the system PowerShell runtime instead of relocating
  its executable without required adjacent runtime files.
- Twenty-first-remediation verification: `bun run fmt-lint` passed with the
  repository's existing 52 warnings, `bun run typecheck` passed, and
  `bun run test` passed 256 tests with the two expected non-Windows skips.
- Twenty-first-remediation Rust verification: `cargo fmt --all --check`,
  workspace clippy with warnings denied, and workspace tests passed (26 tests
  across codec, core, and helper).
- Exact-head CI run `30092485118` passed static, dependency, Linux, macOS, and
  Windows x64 checks, including the repaired updater integration. Windows arm64
  then exposed that a signaled process object could retain a queryable creation
  token while another handle kept the object alive; Windows token lookup now
  requires an unsignaled synchronization handle before reporting the identity
  as live.
- Windows liveness remediation verification: `cargo fmt --all --check`,
  workspace clippy with warnings denied, and all 26 workspace tests passed.
  Cross-checking the Windows target from macOS reached the C dependencies but
  requires a Windows SDK, so the exact Windows compile/test remains covered by
  CI.
