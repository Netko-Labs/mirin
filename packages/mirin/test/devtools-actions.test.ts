import { describe, expect, test } from "bun:test";
import {
  ActionError,
  click,
  KEY_NAMES,
  key,
  locate,
  locateScript,
  scroll,
  type,
} from "../src/devtools/lib/actions.ts";

/** A fake CDP page that records commands and replays canned results. */
function fakePage(results: Record<string, Record<string, unknown>> = {}) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const send = async (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    sent.push({ method, params });
    return results[method] ?? {};
  };
  return { send, sent };
}

/** `Runtime.evaluate` reply for a located element. */
const located = (over: Record<string, unknown> = {}) => ({
  "Runtime.evaluate": {
    result: { value: { found: true, visible: true, x: 40, y: 12, tag: "button", ...over } },
  },
});

describe("selector script construction", () => {
  // Selectors reach us over HTTP; concatenating one into page script would let a
  // caller inject arbitrary JavaScript through a quote.
  test("embeds a CSS selector as a JSON string, never raw", () => {
    const script = locateScript('button[data-x="1"]');
    expect(script).toContain(JSON.stringify('button[data-x="1"]'));
    expect(script).toContain("document.querySelector(");
  });

  test("a quote-bearing selector cannot escape the string literal", () => {
    const nasty = '"); globalThis.pwned = 1; ("';
    const script = locateScript(nasty);
    expect(script).toContain(JSON.stringify(nasty));
    expect(script).not.toContain("globalThis.pwned = 1;\n");
    // The payload survives only inside the quoted literal.
    expect(script.includes(`querySelector(${JSON.stringify(nasty)})`)).toBe(true);
  });

  test("an explicit css= prefix is stripped", () => {
    expect(locateScript("css=.a")).toContain(JSON.stringify(".a"));
    expect(locateScript("css=.a")).not.toContain(JSON.stringify("css=.a"));
  });

  test("text= builds a label search, not a querySelector", () => {
    const script = locateScript("text=Save");
    expect(script).toContain(JSON.stringify("Save"));
    expect(script).toContain("aria-label");
    expect(script).not.toContain('querySelector("Save")');
  });

  test("every selector scrolls its match into view before measuring", () => {
    expect(locateScript(".a")).toContain("scrollIntoView");
  });
});

describe("locate", () => {
  test("returns the element's center", async () => {
    const page = fakePage(located());
    expect(await locate(page.send, ".a")).toEqual({ x: 40, y: 12, tag: "button" });
  });

  test("a missing element is the caller's error, and names the selector", async () => {
    const page = fakePage({ "Runtime.evaluate": { result: { value: { found: false } } } });
    await expect(locate(page.send, ".missing")).rejects.toThrow(/no element matched \.missing/);
  });

  test("a zero-size element reports why it cannot be clicked", async () => {
    const page = fakePage({
      "Runtime.evaluate": { result: { value: { found: true, visible: false, tag: "div" } } },
    });
    await expect(locate(page.send, ".hidden")).rejects.toThrow(/no visible box/);
  });
});

describe("click", () => {
  test("sends a real press/release pair at the element's center", async () => {
    const page = fakePage(located());
    await click(page.send, "text=Save");
    const mouse = page.sent.filter((entry) => entry.method === "Input.dispatchMouseEvent");
    expect(mouse.map((entry) => entry.params.type)).toEqual(["mousePressed", "mouseReleased"]);
    expect(mouse[0]?.params).toMatchObject({ x: 40, y: 12, button: "left", clickCount: 1 });
  });

  test("passes a double-click through as a click count", async () => {
    const page = fakePage(located());
    await click(page.send, ".a", 2);
    const mouse = page.sent.filter((entry) => entry.method === "Input.dispatchMouseEvent");
    expect(mouse[0]?.params.clickCount).toBe(2);
  });
});

describe("type", () => {
  test("clicks the target first so the field is genuinely focused", async () => {
    const page = fakePage(located());
    await type(page.send, "hello", ".field");
    expect(page.sent.map((entry) => entry.method)).toEqual([
      "Runtime.evaluate",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.insertText",
    ]);
    expect(page.sent.at(-1)?.params).toEqual({ text: "hello" });
  });

  test("types into whatever has focus when no selector is given", async () => {
    const page = fakePage();
    await type(page.send, "hi");
    expect(page.sent.map((entry) => entry.method)).toEqual(["Input.insertText"]);
  });
});

describe("key", () => {
  test("sends a down/up pair carrying the virtual key code", async () => {
    const page = fakePage();
    await key(page.send, "Enter");
    expect(page.sent.map((entry) => entry.params.type)).toEqual(["keyDown", "keyUp"]);
    expect(page.sent[0]?.params).toMatchObject({ key: "Enter", windowsVirtualKeyCode: 13 });
    // Enter carries text so forms submit the way they would for a person.
    expect(page.sent[0]?.params.text).toBe("\r");
  });

  test("a non-printable key uses rawKeyDown and carries no text", async () => {
    const page = fakePage();
    await key(page.send, "Tab");
    expect(page.sent[0]?.params.type).toBe("rawKeyDown");
    expect(page.sent[0]?.params.text).toBeUndefined();
  });

  test("an unknown key lists the supported ones", async () => {
    const page = fakePage();
    const attempt = key(page.send, "Meta+Shift+P");
    await expect(attempt).rejects.toThrow(ActionError);
    await expect(key(page.send, "Meta+Shift+P")).rejects.toThrow(/Enter/);
    expect(KEY_NAMES).toContain("Escape");
  });
});

describe("scroll", () => {
  test("scrolls the viewport when no selector is given", async () => {
    const page = fakePage();
    await scroll(page.send, 240);
    expect(page.sent).toHaveLength(1);
    expect(page.sent[0]?.params).toMatchObject({ type: "mouseWheel", deltaY: 240, deltaX: 0 });
  });

  test("scrolls at a selector's center when one is given", async () => {
    const page = fakePage(located());
    await scroll(page.send, -100, 0, ".list");
    expect(page.sent.at(-1)?.params).toMatchObject({ type: "mouseWheel", x: 40, y: 12 });
  });
});
