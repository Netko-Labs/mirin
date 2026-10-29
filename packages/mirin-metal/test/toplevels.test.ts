import { describe, expect, test } from "bun:test";
import { parseToplevelEvent, toplevelCommand } from "../src/lib/toplevels.ts";

const window = {
  id: 7,
  title: "Files",
  appId: "dev.dashi.files",
  activated: true,
  minimized: false,
  maximized: false,
  fullscreen: false,
};

describe("toplevel events", () => {
  test("parses changed and closed windows", () => {
    expect(parseToplevelEvent({ type: "toplevel", toplevel: window })).toEqual({
      type: "changed",
      toplevel: window,
    });
    expect(parseToplevelEvent({ type: "toplevel-closed", id: 7 })).toEqual({
      type: "closed",
      id: 7,
    });
  });

  test("rejects malformed windows and ignores other lines", () => {
    expect(parseToplevelEvent({ type: "toplevel", toplevel: { ...window, id: -1 } })).toBeNull();
    expect(parseToplevelEvent({ type: "toplevel", toplevel: { ...window, title: 3 } })).toBeNull();
    expect(
      parseToplevelEvent({ type: "toplevel", toplevel: { ...window, minimized: "no" } }),
    ).toBeNull();
    expect(parseToplevelEvent({ type: "toplevel-closed", id: 1.5 })).toBeNull();
    expect(parseToplevelEvent({ type: "press", nodeId: "3" })).toBeNull();
  });

  test("writes commands", () => {
    expect(JSON.parse(toplevelCommand(7, "unminimize"))).toEqual({
      toplevel: { id: 7, action: "unminimize" },
    });
  });
});
