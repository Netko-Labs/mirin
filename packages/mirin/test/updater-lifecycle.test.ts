import { describe, expect, test } from "bun:test";
import {
  acknowledgeUpdaterStartup,
  UpdaterProcessLifecycle,
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
    const lifecycle = new UpdaterProcessLifecycle();
    let quitRequested = false;

    lifecycle.enterTerminal(
      () => {
        quitRequested = true;
      },
      () => {
        expect(quitRequested).toBe(true);
      },
    );
  });

  test("shares apply and terminal state across updater instances", () => {
    const lifecycle = new UpdaterProcessLifecycle();
    const events: string[] = [];
    const release = lifecycle.beginApply();

    expect(() => lifecycle.beginApply()).toThrow("another updater instance");
    release();
    lifecycle.beginApply();
    lifecycle.onTerminal(() => events.push("stop-auto-check"));
    lifecycle.enterTerminal(
      () => events.push("quit"),
      () => events.push("complete"),
    );

    expect(events).toEqual(["stop-auto-check", "quit", "complete"]);
    expect(lifecycle.isTerminal).toBe(true);
    expect(() => lifecycle.assertActive()).toThrow("terminal handoff");
    expect(() => lifecycle.beginApply()).toThrow("terminal handoff");
  });
});
