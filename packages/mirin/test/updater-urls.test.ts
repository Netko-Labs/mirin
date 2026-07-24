import { afterEach, describe, expect, test } from "bun:test";
import { fetchTrustedUpdateUrl } from "../src/updater/lib/urls.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("trusted updater redirects", () => {
  test("rejects an insecure intermediate redirect before requesting it", async () => {
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      requested.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: "http://updates.example.com/manifest" },
      });
    };

    await expect(fetchTrustedUpdateUrl("https://updates.example.com/start")).rejects.toThrow(
      "must use HTTPS",
    );
    expect(requested).toEqual(["https://updates.example.com/start"]);
  });

  test("follows bounded HTTPS redirects", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 302, headers: { location: "/final" } })
        : new Response("ok", { status: 200 });
    };

    const response = await fetchTrustedUpdateUrl("https://updates.example.com/start");
    expect(await response.text()).toBe("ok");
    expect(calls).toBe(2);
  });

  test("aborts a request that exceeds its deadline", async () => {
    globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing abort signal"));
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });

    await expect(
      fetchTrustedUpdateUrl("https://updates.example.com/stalled", { timeoutMs: 10 }),
    ).rejects.toThrow();
  });
});
