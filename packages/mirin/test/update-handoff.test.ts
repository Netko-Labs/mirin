import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abandonUpdateHandoff,
  activateUpdateHandoff,
  inspectUpdateHandoff,
  MAX_UPDATE_HANDOFF_AGE_MS,
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

    expect(
      inspectUpdateHandoff(
        "dev.example.app",
        oldResources,
        false,
        handoff.token,
        () => true,
        state,
      ),
    ).toEqual({ blocked: true });
    expect(
      inspectUpdateHandoff(
        "dev.example.app",
        newResources,
        false,
        "wrong-token",
        () => true,
        state,
      ),
    ).toEqual({ blocked: true });
    expect(
      inspectUpdateHandoff(
        "dev.example.app",
        newResources,
        false,
        handoff.token,
        () => true,
        state,
      ),
    ).toEqual({ blocked: false, readyPath: handoff.readyPath });

    signalUpdateReady(handoff.readyPath);
    expect(existsSync(handoff.readyPath)).toBe(true);
    expect(readFileSync(handoff.readyPath, "utf8")).toBe(String(process.pid));
    expect(readdirSync(state).some((entry) => entry.endsWith(".tmp"))).toBe(false);
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
      inspectUpdateHandoff("dev.example.app", oldResources, false, undefined, () => false, state),
    ).toEqual({ blocked: false });
    expect(existsSync(handoff.markerPath)).toBe(false);
  });

  test("expires a reservation even when its numeric process ids have been reused", () => {
    const root = temporaryDirectory();
    const state = join(root, "state");
    const oldResources = resources(root, "old", "1.0.0");
    const createdAtMs = 1_700_000_000_000;
    const handoff = prepareUpdateHandoff("dev.example.app", "2.0.0", state, createdAtMs);
    activateUpdateHandoff(handoff, 456);

    expect(
      inspectUpdateHandoff(
        "dev.example.app",
        oldResources,
        false,
        undefined,
        () => true,
        state,
        createdAtMs + MAX_UPDATE_HANDOFF_AGE_MS + 1,
      ),
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
