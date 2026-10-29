import { expect, test } from "bun:test";
import { Browser, listExamples } from "../demo/browser.tsx";
import { ThemeProvider } from "../src/provider.tsx";
import { mount } from "./harness.ts";

test("the browser lists examples, filters, and switches the preview", async () => {
  const names = listExamples();
  expect(names.length).toBeGreaterThan(0);
  const h = await mount(
    <ThemeProvider>
      <Browser initial="button-demo" />
    </ThemeProvider>,
  );
  await Bun.sleep(50);
  await h.settle();
  expect(h.hasText(`${names.length} examples`)).toBe(true);
  await h.type("search", "dropdown");
  expect(h.hasText("button-demo")).toBe(true); // header still shows the selection
  await h.press("example:dropdown-menu-demo");
  await Bun.sleep(50);
  await h.settle();
  expect(h.hasText("dropdown-menu-demo")).toBe(true);
  h.unmount();
});
