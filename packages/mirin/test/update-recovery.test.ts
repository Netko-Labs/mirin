import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateHandoffRecovery } from "../src/update-handoff.ts";
import { processIdentity } from "../src/update-process.ts";
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
    expect(script).toContain("$visibleArmedIdentity -ne $selfIdentity");
    expect(script).toContain("sync-parent 'C:\\State\\.armed'");
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
    expect(script).toContain('test "$ARMED_IDENTITY" = "$SELF_IDENTITY"');
    expect(script).toContain('"$TOOL" sync-parent "$ARMED"');
    expect(script.indexOf("sync-parent")).toBeLessThan(script.indexOf("durable-remove-directory"));
    if (process.platform !== "win32") {
      expect(Bun.spawnSync(["/bin/sh", "-n", "-c", script]).exitCode).toBe(0);
    }
  });

  test("continues recovery when the armed receipt is visible before sync fails", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "mirin-recovery-armed-visible-"));
    const app = join(root, "Mirin");
    const restore = join(root, "Mirin.old");
    const state = join(root, "state");
    const tool = join(state, "mirin-codec");
    const activated = join(state, ".activated");
    const armed = join(state, ".armed");
    const identity = join(state, ".identity");
    const scriptPath = join(state, "recover.sh");
    mkdirSync(app);
    mkdirSync(restore);
    mkdirSync(state);
    writeFileSync(join(app, "new-sentinel"), "new");
    writeFileSync(join(restore, "old-sentinel"), "old");
    writeVisibleFailureTool(tool, armed);
    const owner = Bun.spawn(["/bin/sh", "-c", "sleep 30"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const ownerIdentity = { pid: owner.pid, token: `token-${owner.pid}` };
    const testRecovery: UpdateHandoffRecovery = {
      ...recovery,
      markerPath: join(state, ".update-handoff.json"),
      phasePath: join(state, ".update-phase"),
      readyPath: join(state, ".update-ready"),
      replacementPath: join(state, ".update-replacement"),
      runningApp: app,
      staged: restore,
      backup: restore,
      restorePath: restore,
      owner: ownerIdentity,
      claimPaths: [join(state, ".update-claim")],
    };
    writeFileSync(testRecovery.markerPath, "{}");
    writeFileSync(testRecovery.phasePath, "backed-up");
    writeFileSync(testRecovery.claimPaths[0], "{}");
    writeFileSync(
      scriptPath,
      renderPosixRecovery(testRecovery, tool, "Mirin", activated, armed, identity, scriptPath),
    );
    chmodSync(scriptPath, 0o700);
    const helper = Bun.spawn(["/bin/sh", scriptPath], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForFile(identity);
      writeFileSync(activated, `${helper.pid}|token-${helper.pid}`);
      await waitForFile(armed);
      await Bun.sleep(350);
      expect(processIdentity(helper.pid, tool)?.token).toBe(`token-${helper.pid}`);
      expect(existsSync(join(app, "new-sentinel"))).toBe(true);
      expect(existsSync(join(restore, "old-sentinel"))).toBe(true);
      expect(existsSync(testRecovery.markerPath)).toBe(true);
    } finally {
      try {
        helper.kill("SIGKILL");
      } catch {}
      try {
        owner.kill("SIGKILL");
      } catch {}
      await Promise.allSettled([helper.exited, owner.exited]);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeVisibleFailureTool(path: string, armed: string): void {
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      "set -eu",
      'operation="$1"; shift',
      'case "$operation" in',
      '  process-token) kill -0 "$1" 2>/dev/null; printf "token-%s\\n" "$1" ;;',
      '  durable-write) temporary="$1.tmp.$$"; printf "%s" "$2" > "$temporary"; mv "$temporary" "$1";',
      `    if [ "$1" = '${armed}' ]; then sleep 0.2; exit 1; fi ;;`,
      "  sync-parent) : ;;",
      '  wait-process) while kill -0 "$1" 2>/dev/null; do sleep 0.01; done ;;',
      "  terminate-process) exit 1 ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o700);
}

async function waitForFile(path: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}
