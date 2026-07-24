import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareUpdateHandoff } from "../src/update-handoff.ts";
import {
  formatProcessIdentity,
  parseProcessIdentity,
  processIdentity,
  type UpdateProcessIdentity,
} from "../src/update-process.ts";
import {
  assertLinuxInstallCanApply,
  renderLinuxApplyShell,
  renderMacApplyShell,
  renderWindowsApplyPowerShell,
  renderWindowsLaunchVbs,
  spawnShellSwap,
} from "../src/updater/lib/apply.ts";

describe("Windows updater launcher", () => {
  test("propagates Win32_Process.Create status before the app can quit", () => {
    const script = renderWindowsLaunchVbs(
      'C:\\Temp\\Mirin "Update"\\apply.ps1',
      "C:\\Updates\\generation\\.apply-helper.pid",
    );
    expect(script).toContain('status = GetObject("winmgmts:Win32_Process").Create');
    expect(script).toContain("powershell.exe");
    expect(script).not.toContain("wscript.exe //B");
    expect(script).toContain("If status <> 0 Then WScript.Quit status");
    expect(script).toContain("CreateTextFile");
    expect(script).toContain(".apply-helper.pid");
    expect(script).toContain("Win32_Process.Handle=");
    expect(script).toContain(".Terminate");
    expect(script).toContain("WScript.Quit 0");
    expect(script).toContain('""Update""');
  });

  test("uses literal paths and commits only after the exact replacement reports ready", () => {
    const script = renderWindowsApplyPowerShell({
      runningApp: "C:\\Apps\\[beta]\\Mirin",
      staged: "C:\\Apps\\[beta]\\.Mirin.mirin-new-42-token",
      workDir: "C:\\Updates\\generation",
      executable: "C:\\Apps\\[beta]\\Mirin\\Mirin.exe",
      backup: "C:\\Apps\\[beta]\\Mirin.old",
      helperFiles: ["C:\\Temp\\apply.ps1", "C:\\Temp\\apply.vbs"],
      marker: "C:\\State\\.update-handoff.json",
      ready: "C:\\State\\.update-ready-42-token",
      activated: "C:\\Updates\\generation\\.apply-helper-activated",
      armed: "C:\\Updates\\generation\\.apply-helper-armed",
      phase: "C:\\State\\.update-phase-42-token",
      swapTool: "C:\\Updates\\generation\\.mirin-atomic-swap.exe",
      token: "42-00000000-0000-0000-0000-000000000000",
      pid: 42,
      parentToken: "parent-token",
    });
    const launch = script.indexOf("Start-Process -FilePath");
    const prelaunchGuard = script.indexOf("pending:launch");
    const readiness = script.indexOf("Replacement did not report ready", launch);
    expect(launch).toBeGreaterThan(0);
    expect(prelaunchGuard).toBeGreaterThan(0);
    expect(prelaunchGuard).toBeLessThan(launch);
    expect(readiness).toBeGreaterThan(launch);
    expect(script.indexOf("C:\\Updates\\generation", launch)).toBeGreaterThan(launch);
    expect(script.indexOf("C:\\Apps\\[beta]\\Mirin.old", launch)).toBeGreaterThan(launch);
    expect(script.indexOf("C:\\State\\.update-handoff.json", readiness)).toBeGreaterThan(readiness);
    expect(script).toContain("Updater backup path already exists");
    expect(script).toContain("atomic-swap");
    expect(script).toContain("Application could not be terminated for updater handoff");
    expect(script).toContain("$preserveOwnership=$true");
    expect(script).not.toContain(
      "Move-Item -LiteralPath 'C:\\Apps\\[beta]\\Mirin' -Destination 'C:\\Apps\\[beta]\\Mirin.old'",
    );
    expect(script).not.toContain(
      "Move-Item -LiteralPath 'C:\\Apps\\[beta]\\.Mirin.mirin-new-42-token' -Destination 'C:\\Apps\\[beta]\\Mirin'",
    );
    expect(script).toContain("Replacement readiness receipt has the wrong process identity");
    expect(script).toContain("$readyProcess -ne $readyIdentity");
    expect(script).toContain("$replacementGuard='pending:'");
    expect(script).toContain("Could not guard replacement launch");
    expect(script).toContain("Could not guard unidentified replacement process");
    expect(script).toContain("if ([string]::IsNullOrWhiteSpace($newToken))");
    expect(script).toContain("$newProcess.WaitForExit()");
    expect(script).toContain("$canRestore=($terminationSucceeded -and $newProcess.HasExited)");
    const activated = script.indexOf(".apply-helper-activated");
    const armed = script.indexOf(".apply-helper-armed");
    expect(activated).toBeGreaterThan(0);
    expect(activated).toBeLessThan(
      script.indexOf("Application exited before updater helper activation"),
    );
    expect(
      script.indexOf("Updater helper activation has the wrong process identity"),
    ).toBeGreaterThan(activated);
    expect(armed).toBeGreaterThan(activated);
    expect(armed).toBeLessThan(script.indexOf("wait-process"));
    expect(script).toContain("durable-write");
    expect(script).toContain("swap-pending");
    expect(script).toContain("backup-pending");
    expect(script).toContain("committed");
    expect(script).toContain("terminate-process");
    expect(script).toContain(".update-replacement-42-00000000-0000-0000-0000-000000000000");
    const committedPhase = script.indexOf(
      "durable-write' 'C:\\State\\.update-phase-42-token' 'committed",
    );
    const markerCleanup = script.indexOf(
      "durable-remove-file' 'C:\\State\\.update-handoff.json",
      committedPhase,
    );
    const phaseCleanup = script.indexOf(
      "durable-remove-file' 'C:\\State\\.update-phase-42-token",
      markerCleanup,
    );
    expect(committedPhase).toBeGreaterThan(0);
    expect(markerCleanup).toBeGreaterThan(committedPhase);
    expect(phaseCleanup).toBeGreaterThan(markerCleanup);
    const rollback = script.indexOf("if ($parentExited -and $canRestore)");
    const rollbackCleanup = script.indexOf(
      "Remove-Item -LiteralPath 'C:\\Updates\\generation' -Recurse",
      rollback,
    );
    const rollbackRelaunch = script.indexOf("Start-Process -FilePath", rollbackCleanup);
    expect(rollback).toBeGreaterThan(0);
    expect(rollbackCleanup).toBeGreaterThan(rollback);
    expect(rollbackRelaunch).toBeGreaterThan(rollbackCleanup);
    for (const line of script.split("\n")) {
      if (/\b(?:Test-Path|Get-Content|Move-Item|Remove-Item)\b/.test(line)) {
        expect(line).toContain("-LiteralPath");
      }
    }
    if (process.platform === "win32") {
      const parsed = Bun.spawnSync({
        cmd: [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[void][scriptblock]::Create($env:MIRIN_TEST_SCRIPT)",
        ],
        env: { ...process.env, MIRIN_TEST_SCRIPT: script },
      });
      expect(parsed.exitCode).toBe(0);
    }
  });

  test("executes WMI PID publication and TxF rollback after an injected post-exchange failure", async () => {
    if (process.platform !== "win32") return;
    const codec = windowsCodec();
    const root = mkdtempSync(join(tmpdir(), "mirin-windows-apply-integration-"));
    const app = join(root, "Mirin");
    const staged = join(root, ".Mirin.mirin-new-test");
    const backup = join(root, "Mirin.mirin-old-test");
    const state = join(root, "state");
    const work = join(root, "work");
    const marker = join(state, ".update-handoff.json");
    const phase = join(state, ".update-phase-test");
    const ready = join(state, ".update-ready-test");
    const activated = join(work, ".apply-helper-activated");
    const armed = join(work, ".apply-helper-armed");
    const script = join(root, "apply.ps1");
    const launchVbs = join(root, "launch.vbs");
    const helperPidFile = join(work, ".apply-helper.pid");
    const helperLaunchPidFile = join(work, ".apply-helper-launch.pid");
    const executable = join(app, "Mirin.exe");
    const powershell = join(
      process.env.SystemRoot as string,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    mkdirSync(app);
    mkdirSync(staged);
    mkdirSync(state);
    mkdirSync(work);
    writeFileSync(join(app, "old-sentinel"), "old");
    writeFileSync(join(staged, "new-sentinel"), "new");
    copyFileSync(codec, join(app, "Mirin.exe"));
    copyFileSync(powershell, join(staged, "Mirin.exe"));
    writeFileSync(marker, "{}");
    runTestCodec(codec, ["durable-write", phase, "prepared"]);

    const parent = Bun.spawn(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const parentIdentity = await waitForTestIdentity(parent.pid, codec);
    writeFileSync(
      script,
      renderWindowsApplyPowerShell({
        runningApp: app,
        staged,
        workDir: work,
        executable,
        backup,
        helperFiles: [script, launchVbs],
        marker,
        ready,
        activated,
        armed,
        phase,
        swapTool: codec,
        token: "42-00000000-0000-0000-0000-000000000000",
        pid: parent.pid,
        parentToken: parentIdentity.token,
        parentWaitMs: 5_000,
        failurePoint: "after-exchange",
      }),
    );
    writeFileSync(launchVbs, renderWindowsLaunchVbs(script, helperLaunchPidFile));

    try {
      const launcher = Bun.spawn(["wscript.exe", "//B", "//Nologo", launchVbs]);
      expect(await launcher.exited).toBe(0);
      const helperPid = Number(readFileSync(helperLaunchPidFile, "utf8"));
      await waitForFile(helperPidFile);
      const helperIdentity = parseProcessIdentity(readFileSync(helperPidFile, "utf8"));
      expect(helperIdentity.pid).toBe(helperPid);
      expect(processIdentity(helperPid, codec)?.token).toBe(helperIdentity.token);
      runTestCodec(codec, ["durable-write", activated, formatProcessIdentity(helperIdentity)]);
      await waitForFile(armed);
      expect(parseProcessIdentity(readFileSync(armed, "utf8"))).toEqual(helperIdentity);
      runTestCodec(codec, ["terminate-process", String(parentIdentity.pid), parentIdentity.token]);
      expect(await waitForProcessExit(helperIdentity, codec)).toBe(true);
      expect(existsSync(join(app, "old-sentinel"))).toBe(true);
      expect(existsSync(join(app, "new-sentinel"))).toBe(false);
      expect(existsSync(staged)).toBe(false);
      expect(existsSync(backup)).toBe(false);
    } finally {
      const currentParent = processIdentity(parent.pid, codec);
      if (currentParent?.token === parentIdentity.token) {
        runTestCodec(codec, [
          "terminate-process",
          String(parentIdentity.pid),
          parentIdentity.token,
        ]);
      }
      await removeTestRoot(root);
    }
  }, 30_000);

  test("preserves the transaction when a live replacement identity lookup fails", async () => {
    if (process.platform !== "win32") return;
    const codec = windowsCodec();
    const root = mkdtempSync(join(tmpdir(), "mirin-windows-replacement-token-failure-"));
    const app = join(root, "Mirin");
    const staged = join(root, ".Mirin.mirin-new-test");
    const backup = join(root, "Mirin.mirin-old-test");
    const state = join(root, "state");
    const work = join(root, "work");
    const marker = join(state, ".update-handoff.json");
    const phase = join(state, ".update-phase-test");
    const ready = join(state, ".update-ready-test");
    const replacementReceipt = join(state, ".replacement-test-identity");
    const replacementGuard = join(
      state,
      ".update-replacement-42-00000000-0000-0000-0000-000000000000",
    );
    const activated = join(work, ".apply-helper-activated");
    const armed = join(work, ".apply-helper-armed");
    const script = join(root, "apply.ps1");
    const launchVbs = join(root, "launch.vbs");
    const helperPidFile = join(work, ".apply-helper.pid");
    const helperLaunchPidFile = join(work, ".apply-helper-launch.pid");
    const powershell = join(
      process.env.SystemRoot as string,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const executable = powershell;
    mkdirSync(app);
    mkdirSync(staged);
    mkdirSync(state);
    mkdirSync(work);
    writeFileSync(join(app, "old-sentinel"), "old");
    writeFileSync(join(staged, "new-sentinel"), "new");
    copyFileSync(codec, join(app, "Mirin.exe"));
    copyFileSync(powershell, join(staged, "Mirin.exe"));
    writeFileSync(marker, "{}");
    runTestCodec(codec, ["durable-write", phase, "prepared"]);

    const replacementCommand = [
      "if ([string]::IsNullOrWhiteSpace($env:MIRIN_UPDATE_HANDOFF_TOKEN)) { exit 0 }",
      `$tool=${powerShellLiteral(codec)}`,
      "$token=(& $tool process-token ([string]$PID)).Trim()",
      "$identity=[string]$PID+'|'+$token",
      `& $tool durable-write ${powerShellLiteral(replacementReceipt)} $identity`,
      "Start-Sleep -Seconds 30",
    ].join(";");
    const encodedCommand = Buffer.from(replacementCommand, "utf16le").toString("base64");
    const parent = Bun.spawn(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const parentIdentity = await waitForTestIdentity(parent.pid, codec);
    writeFileSync(
      script,
      renderWindowsApplyPowerShell({
        runningApp: app,
        staged,
        workDir: work,
        executable,
        backup,
        helperFiles: [script, launchVbs],
        marker,
        ready,
        activated,
        armed,
        phase,
        swapTool: codec,
        token: "42-00000000-0000-0000-0000-000000000000",
        pid: parent.pid,
        parentToken: parentIdentity.token,
        parentWaitMs: 5_000,
        launchArguments: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
        failurePoint: "replacement-token",
      }),
    );
    writeFileSync(launchVbs, renderWindowsLaunchVbs(script, helperLaunchPidFile));

    let helperIdentity: UpdateProcessIdentity | undefined;
    let replacementIdentity: UpdateProcessIdentity | undefined;
    try {
      const launcher = Bun.spawn(["wscript.exe", "//B", "//Nologo", launchVbs]);
      expect(await launcher.exited).toBe(0);
      const helperPid = Number(readFileSync(helperLaunchPidFile, "utf8"));
      await waitForFile(helperPidFile);
      helperIdentity = parseProcessIdentity(readFileSync(helperPidFile, "utf8"));
      expect(helperIdentity.pid).toBe(helperPid);
      runTestCodec(codec, ["durable-write", activated, formatProcessIdentity(helperIdentity)]);
      await waitForFile(armed);
      runTestCodec(codec, ["terminate-process", String(parentIdentity.pid), parentIdentity.token]);
      await waitForFile(replacementReceipt);
      replacementIdentity = parseProcessIdentity(readFileSync(replacementReceipt, "utf8"));
      await waitForFile(replacementGuard);
      expect(processIdentity(replacementIdentity.pid, codec)?.token).toBe(
        replacementIdentity.token,
      );
      expect(processIdentity(helperIdentity.pid, codec)?.token).toBe(helperIdentity.token);
      expect(readFileSync(replacementGuard, "utf8")).toBe(`pending:${replacementIdentity.pid}`);
      expect(existsSync(join(app, "new-sentinel"))).toBe(true);
      expect(existsSync(join(app, "old-sentinel"))).toBe(false);
      expect(existsSync(join(backup, "old-sentinel"))).toBe(true);
      expect(existsSync(staged)).toBe(false);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(phase, "utf8")).toBe("launching");
      expect(existsSync(work)).toBe(true);

      runTestCodec(codec, [
        "terminate-process",
        String(replacementIdentity.pid),
        replacementIdentity.token,
      ]);
      expect(await waitForProcessExit(replacementIdentity, codec)).toBe(true);
      expect(await waitForProcessExit(helperIdentity, codec)).toBe(true);
      expect(existsSync(join(app, "old-sentinel"))).toBe(true);
      expect(existsSync(join(app, "new-sentinel"))).toBe(false);
      expect(existsSync(staged)).toBe(false);
      expect(existsSync(backup)).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(phase)).toBe(false);
      expect(existsSync(replacementGuard)).toBe(false);
    } finally {
      if (!replacementIdentity && existsSync(replacementReceipt)) {
        try {
          replacementIdentity = parseProcessIdentity(readFileSync(replacementReceipt, "utf8"));
        } catch {}
      }
      if (!replacementIdentity && existsSync(replacementGuard)) {
        const guardedPid = /^pending:(\d+)$/.exec(readFileSync(replacementGuard, "utf8"))?.[1];
        if (guardedPid) replacementIdentity = processIdentity(Number(guardedPid), codec);
      }
      if (
        replacementIdentity &&
        processIdentity(replacementIdentity.pid, codec)?.token === replacementIdentity.token
      ) {
        runTestCodec(codec, [
          "terminate-process",
          String(replacementIdentity.pid),
          replacementIdentity.token,
        ]);
      }
      if (helperIdentity && !(await waitForProcessExit(helperIdentity, codec))) {
        runTestCodec(codec, [
          "terminate-process",
          String(helperIdentity.pid),
          helperIdentity.token,
        ]);
        await waitForProcessExit(helperIdentity, codec);
      }
      const currentParent = processIdentity(parent.pid, codec);
      if (currentParent?.token === parentIdentity.token) {
        runTestCodec(codec, [
          "terminate-process",
          String(parentIdentity.pid),
          parentIdentity.token,
        ]);
      }
      await removeTestRoot(root);
    }
  }, 30_000);

  test("commits only after a real replacement publishes its exact readiness identity", async () => {
    if (process.platform !== "win32") return;
    const codec = windowsCodec();
    const root = mkdtempSync(join(tmpdir(), "mirin-windows-apply-success-"));
    const app = join(root, "Mirin");
    const staged = join(root, ".Mirin.mirin-new-test");
    const backup = join(root, "Mirin.mirin-old-test");
    const state = join(root, "state");
    const work = join(root, "work");
    const marker = join(state, ".update-handoff.json");
    const phase = join(state, ".update-phase-test");
    const ready = join(state, ".update-ready-test");
    const replacementReceipt = join(state, ".replacement-identity");
    const activated = join(work, ".apply-helper-activated");
    const armed = join(work, ".apply-helper-armed");
    const script = join(root, "apply.ps1");
    const launchVbs = join(root, "launch.vbs");
    const helperPidFile = join(work, ".apply-helper.pid");
    const helperLaunchPidFile = join(work, ".apply-helper-launch.pid");
    const powershell = join(
      process.env.SystemRoot as string,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    // Relocating powershell.exe without its adjacent runtime files exits before
    // executing EncodedCommand. Launch the system binary while the sentinels
    // still verify that the app payload itself was atomically replaced.
    const executable = powershell;
    mkdirSync(app);
    mkdirSync(staged);
    mkdirSync(state);
    mkdirSync(work);
    writeFileSync(join(app, "old-sentinel"), "old");
    writeFileSync(join(staged, "new-sentinel"), "new");
    copyFileSync(codec, join(app, "Mirin.exe"));
    copyFileSync(powershell, join(staged, "Mirin.exe"));
    writeFileSync(marker, "{}");
    runTestCodec(codec, ["durable-write", phase, "prepared"]);

    const replacementCommand = [
      `$tool=${powerShellLiteral(codec)}`,
      "$token=(& $tool process-token ([string]$PID)).Trim()",
      "$identity=[string]$PID+'|'+$token",
      `& $tool durable-write ${powerShellLiteral(ready)} $identity`,
      `& $tool durable-write ${powerShellLiteral(replacementReceipt)} $identity`,
      "Start-Sleep -Seconds 30",
    ].join(";");
    const encodedCommand = Buffer.from(replacementCommand, "utf16le").toString("base64");
    const parent = Bun.spawn(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const parentIdentity = await waitForTestIdentity(parent.pid, codec);
    writeFileSync(
      script,
      renderWindowsApplyPowerShell({
        runningApp: app,
        staged,
        workDir: work,
        executable,
        backup,
        helperFiles: [script, launchVbs],
        marker,
        ready,
        activated,
        armed,
        phase,
        swapTool: codec,
        token: "42-00000000-0000-0000-0000-000000000000",
        pid: parent.pid,
        parentToken: parentIdentity.token,
        parentWaitMs: 5_000,
        readyWaitMs: 5_000,
        launchArguments: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
      }),
    );
    writeFileSync(launchVbs, renderWindowsLaunchVbs(script, helperLaunchPidFile));

    let replacementIdentity: UpdateProcessIdentity | undefined;
    try {
      const launcher = Bun.spawn(["wscript.exe", "//B", "//Nologo", launchVbs]);
      expect(await launcher.exited).toBe(0);
      const helperPid = Number(readFileSync(helperLaunchPidFile, "utf8"));
      await waitForFile(helperPidFile);
      const helperIdentity = parseProcessIdentity(readFileSync(helperPidFile, "utf8"));
      expect(helperIdentity.pid).toBe(helperPid);
      expect(processIdentity(helperPid, codec)?.token).toBe(helperIdentity.token);
      runTestCodec(codec, ["durable-write", activated, formatProcessIdentity(helperIdentity)]);
      await waitForFile(armed);
      runTestCodec(codec, ["terminate-process", String(parentIdentity.pid), parentIdentity.token]);
      expect(await waitForProcessExit(helperIdentity, codec)).toBe(true);
      replacementIdentity = parseProcessIdentity(readFileSync(replacementReceipt, "utf8"));
      expect(processIdentity(replacementIdentity.pid, codec)?.token).toBe(
        replacementIdentity.token,
      );
      expect(existsSync(join(app, "new-sentinel"))).toBe(true);
      expect(existsSync(join(app, "old-sentinel"))).toBe(false);
      expect(existsSync(staged)).toBe(false);
      expect(existsSync(backup)).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(phase)).toBe(false);
    } finally {
      if (
        replacementIdentity &&
        processIdentity(replacementIdentity.pid, codec)?.token === replacementIdentity.token
      ) {
        runTestCodec(codec, [
          "terminate-process",
          String(replacementIdentity.pid),
          replacementIdentity.token,
        ]);
      }
      const currentParent = processIdentity(parent.pid, codec);
      if (currentParent?.token === parentIdentity.token) {
        runTestCodec(codec, [
          "terminate-process",
          String(parentIdentity.pid),
          parentIdentity.token,
        ]);
      }
      await removeTestRoot(root);
    }
  }, 30_000);
});

describe("POSIX updater helpers", () => {
  test("preserves ownership when activation becomes visible before durability fails", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "mirin-helper-activation-failure-"));
    const runningApp = join(root, "Mirin.app");
    const staged = join(root, ".Mirin.app.mirin-new");
    const state = join(root, "state");
    const workDir = join(root, "work");
    const swapTool = join(workDir, ".mirin-atomic-swap");
    const helperIdentityPath = join(workDir, ".apply-helper.pid");
    const activated = join(workDir, ".apply-helper-activated");
    const observed = join(workDir, ".activation-observed");
    let helperIdentity: UpdateProcessIdentity | undefined;
    try {
      mkdirSync(runningApp);
      mkdirSync(staged);
      mkdirSync(state);
      mkdirSync(workDir);
      writeFileSync(join(runningApp, "old-sentinel"), "old");
      writeFileSync(join(staged, "new-sentinel"), "new");
      writeTestSwapTool(swapTool, {
        visibleWriteFailurePath: activated,
        denyTermination: true,
      });
      const handoff = prepareUpdateHandoff(
        "dev.example.activation-failure",
        "2.0.0",
        state,
        Date.now(),
        {
          sourceVersion: "1.0.0",
          runningApp,
          staged,
        },
        { pid: process.pid, token: "activation-failure-owner" },
      );
      const helperScript = [
        "set -eu",
        `SWAP=${posixLiteral(swapTool)}`,
        `IDENTITY=${posixLiteral(helperIdentityPath)}`,
        `ACTIVATED=${posixLiteral(activated)}`,
        `OBSERVED=${posixLiteral(observed)}`,
        'SELF_TOKEN=$("$SWAP" process-token "$$")',
        '"$SWAP" durable-write "$IDENTITY" "$$|$SELF_TOKEN"',
        'while [ ! -f "$ACTIVATED" ]; do sleep 0.01; done',
        'printf observed > "$OBSERVED"',
        "sleep 30",
      ].join("\n");

      await expect(spawnShellSwap(helperScript, workDir, handoff)).rejects.toThrow(
        "updater helper ownership could not be released safely",
      );
      await waitForFile(observed);
      helperIdentity = parseProcessIdentity(readFileSync(helperIdentityPath, "utf8"));
      expect(processIdentity(helperIdentity.pid, swapTool)?.token).toBe(helperIdentity.token);
      expect(existsSync(handoff.markerPath)).toBe(true);
      expect(existsSync(handoff.phasePath as string)).toBe(true);
      expect(existsSync(staged)).toBe(true);
      expect(existsSync(workDir)).toBe(true);
    } finally {
      if (!helperIdentity && existsSync(helperIdentityPath)) {
        try {
          helperIdentity = parseProcessIdentity(readFileSync(helperIdentityPath, "utf8"));
        } catch {}
      }
      if (
        helperIdentity &&
        processIdentity(helperIdentity.pid, swapTool)?.token === helperIdentity.token
      ) {
        process.kill(helperIdentity.pid, "SIGKILL");
        await waitForProcessExit(helperIdentity, swapTool);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("macOS retains the backup through open and restores and reopens on failure", () => {
    const script = renderMacApplyShell({
      runningApp: "/Applications/Mirin App.app",
      staged: "/tmp/generation/extract/Mirin App.app",
      workDir: "/tmp/generation",
      executable: "/Applications/Mirin App.app/Contents/MacOS/Mirin App",
      marker: "/tmp/state/.update-handoff.json",
      ready: "/tmp/state/.update-ready-42-token",
      activated: "/tmp/generation/.apply-helper-activated",
      armed: "/tmp/generation/.apply-helper-armed",
      phase: "/tmp/state/.update-phase-42-token",
      swapTool: "/tmp/generation/.mirin-atomic-swap",
      token: "42-00000000-0000-0000-0000-000000000000",
      pid: 42,
      parentToken: "parent-token",
    });
    const launch = script.indexOf('nohup "$EXE"');
    const actualLaunch = script.indexOf("\nlaunch_new\n");
    const readiness = script.indexOf('[ -f "$READY" ]', launch);
    const deleteBackup = script.indexOf('durable-remove-directory "$OLD"', readiness);
    const restoreBackup = script.indexOf('"$SWAP" atomic-swap "$APP" "$RESTORE"', launch);
    const reopenOld = script.indexOf("relaunch_old", restoreBackup);
    expect(launch).toBeGreaterThan(0);
    expect(actualLaunch).toBeGreaterThan(launch);
    expect(readiness).toBeGreaterThan(launch);
    expect(deleteBackup).toBeGreaterThan(readiness);
    expect(restoreBackup).toBeGreaterThan(launch);
    expect(reopenOld).toBeGreaterThan(restoreBackup);
    expect(script.indexOf('rm -rf "$WORK"', readiness)).toBeGreaterThan(readiness);
    expect(script).toContain('if [ "$READY_PROCESS" = "$READY_IDENTITY" ]');
    expect(script).toContain('terminate-process "$NEW_PID" "$NEW_TOKEN"');
    expect(script).toContain('if [ -z "$NEW_TOKEN" ]; then wait "$NEW_PID"');
    expect(script).toContain('"$SWAP" atomic-swap "$APP" "$NEW"');
    expect(script).toContain('terminate-process "$PID" "$PARENT_TOKEN"');
    expect(script).toContain('elif [ "$ACCEPTED" -eq 0 ]; then');
    expect(script).not.toContain('mv "$APP" "$OLD"');
    expect(script).not.toContain('mv "$NEW" "$APP"');
    expect(script.indexOf('test "$ACTIVATED_IDENTITY" = "$SELF_IDENTITY"')).toBeLessThan(
      script.indexOf('"$SWAP" durable-write "$ARMED" "$SELF_IDENTITY"'),
    );
    const replacementGuard = script.indexOf(
      '"$SWAP" durable-write "$REPLACEMENT" "pending:$NEW_PID"',
      actualLaunch,
    );
    const prelaunchGuard = script.indexOf('"$SWAP" durable-write "$REPLACEMENT" "pending:launch"');
    const replacementIdentity = script.indexOf(
      '"$SWAP" durable-write "$REPLACEMENT" "$READY_IDENTITY"',
      replacementGuard,
    );
    expect(prelaunchGuard).toBeGreaterThan(0);
    expect(prelaunchGuard).toBeLessThan(actualLaunch);
    expect(replacementGuard).toBeGreaterThan(actualLaunch);
    expect(replacementIdentity).toBeGreaterThan(replacementGuard);
    if (process.platform !== "win32") {
      expect(Bun.spawnSync(["/bin/sh", "-n", "-c", script]).exitCode).toBe(0);
    }
  });

  test("Linux observes immediate launch failure before deleting the backup and generation", () => {
    const script = renderLinuxApplyShell({
      runningApp: "/opt/Mirin App",
      staged: "/tmp/generation/extract/Mirin App",
      workDir: "/tmp/generation",
      executable: "/opt/Mirin App/Mirin App",
      marker: "/tmp/state/.update-handoff.json",
      ready: "/tmp/state/.update-ready-42-token",
      activated: "/tmp/generation/.apply-helper-activated",
      armed: "/tmp/generation/.apply-helper-armed",
      phase: "/tmp/state/.update-phase-42-token",
      swapTool: "/tmp/generation/.mirin-atomic-swap",
      token: "42-00000000-0000-0000-0000-000000000000",
      pid: 42,
      parentToken: "parent-token",
    });
    const launch = script.indexOf("setsid ");
    const actualLaunch = script.indexOf("\nlaunch_new\n");
    const readiness = script.indexOf('[ -f "$READY" ]', launch);
    expect(launch).toBeGreaterThan(0);
    expect(actualLaunch).toBeGreaterThan(launch);
    expect(readiness).toBeGreaterThan(launch);
    expect(script.indexOf('process_matches "$NEW_PID" "$NEW_TOKEN"', launch)).toBeGreaterThan(
      launch,
    );
    expect(script.indexOf('"$SWAP" atomic-swap "$APP" "$RESTORE"', launch)).toBeGreaterThan(launch);
    expect(script.indexOf('durable-remove-directory "$OLD"', readiness)).toBeGreaterThan(readiness);
    expect(script.indexOf('rm -rf "$WORK"', readiness)).toBeGreaterThan(readiness);
    expect(script.indexOf('"$SWAP" durable-write "$ARMED" "$SELF_IDENTITY"')).toBeLessThan(
      script.indexOf('wait-process "$PID" "$PARENT_TOKEN"'),
    );
    expect(script.indexOf('test "$ACTIVATED_IDENTITY" = "$SELF_IDENTITY"')).toBeLessThan(
      script.indexOf('"$SWAP" durable-write "$ARMED" "$SELF_IDENTITY"'),
    );
    expect(script).toContain('"$SWAP" atomic-swap "$APP" "$NEW"');
    expect(script).toContain('"$SWAP" durable-write "$REPLACEMENT" "pending:$NEW_PID"');
    expect(script).toContain('if [ -z "$NEW_TOKEN" ]; then wait "$NEW_PID"');
    const prelaunchGuard = script.indexOf('"$SWAP" durable-write "$REPLACEMENT" "pending:launch"');
    expect(prelaunchGuard).toBeGreaterThan(0);
    expect(prelaunchGuard).toBeLessThan(actualLaunch);
    if (process.platform !== "win32") {
      expect(Bun.spawnSync(["/bin/sh", "-n", "-c", script]).exitCode).toBe(0);
    }
  });

  test("does not swap after parent exit without an activation acknowledgement", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "mirin-helper-unactivated-"));
    const runningApp = join(root, "Mirin.app");
    const staged = join(root, ".Mirin.app.mirin-new");
    const workDir = join(root, "work");
    const marker = join(root, ".update-handoff.json");
    const swapTool = join(workDir, ".mirin-atomic-swap");
    try {
      mkdirSync(runningApp);
      mkdirSync(staged);
      mkdirSync(workDir);
      writeFileSync(join(runningApp, "old-sentinel"), "old");
      writeFileSync(join(staged, "new-sentinel"), "new");
      writeFileSync(marker, "{}");
      writeTestSwapTool(swapTool);

      const helper = Bun.spawn([
        "/bin/sh",
        "-c",
        renderMacApplyShell({
          runningApp,
          staged,
          workDir,
          executable: join(runningApp, "Mirin"),
          marker,
          ready: join(root, ".update-ready"),
          activated: join(workDir, ".apply-helper-activated"),
          armed: join(workDir, ".apply-helper-armed"),
          phase: join(root, ".update-phase"),
          swapTool,
          token: "42-00000000-0000-0000-0000-000000000000",
          pid: 2_147_483_647,
          parentToken: "token-2147483647",
        }),
      ]);

      expect(await helper.exited).not.toBe(0);
      expect(existsSync(join(runningApp, "old-sentinel"))).toBe(true);
      expect(existsSync(join(runningApp, "new-sentinel"))).toBe(false);
      expect(existsSync(`${runningApp}.mirin-old-2147483647`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an accepted helper restores the old app after replacement startup fails", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "mirin-helper-rollback-"));
    const runningApp = join(root, "Mirin.app");
    const staged = join(root, ".Mirin.app.mirin-new-42-token");
    const workDir = join(root, "work");
    const marker = join(root, ".update-handoff.json");
    const ready = join(root, ".update-ready-42-token");
    const activated = join(workDir, ".apply-helper-activated");
    const armed = join(workDir, ".apply-helper-armed");
    const phase = join(root, ".update-phase-42-token");
    const swapTool = join(workDir, ".mirin-atomic-swap");
    const executable = join(runningApp, "Contents", "MacOS", "Mirin");
    const stagedExecutable = join(staged, "Contents", "MacOS", "Mirin");
    try {
      mkdirSync(join(runningApp, "Contents", "MacOS"), { recursive: true });
      mkdirSync(join(staged, "Contents", "MacOS"), { recursive: true });
      mkdirSync(workDir);
      writeFileSync(executable, "#!/bin/sh\nexit 0\n");
      writeFileSync(stagedExecutable, "#!/bin/sh\nexit 1\n");
      writeFileSync(join(runningApp, "old-sentinel"), "old");
      writeFileSync(join(staged, "new-sentinel"), "new");
      writeFileSync(marker, "{}");
      writeFileSync(phase, "prepared");
      chmodSync(executable, 0o755);
      chmodSync(stagedExecutable, 0o755);
      writeTestSwapTool(swapTool);

      const parent = Bun.spawn(["/bin/sh", "-c", "sleep 30"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const script = renderMacApplyShell({
        runningApp,
        staged,
        workDir,
        executable,
        marker,
        ready,
        activated,
        armed,
        phase,
        swapTool,
        token: "42-00000000-0000-0000-0000-000000000000",
        pid: parent.pid,
        parentToken: `token-${parent.pid}`,
      });
      const helper = Bun.spawn(["/bin/sh", "-c", script], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      writeFileSync(activated, `${helper.pid}|token-${helper.pid}`);
      parent.kill();
      await parent.exited;
      expect(await helper.exited).not.toBe(0);
      expect(existsSync(join(runningApp, "old-sentinel"))).toBe(true);
      expect(existsSync(join(runningApp, "new-sentinel"))).toBe(false);
      expect(existsSync(`${runningApp}.mirin-old-${parent.pid}`)).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(staged)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects AppImage and non-writable package installs before handoff", () => {
    expect(() =>
      assertLinuxInstallCanApply("/mount/usr/lib/app/resources", "/tmp/App.AppImage"),
    ).toThrow("AppImage");
    expect(() =>
      assertLinuxInstallCanApply("/opt/app/resources", undefined, () => {
        throw new Error("read-only");
      }),
    ).toThrow("system package manager");
    expect(() =>
      assertLinuxInstallCanApply(
        "/home/user/app/resources",
        undefined,
        () => "/home/user/.mirin-update-probe-test",
        () => {},
      ),
    ).not.toThrow();
  });
});

function writeTestSwapTool(
  path: string,
  options: {
    visibleWriteFailurePath?: string;
    denyTermination?: boolean;
  } = {},
): void {
  const visibleWriteFailurePath = options.visibleWriteFailurePath
    ? posixLiteral(options.visibleWriteFailurePath)
    : undefined;
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      "set -eu",
      'operation="$1"; shift',
      'case "$operation" in',
      "  process-token)",
      '    kill -0 "$1" 2>/dev/null',
      '    printf "token-%s\\n" "$1"',
      "    ;;",
      "  wait-process)",
      '    pid="$1"; token="$2"; i=0',
      '    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 500 ]; do i=$((i + 1)); sleep 0.01; done',
      '    ! kill -0 "$pid" 2>/dev/null',
      "    ;;",
      "  terminate-process)",
      ...(options.denyTermination ? ["    exit 1"] : []),
      '    pid="$1"; token="$2"',
      '    if [ "$token" = "token-$pid" ] && kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi',
      "    ;;",
      "  durable-write)",
      '    temporary="$1.tmp.$$"; printf "%s" "$2" > "$temporary"; mv "$temporary" "$1"',
      ...(visibleWriteFailurePath
        ? [`    if [ "$1" = ${visibleWriteFailurePath} ]; then exit 1; fi`]
        : []),
      "    ;;",
      "  durable-move)",
      '    mv "$1" "$2"',
      "    ;;",
      "  durable-remove-directory)",
      '    rm -rf "$1"',
      "    ;;",
      "  durable-remove-file)",
      '    rm -f "$1"',
      "    ;;",
      "  atomic-swap)",
      '    temporary="$1.mirin-test-swap"',
      '    mv "$1" "$temporary"',
      '    mv "$2" "$1"',
      '    mv "$temporary" "$2"',
      "    ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

function posixLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function windowsCodec(): string {
  const build = Bun.spawnSync(["cargo", "build", "-p", "mirin-codec"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) throw new Error("could not build Windows updater codec test helper");
  return join(process.cwd(), "target", "debug", "mirin-codec.exe");
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runTestCodec(codec: string, args: string[]): void {
  const result = Bun.spawnSync([codec, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`test codec failed: ${args[0]}`);
}

async function waitForTestIdentity(pid: number, codec: string): Promise<UpdateProcessIdentity> {
  for (let index = 0; index < 200; index += 1) {
    const identity = processIdentity(pid, codec);
    if (identity) return identity;
    await Bun.sleep(25);
  }
  throw new Error("test process identity was unavailable");
}

async function waitForFile(path: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForProcessExit(
  identity: UpdateProcessIdentity,
  codec: string,
): Promise<boolean> {
  for (let index = 0; index < 400; index += 1) {
    if (processIdentity(identity.pid, codec)?.token !== identity.token) return true;
    await Bun.sleep(25);
  }
  return false;
}

async function removeTestRoot(path: string): Promise<void> {
  let failure: unknown;
  for (let index = 0; index < 200; index += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      failure = error;
      await Bun.sleep(25);
    }
  }
  throw failure;
}
