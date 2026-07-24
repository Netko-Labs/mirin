import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const handoff = prepareUpdateHandoff("dev.example.app", "2.0.0", state);
    activateUpdateHandoff(handoff, 456);

    expect(inspectUpdateHandoff("dev.example.app", oldResources, false, () => true, state)).toEqual(
      { blocked: true },
    );
    expect(inspectUpdateHandoff("dev.example.app", newResources, false, () => true, state)).toEqual(
      { blocked: false, readyPath: handoff.readyPath },
    );

    signalUpdateReady(handoff.readyPath);
    expect(existsSync(handoff.readyPath)).toBe(true);
    abandonUpdateHandoff(handoff);
    expect(existsSync(handoff.markerPath)).toBe(false);
    expect(existsSync(handoff.readyPath)).toBe(false);
  });

  test("removes a reservation after both owning processes are gone", () => {
    const root = temporaryDirectory();
    const state = join(root, "state");
    const oldResources = resources(root, "old", "1.0.0");
    const handoff = prepareUpdateHandoff("dev.example.app", "2.0.0", state);
    activateUpdateHandoff(handoff, 456);

    expect(
      inspectUpdateHandoff("dev.example.app", oldResources, false, () => false, state),
    ).toEqual({ blocked: false });
    expect(existsSync(handoff.markerPath)).toBe(false);
  });
});

function resources(root: string, name: string, version: string): string {
  const directory = join(root, name, "resources");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "version.json"), JSON.stringify({ version }));
  return directory;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mirin-update-handoff-"));
  temporaryDirectories.push(directory);
  return directory;
}
