import { describe, expect, test } from "bun:test";
import { installWorkerConsole } from "../src/shared/console.ts";

const original = { ...console };

function capture(): { lines: Array<[1 | 2, string]>; restore: () => void } {
  const lines: Array<[1 | 2, string]> = [];
  installWorkerConsole((fd, line) => lines.push([fd, line]));
  return {
    lines,
    restore: () => {
      Object.assign(console, original);
    },
  };
}

describe("installWorkerConsole", () => {
  test("routes log/info/debug to fd 1 and warn/error to fd 2, console-formatted", () => {
    const { lines, restore } = capture();
    try {
      console.log("hello %s", "world", { n: 1 });
      console.warn("careful");
      console.error(new Error("boom"));
    } finally {
      restore();
    }
    expect(lines[0]).toEqual([1, "hello world { n: 1 }"]);
    expect(lines[1]).toEqual([2, "careful"]);
    expect(lines[2]?.[0]).toBe(2);
    expect(lines[2]?.[1]).toContain("boom");
  });
});
