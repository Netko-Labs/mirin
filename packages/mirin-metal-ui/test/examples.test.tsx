/**
 * Smoke-test every ported example headlessly: mount it inside a
 * ThemeProvider, let it settle, and require that it rendered some text and
 * did not throw. Filter with `bun test test/examples.test.tsx -t accordion`.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ComponentType } from "react";
import { ThemeProvider } from "../src/provider.tsx";
import { mount } from "./harness.ts";

const dir = join(import.meta.dir, "..", "demo", "examples");
const names = readdirSync(dir)
  .filter((file) => file.endsWith(".tsx"))
  .map((file) => file.replace(/\.tsx$/, ""))
  .sort();

describe("examples", () => {
  for (const name of names) {
    test(name, async () => {
      const errors: unknown[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      try {
        const mod = (await import(join(dir, `${name}.tsx`))) as { default?: ComponentType };
        expect(typeof mod.default).toBe("function");
        const Example = mod.default as ComponentType;
        const h = await mount(
          <ThemeProvider>
            <Example />
          </ThemeProvider>,
        );
        const rendered = h.tree();
        h.unmount();
        expect(JSON.stringify(rendered).length).toBeGreaterThan(60);
      } finally {
        console.error = original;
      }
      const fatal = errors.filter((line) => !/Warning: |act\(|key" prop/.test(String(line)));
      expect(fatal).toEqual([]);
    });
  }
});
