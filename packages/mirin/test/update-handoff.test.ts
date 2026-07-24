import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abandonUpdateHandoff,
  activateUpdateHandoff,
  inspectUpdateHandoff,
  installSiblingPrefix,
  prepareUpdateHandoff,
  signalUpdateReady,
} from "../src/update-handoff.ts";

const temporaryDirectories: string[] = [];
const owner = { pid: process.pid, token: "owner-token" };
const helper = { pid: 456, token: "helper-token" };

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("update handoff reservations", () => {
  test("blocks the old version and admits only the staged target while the helper lives", () => {
    const root = temporaryDirectory();
    const state = join(root, "state");
    const oldResources = resources(root, "old", "1.0.0");
    const newResources = resources(root, "new", "2.0.0");
    const handoff = prepareUpdateHandoff(
      "dev.example.app",
      "2.0.0",
      state,
      Date.now(),
      undefined,
      owner,
    );
    activateUpdateHandoff(handoff, helper);
    const identity = (pid: number) =>
      pid === owner.pid ? owner : pid === helper.pid ? helper : undefined;

    expect(
      inspectUpdateHandoff("dev.example.app", oldResources, false, handoff.token, identity, state),
    ).toEqual({ blocked: true });
    expect(
      inspectUpdateHandoff("dev.example.app", newResources, false, "wrong-token", identity, state),
    ).toEqual({ blocked: true });
    expect(
      inspectUpdateHandoff("dev.example.app", newResources, false, handoff.token, identity, state),
    ).toEqual({ blocked: false, readyPath: handoff.readyPath });

    signalUpdateReady(handoff.readyPath, owner);
    expect(existsSync(handoff.readyPath)).toBe(true);
    expect(readFileSync(handoff.readyPath, "utf8")).toBe(`${process.pid}|owner-token`);
    expect(readFileSync(handoff.replacementPath, "utf8")).toBe(`${process.pid}|owner-token`);
    expect(readdirSync(state).some((entry) => entry.endsWith(".tmp"))).toBe(false);
    abandonUpdateHandoff(handoff);
    expect(existsSync(handoff.markerPath)).toBe(false);
    expect(existsSync(handoff.readyPath)).toBe(false);
  });

  test("does not delete an existing reservation when a second prepare is rejected", () => {
    const root = temporaryDirectory();
    const state = join(root, "state");
    const handoff = prepareUpdateHandoff(
      "dev.example.app",
      "2.0.0",
      state,
      Date.now(),
      undefined,
      owner,
    );

    expect(() =>
      prepareUpdateHandoff("dev.example.app", "3.0.0", state, Date.now(), undefined, owner),
    ).toThrow();
    expect(JSON.parse(readFileSync(handoff.markerPath, "utf8")).token).toBe(handoff.token);
    abandonUpdateHandoff(handoff);
  });

  test("removes a reservation after both owning processes are gone", () => {
    const root = temporaryDirectory();
    const state = join(root, "state");
    const oldResources = resources(root, "old", "1.0.0");
    const handoff = prepareUpdateHandoff(
      "dev.example.app",
      "2.0.0",
      state,
      Date.now(),
      undefined,
      owner,
    );
    activateUpdateHandoff(handoff, helper);

    expect(
      inspectUpdateHandoff(
        "dev.example.app",
        oldResources,
        false,
        undefined,
        (pid) => (pid === process.pid ? { pid, token: "stale-cleanup-owner" } : undefined),
        state,
      ),
    ).toEqual({ blocked: false });
    expect(existsSync(handoff.markerPath)).toBe(false);
  });

  test("rejects reused numeric process ids with different creation identities", () => {
    const root = temporaryDirectory();
    const state = join(root, "state");
    const oldResources = resources(root, "old", "1.0.0");
    const handoff = prepareUpdateHandoff(
      "dev.example.app",
      "2.0.0",
      state,
      Date.now(),
      undefined,
      owner,
    );
    activateUpdateHandoff(handoff, helper);

    expect(
      inspectUpdateHandoff(
        "dev.example.app",
        oldResources,
        false,
        undefined,
        (pid) =>
          pid === process.pid
            ? { pid, token: "stale-cleanup-owner" }
            : { pid, token: "reused-process-token" },
        state,
      ),
    ).toEqual({ blocked: false });
    expect(existsSync(handoff.markerPath)).toBe(false);
  });

  test("claims an interrupted post-backup transaction for exact startup rollback", () => {
    const fixture = interruptedTransaction("backed-up");
    const recoveryOwner = { pid: process.pid, token: "recovery-process-token" };

    const decision = inspectUpdateHandoff(
      "dev.example.app",
      fixture.resources,
      false,
      undefined,
      () => recoveryOwner,
      fixture.state,
    );

    expect(decision.blocked).toBe(false);
    expect(decision.recovery?.claimPaths).toHaveLength(1);
    const claimPaths = decision.recovery?.claimPaths as string[];
    expect(existsSync(claimPaths[0] as string)).toBe(true);
    expect(decision.recovery).toEqual({
      mode: "rollback",
      token: fixture.handoff.token,
      markerPath: fixture.handoff.markerPath,
      phasePath: fixture.handoff.phasePath,
      readyPath: fixture.handoff.readyPath,
      replacementPath: fixture.handoff.replacementPath,
      runningApp: fixture.app,
      staged: fixture.staged,
      backup: fixture.handoff.backup,
      restorePath: fixture.handoff.backup,
      owner: recoveryOwner,
      claimPaths,
    });
    expect(
      inspectUpdateHandoff(
        "dev.example.app",
        fixture.resources,
        false,
        undefined,
        () => recoveryOwner,
        fixture.state,
      ),
    ).toEqual({ blocked: true });
  });

  test("blocks on a live exact-identity recovery claim and restores it only after owner death", () => {
    const fixture = interruptedTransaction("backed-up");
    const claimOwner = { pid: 424242, token: "live-recovery-claim" };
    const recoveryOwner = { pid: process.pid, token: "next-recovery-owner" };
    const ownerHash = createHash("sha256").update(claimOwner.token).digest("hex");
    const claimPath = join(
      fixture.state,
      `.update-recovery-claim-${fixture.handoff.token}--${claimOwner.pid}-${ownerHash}`,
    );
    renameSync(fixture.handoff.markerPath, claimPath);

    expect(
      inspectUpdateHandoff(
        "dev.example.app",
        fixture.resources,
        false,
        undefined,
        (pid) => (pid === claimOwner.pid ? claimOwner : recoveryOwner),
        fixture.state,
      ),
    ).toEqual({ blocked: true });
    expect(existsSync(claimPath)).toBe(true);
    expect(existsSync(fixture.handoff.markerPath)).toBe(false);

    const decision = inspectUpdateHandoff(
      "dev.example.app",
      fixture.resources,
      false,
      undefined,
      (pid) => (pid === process.pid ? recoveryOwner : undefined),
      fixture.state,
    );
    expect(decision.blocked).toBe(false);
    expect(decision.recovery?.owner).toEqual(recoveryOwner);
    expect(existsSync(fixture.handoff.markerPath)).toBe(true);
  });

  test("restores an intact recovery claim instead of failing open on a torn marker", () => {
    const fixture = interruptedTransaction("backed-up");
    const claimOwner = { pid: 424242, token: "torn-marker-claim-owner" };
    const recoveryOwner = { pid: process.pid, token: "torn-marker-recovery-owner" };
    const ownerHash = createHash("sha256").update(claimOwner.token).digest("hex");
    const staleClaimPath = join(
      fixture.state,
      `.update-recovery-claim-${fixture.handoff.token}--${claimOwner.pid}-${ownerHash}`,
    );
    renameSync(fixture.handoff.markerPath, staleClaimPath);
    writeFileSync(fixture.handoff.markerPath, '{"token":');

    const decision = inspectUpdateHandoff(
      "dev.example.app",
      fixture.resources,
      false,
      undefined,
      () => recoveryOwner,
      fixture.state,
    );

    expect(decision.blocked).toBe(false);
    expect(decision.recovery?.owner).toEqual(recoveryOwner);
    expect(decision.recovery?.claimPaths).toHaveLength(1);
    expect(existsSync(staleClaimPath)).toBe(false);
    expect(JSON.parse(readFileSync(fixture.handoff.markerPath, "utf8")).ownerToken).toBe(
      recoveryOwner.token,
    );
  });

  test("blocks recovery while an exact replacement is live and carries its receipt afterward", () => {
    const fixture = interruptedTransaction("launching");
    const replacement = { pid: 789, token: "live-replacement-token" };
    const recoveryOwner = { pid: process.pid, token: "replacement-recovery-owner" };
    writeFileSync(fixture.handoff.replacementPath, `${replacement.pid}|${replacement.token}`);

    expect(
      inspectUpdateHandoff(
        "dev.example.app",
        fixture.resources,
        false,
        undefined,
        (pid) => (pid === replacement.pid ? replacement : recoveryOwner),
        fixture.state,
      ),
    ).toEqual({ blocked: true });

    const decision = inspectUpdateHandoff(
      "dev.example.app",
      fixture.resources,
      false,
      undefined,
      (pid) => (pid === process.pid ? recoveryOwner : undefined),
      fixture.state,
    );
    expect(decision.blocked).toBe(false);
    expect(decision.recovery?.replacement).toEqual(replacement);
    expect(decision.recovery?.replacementPath).toBe(fixture.handoff.replacementPath);
  });

  test("fails safe when replacement launch or identity publication is pending", () => {
    for (const guard of ["pending:current-boot:launch", "pending:current-boot:789"]) {
      const fixture = interruptedTransaction("launching");
      const recoveryOwner = { pid: process.pid, token: "pending-replacement-recovery-owner" };
      writeFileSync(fixture.handoff.replacementPath, guard);

      expect(
        inspectUpdateHandoff(
          "dev.example.app",
          fixture.resources,
          false,
          undefined,
          () => recoveryOwner,
          fixture.state,
          Date.now(),
          () => "current-boot",
        ),
      ).toEqual({ blocked: true });
      expect(readFileSync(fixture.handoff.replacementPath, "utf8")).toBe(guard);
      expect(existsSync(fixture.handoff.markerPath)).toBe(true);
    }
  });

  test("recovers a pending replacement guard after the machine boot changes", () => {
    const fixture = interruptedTransaction("launching");
    const recoveryOwner = { pid: process.pid, token: "reboot-recovery-owner" };
    writeFileSync(fixture.handoff.replacementPath, "pending:previous-boot:789");

    const decision = inspectUpdateHandoff(
      "dev.example.app",
      fixture.resources,
      false,
      undefined,
      () => recoveryOwner,
      fixture.state,
      Date.now(),
      () => "current-boot",
    );

    expect(decision.blocked).toBe(false);
    expect(decision.recovery?.mode).toBe("rollback");
    expect(decision.recovery?.replacement).toBeUndefined();
    expect(decision.recovery?.replacementPath).toBe(fixture.handoff.replacementPath);
  });

  test("retains a pending guard when current boot identity cannot be read", () => {
    const fixture = interruptedTransaction("launching");
    const recoveryOwner = { pid: process.pid, token: "unknown-boot-recovery-owner" };
    writeFileSync(fixture.handoff.replacementPath, "pending:guarded-boot:launch");

    expect(
      inspectUpdateHandoff(
        "dev.example.app",
        fixture.resources,
        false,
        undefined,
        () => recoveryOwner,
        fixture.state,
        Date.now(),
        () => undefined,
      ),
    ).toEqual({ blocked: true });
  });

  test("recovers a crash between durable marker and phase creation", () => {
    const root = temporaryDirectory();
    const state = join(root, "state");
    const app = join(root, "Mirin");
    const installedResources = resourcesAt(app, "1.0.0");
    const staged = join(root, ".Mirin.mirin-new-test");
    resourcesAt(staged, "2.0.0");
    const handoff = prepareUpdateHandoff(
      "dev.example.app",
      "2.0.0",
      state,
      Date.now(),
      { sourceVersion: "1.0.0", runningApp: app, staged },
      owner,
    );
    rmSync(handoff.phasePath as string);

    expect(
      inspectUpdateHandoff(
        "dev.example.app",
        installedResources,
        false,
        undefined,
        (pid) => (pid === process.pid ? { pid, token: "phase-cleanup-owner" } : undefined),
        state,
      ),
    ).toEqual({ blocked: false });
    expect(existsSync(handoff.markerPath)).toBe(false);
    expect(existsSync(staged)).toBe(false);
  });

  test("does not delete an untrusted phase path from an invalid marker", () => {
    const root = temporaryDirectory();
    const state = join(root, "state");
    const app = join(root, "Mirin");
    const installedResources = resourcesAt(app, "1.0.0");
    const staged = join(root, ".Mirin.mirin-new-test");
    resourcesAt(staged, "2.0.0");
    const handoff = prepareUpdateHandoff(
      "dev.example.app",
      "2.0.0",
      state,
      Date.now(),
      { sourceVersion: "1.0.0", runningApp: app, staged },
      owner,
    );
    const sentinel = join(root, "sentinel");
    writeFileSync(sentinel, "keep");
    const marker = JSON.parse(readFileSync(handoff.markerPath, "utf8"));
    writeFileSync(handoff.markerPath, JSON.stringify({ ...marker, phasePath: sentinel }));

    expect(
      inspectUpdateHandoff(
        "dev.example.app",
        installedResources,
        false,
        undefined,
        (pid) => (pid === process.pid ? { pid, token: "invalid-marker-cleanup" } : undefined),
        state,
      ),
    ).toEqual({ blocked: false });
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  });

  test("claims a ready transaction for committed backup cleanup", () => {
    const fixture = interruptedTransaction("committed");
    const recoveryOwner = { pid: process.pid, token: "commit-recovery-token" };

    const decision = inspectUpdateHandoff(
      "dev.example.app",
      fixture.resources,
      false,
      undefined,
      () => recoveryOwner,
      fixture.state,
    );

    expect(decision.recovery?.mode).toBe("commit");
    expect(decision.recovery?.restorePath).toBe(fixture.handoff.backup);
  });
});

