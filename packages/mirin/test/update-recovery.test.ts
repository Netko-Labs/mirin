import { describe, expect, test } from "bun:test";
import type { UpdateHandoffRecovery } from "../src/update-handoff.ts";
import { renderPosixRecovery, renderWindowsRecovery } from "../src/update-recovery.ts";

const recovery: UpdateHandoffRecovery = {
  mode: "rollback",
  token: "42-00000000-0000-0000-0000-000000000000",
  markerPath: "C:\\State\\.update-handoff.json",
  phasePath: "C:\\State\\.update-phase-42-token",
  readyPath: "C:\\State\\.update-ready-42-token",
  replacementPath: "C:\\State\\.update-replacement-42-token",
  runningApp: "C:\\Apps\\Mirin",
  staged: "C:\\Apps\\.mirin-new-0123456789abcdef-42-token",
  backup: "C:\\Apps\\Mirin.mirin-old-42-token",
  restorePath: "C:\\Apps\\Mirin.mirin-old-42-token",
  owner: { pid: 42, token: "owner-token" },
  claimPaths: ["C:\\State\\.update-recovery-claim-42-token"],
};

describe("updater recovery helpers", () => {
  test("moves Windows recovery outside the install and retries an exchanged durability failure", () => {
    const script = renderWindowsRecovery(
      recovery,
      "C:\\State\\mirin-codec.exe",
      "Mirin.exe",
      "C:\\State\\.activated",
      "C:\\State\\.armed",
      "C:\\State\\.identity",
      "C:\\State\\recover.ps1",
    );
    const changeDirectory = script.indexOf("Set-Location -LiteralPath $env:TEMP");
    const exchange = script.indexOf("atomic-swap");

    expect(changeDirectory).toBeGreaterThan(0);
    expect(changeDirectory).toBeLessThan(exchange);
    expect(script).toContain("if ($swapExit -eq 2)");
    expect(script).toContain("sync-parent");
    expect(script.indexOf("sync-parent")).toBeLessThan(script.indexOf("durable-remove-directory"));
  });

  test("retries a visible POSIX recovery exchange before deleting either tree", () => {
    const posixRecovery: UpdateHandoffRecovery = {
      ...recovery,
      markerPath: "/state/.update-handoff.json",
      phasePath: "/state/.update-phase-42-token",
      readyPath: "/state/.update-ready-42-token",
      replacementPath: "/state/.update-replacement-42-token",
      runningApp: "/opt/Mirin",
      staged: "/opt/.mirin-new-0123456789abcdef-42-token",
      backup: "/opt/Mirin.mirin-old-42-token",
      restorePath: "/opt/Mirin.mirin-old-42-token",
      claimPaths: ["/state/.update-recovery-claim-42-token"],
    };
    const script = renderPosixRecovery(
      posixRecovery,
      "/state/mirin-codec",
      "Mirin",
      "/state/.activated",
      "/state/.armed",
      "/state/.identity",
      "/state/recover.sh",
    );

    expect(script).toContain('if [ "$swap_status" -eq 2 ]');
    expect(script).toContain('"$TOOL" sync-parent "$APP"');
    expect(script.indexOf("sync-parent")).toBeLessThan(script.indexOf("durable-remove-directory"));
    if (process.platform !== "win32") {
      expect(Bun.spawnSync(["/bin/sh", "-n", "-c", script]).exitCode).toBe(0);
    }
  });
});
