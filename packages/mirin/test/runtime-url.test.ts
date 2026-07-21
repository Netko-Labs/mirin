import { expect, test } from "bun:test";
import { resolveUrlWithDevServer } from "../src/runtime.ts";

test("development window loads resolve through Vite and preserve routing", () => {
  const devUrl = "http://127.0.0.1:5173";

  expect(resolveUrlWithDevServer("app://ui/settings?tab=account#security", devUrl)).toBe(
    "http://127.0.0.1:5173?tab=account#security",
  );
  expect(resolveUrlWithDevServer("app://ui/index.html#scratch", devUrl)).toBe(
    "http://127.0.0.1:5173#scratch",
  );
});

test("production window loads keep the requested URL", () => {
  expect(resolveUrlWithDevServer("app://ui/settings", undefined)).toBe("app://ui/settings");
});