function interruptedTransaction(phase: "backed-up" | "launching" | "committed") {
  const root = temporaryDirectory();
  const state = join(root, "state");
  const app = join(root, "Mirin");
  const resources = resourcesAt(app, "1.0.0");
  const staged = join(root, `${installSiblingPrefix(app)}test`);
  resourcesAt(staged, "2.0.0");
  const handoff = prepareUpdateHandoff(
    "dev.example.app",
    "2.0.0",
    state,
    Date.now(),
    { sourceVersion: "1.0.0", runningApp: app, staged },
    owner,
  );
  activateUpdateHandoff(handoff, helper);
  const temporary = join(root, ".swap-temporary");
  renameSync(app, temporary);
  renameSync(staged, app);
  renameSync(temporary, handoff.backup as string);
  writeFileSync(handoff.phasePath as string, phase);
  return { app, resources, staged, state, handoff };
}

function resources(root: string, name: string, version: string): string {
  return resourcesAt(join(root, name), version);
}

function resourcesAt(app: string, version: string): string {
  const directory =
    process.platform === "darwin" ? join(app, "Contents", "Resources") : join(app, "resources");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "version.json"), JSON.stringify({ version }));
  return directory;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mirin-update-handoff-"));
  temporaryDirectories.push(directory);
  return directory;
}
