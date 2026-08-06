import { describe, expect, test } from "bun:test";
import { type CapturablePage, capturePage, parseBackdrop } from "../src/devtools/lib/capture.ts";

const PIXEL = Buffer.from("mirin").toString("base64");

interface Call {
  method: string;
  params: Record<string, unknown>;
}

/**
 * A CDP page that records what it was asked to do. `appearance` is what the
 * transparency probe reports back; `failOn` makes one command throw.
 */
function fakePage(options: {
  appearance?: { transparent: boolean; dark?: boolean; color?: string };
  failOn?: string;
}): { page: CapturablePage; calls: Call[] } {
  const calls: Call[] = [];
  const page: CapturablePage = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === options.failOn) throw new Error(`${method} unavailable`);
      if (method === "Runtime.evaluate") {
        const expression = String(params.expression ?? "");
        // The probe reads the page; the backdrop apply/restore scripts return true.
        if (expression.includes("transparent:")) {
          return { result: { value: options.appearance ?? { transparent: false } } };
        }
        return { result: { value: true } };
      }
      if (method === "Page.captureScreenshot") return { data: PIXEL };
      return {};
    },
  };
  return { page, calls };
}

/** Label each call by what it actually does, since three of them are `Runtime.evaluate`. */
function stepsOf(calls: Call[]): string[] {
  return calls.map((call) => {
    if (call.method !== "Runtime.evaluate") return call.method;
    const expression = String(call.params.expression ?? "");
    if (expression.includes("transparent:")) return "probe";
    // Both mutate style; only the apply script sets an `important` priority.
    if (expression.includes('"important"')) return "apply-backdrop";
    return "restore-backdrop";
  });
}

describe("screenshot backdrop parameter", () => {
  test("reads an explicit colour, normalized", () => {
    expect(parseBackdrop("#FFF")).toBe("#fff");
    expect(parseBackdrop("#1c1c1e")).toBe("#1c1c1e");
  });

  test("`none` means capture exactly what the page renders", () => {
    expect(parseBackdrop("none")).toBeNull();
  });

  test("absent or unparseable falls back to automatic rather than failing", () => {
    expect(parseBackdrop(null)).toBeUndefined();
    expect(parseBackdrop("rebeccapurple")).toBeUndefined();
    expect(parseBackdrop("#12345")).toBeUndefined();
    expect(parseBackdrop("'; DROP")).toBeUndefined();
  });
});

describe("screenshot capture", () => {
  // The bug: a transparent window captured to alpha 0 reads as a blank page.
  test("composites a transparent page and reports that it did", async () => {
    const { page, calls } = fakePage({
      appearance: { transparent: true, color: "rgb(17, 17, 17)" },
    });
    const result = await capturePage(page, { format: "png" });

    expect(result.composited).toBe(true);
    expect(result.backdrop).toBe("#ffffff");
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    // Set before the capture, cleared after — the override is page state.
    expect(stepsOf(calls)).toEqual([
      "probe",
      "apply-backdrop",
      "Page.captureScreenshot",
      "restore-backdrop",
    ]);
    // The colour reaches the page as a JSON literal, never as concatenated script.
    expect(String(calls[1]?.params.expression)).toContain('"#ffffff"');
  });

  // The point is legibility: a glass window renders light text whatever the OS
  // colour scheme says, and white-on-white is the blank page all over again.
  test("picks a backdrop that contrasts with the page's text", async () => {
    const light = fakePage({ appearance: { transparent: true, color: "rgb(245, 245, 247)" } });
    expect((await capturePage(light.page, { format: "png" })).backdrop).toBe("#1c1c1e");

    const dark = fakePage({ appearance: { transparent: true, color: "rgb(17, 17, 17)" } });
    expect((await capturePage(dark.page, { format: "png" })).backdrop).toBe("#ffffff");
  });

  test("falls back to the OS colour scheme when the text colour is unreadable", async () => {
    const { page } = fakePage({ appearance: { transparent: true, color: "", dark: true } });
    expect((await capturePage(page, { format: "png" })).backdrop).toBe("#1c1c1e");
  });

  // An ordinary app paints its own background; touching it would be a lie.
  test("leaves an opaque page alone", async () => {
    const { page, calls } = fakePage({ appearance: { transparent: false } });
    const result = await capturePage(page, { format: "png" });

    expect(result.composited).toBe(false);
    expect(result.backdrop).toBeUndefined();
    expect(stepsOf(calls)).toEqual(["probe", "Page.captureScreenshot"]);
  });

  test("`backdrop: null` skips the probe entirely", async () => {
    const { page, calls } = fakePage({
      appearance: { transparent: true, color: "rgb(17, 17, 17)" },
    });
    const result = await capturePage(page, { format: "png", backdrop: null });

    expect(result.composited).toBe(false);
    expect(stepsOf(calls)).toEqual(["Page.captureScreenshot"]);
  });

  test("an explicit colour is applied without probing", async () => {
    const { page, calls } = fakePage({ appearance: { transparent: false } });
    const result = await capturePage(page, { format: "png", backdrop: "#abc" });

    expect(result).toMatchObject({ composited: true, backdrop: "#abc" });
    expect(stepsOf(calls)).toEqual([
      "apply-backdrop",
      "Page.captureScreenshot",
      "restore-backdrop",
    ]);
    expect(String(calls[0]?.params.expression)).toContain('"#abc"');
  });

  // Diagnostics must degrade, not fail: a transparent image beats no image.
  test("still captures when the transparency probe throws", async () => {
    const { page } = fakePage({ failOn: "Runtime.evaluate" });
    expect((await capturePage(page, { format: "png" })).composited).toBe(false);
  });

  // The inspector serves requests concurrently. Interleaved captures would make the
  // second stash the first one's backdrop as "the original", leaving the page
  // permanently composited after both restores ran.
  test("serializes overlapping captures of the same page", async () => {
    const { page, calls } = fakePage({
      appearance: { transparent: true, color: "rgb(17, 17, 17)" },
    });

    await Promise.all([
      capturePage(page, { format: "png" }),
      capturePage(page, { format: "png" }),
      capturePage(page, { format: "png" }),
    ]);

    // Each capture completes its apply → shoot → restore before the next begins.
    const steps = stepsOf(calls);
    let applied = 0;
    for (const step of steps) {
      if (step === "apply-backdrop") applied++;
      if (step === "restore-backdrop") applied--;
      expect(applied).toBeLessThanOrEqual(1);
    }
    expect(applied).toBe(0);
    expect(steps.filter((s) => s === "apply-backdrop")).toHaveLength(3);
    expect(steps.filter((s) => s === "restore-backdrop")).toHaveLength(3);
  });

  test("a failed capture does not wedge later captures of the same page", async () => {
    const { page } = fakePage({
      appearance: { transparent: true, color: "rgb(17, 17, 17)" },
      failOn: "Page.captureScreenshot",
    });
    await expect(capturePage(page, { format: "png" })).rejects.toThrow();
    await expect(capturePage(page, { format: "png" })).rejects.toThrow();
  });

  test("restores the page even when the capture fails", async () => {
    const { page, calls } = fakePage({
      appearance: { transparent: true, color: "rgb(17, 17, 17)" },
      failOn: "Page.captureScreenshot",
    });
    await expect(capturePage(page, { format: "png" })).rejects.toThrow();
    expect(stepsOf(calls).at(-1)).toBe("restore-backdrop");
  });
});
