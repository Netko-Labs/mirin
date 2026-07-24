import { describe, expect, test } from "bun:test";
import {
  acknowledgeUpdaterStartup,
  enterTerminalUpdateHandoff,
} from "../src/updater/lib/lifecycle.ts";

describe("updater lifecycle ordering", () => {
  test("writes replacement readiness before user-ready work and defers only cleanup", () => {
    const events: string[] = [];
    let deferred: (() => void) | undefined;

    acknowledgeUpdaterStartup({
      signalReady: () => events.push("ready-receipt"),
      initialize: () => events.push("startup-cleanup"),
      defer: (task) => {
        deferred = task;
      },
    });
    events.push("user-ready-listener");

    expect(events).toEqual(["ready-receipt", "user-ready-listener"]);
    deferred?.();
    expect(events).toEqual(["ready-receipt", "user-ready-listener", "startup-cleanup"]);
  });

  test("requests terminal native quit before notifying completion listeners", () => {
    let quitRequested = false;

    enterTerminalUpdateHandoff(
      () => {
        quitRequested = true;
      },
      () => {
        expect(quitRequested).toBe(true);
      },
    );
  });
});
