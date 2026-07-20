# CLI packaging safety remediation

## Acceptance criteria

- [x] POSIX scaffold paths such as `/tmp/c:valid-app` validate the basename `c:valid-app`, not a Windows drive interpretation.
- [x] Windows reserved scaffold names (`con`, `prn`, `aux`, `nul`, `com1`-`com9`, `lpt1`-`lpt9`) are rejected before project files are copied.
- [x] Every accepted scaffold directory name also passes app-name validation.
- [x] Project source files are canonically revalidated for containment immediately before use and copy.
- [x] Bundle and release output roots reject symlink/reparse-point paths and reassert containment immediately before destructive cleanup using `result.projectDir`.
- [x] Extra asset names are Windows-portable and case-insensitively unique.
- [x] NSIS removes the owned `$INSTDIR\app` tree before overlaying a new version.
- [x] NSIS safely migrates and cleans known legacy flat payloads without recursively deleting unrelated root files.
- [x] NSIS uninstall handles both new-layout and legacy-flat installations while preserving unrelated sentinels.
- [x] NSIS tests cover flat-to-new-to-uninstall and new-v1-to-new-v2 removed-file cleanup.
- [x] Inno validates `installDir` and safely escapes all structured literal paths.

## Verification

- [x] Targeted scaffold/path tests.
- [x] Targeted installer tests (Windows lifecycle cases are CI-gated and skip on macOS).
- [x] `git diff --check`.
- [x] `bun run fmt-lint` (repository baseline warnings remain; no changed-file errors).
- [x] `bun run typecheck`.
- [x] `bun run test`.
- [ ] Hello production build: Vite, Rust, host, and workers completed; `.app` assembly is blocked because artifact resolution does not accept the linked parent CEF cache.
- [x] Commit conventionally and push `security/cli-packaging-safety` without rewriting history.
