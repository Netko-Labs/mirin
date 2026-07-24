import { afterEach, describe, expect, test } from "bun:test";
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
      inspectUpdateHandoff("dev.example.app", oldResources, false, undefined, () => false, state),
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
        (pid) => ({ pid, token: "reused-process-token" }),
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
    expect(decision.recovery).toEqual({
      mode: "rollback",
      token: fixture.handoff.token,
      markerPath: fixture.handoff.markerPath,
      phasePath: fixture.handoff.phasePath,
      readyPath: fixture.handoff.readyPath,
      runningApp: fixture.app,
      staged: fixture.staged,
      backup: fixture.handoff.backup,
      restorePath: fixture.handoff.backup,
      owner: recoveryOwner,
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

function interruptedTransaction(phase: "backed-up" | "committed") {
  const root = temporaryDirectory();
  const state = join(root, "state");
  const app = join(root, "Mirin");
  const resources = resourcesAt(app, "1.0.0");
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
