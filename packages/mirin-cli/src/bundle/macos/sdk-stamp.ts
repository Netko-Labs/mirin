/**
 * Stamp the compiled host with the macOS 26 SDK version.
 *
 * `bun build --compile` clones the Bun runtime binary, so the host inherits
 * Bun's LC_BUILD_VERSION (SDK 15.x). AppKit gates the macOS 26 window design
 * ("linked-on-or-after") on the MAIN executable's SDK, which leaves mirin apps
 * with the pre-Tahoe compatibility chrome — flat traffic lights, old window
 * metrics. Rewriting the load command opts the app into the current design.
 * Must run before codesigning; vtool invalidates the signature.
 */

import { existsSync, renameSync } from "node:fs";
import { $ } from "bun";

/** Matches the LSMinimumSystemVersion mirin writes into Info.plist. */
const MIN_OS = "13.0";
/** The design-gate threshold; the number is declarative, no SDK needs to exist locally. */
const SDK = "26.0";

/** Best-effort: a missing vtool (bare machines) keeps Bun's original header. */
export async function stampMacSdk(hostExe: string): Promise<void> {
  if (process.platform !== "darwin") return;
  if (!Bun.which("vtool")) {
    console.warn("[mirin] vtool not found — the app keeps the compatibility window design.");
    return;
  }
  const out = `${hostExe}.sdkstamp`;
  const res =
    await $`vtool -set-build-version macos ${MIN_OS} ${SDK} -replace -output ${out} ${hostExe}`
      .nothrow()
      .quiet();
  if (res.exitCode !== 0 || !existsSync(out)) {
    console.warn(`[mirin] vtool failed (exit ${res.exitCode}) — keeping Bun's SDK header.`);
    return;
  }
  renameSync(out, hostExe);
  await $`chmod +x ${hostExe}`.quiet();
}
