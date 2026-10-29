/**
 * Port an upstream shadcn file into metal-ui by rewriting only its imports;
 * class strings, props, and structure stay verbatim.
 *
 *   bun scripts/port-ui.ts <shadcn>/apps/v4/registry/new-york-v4 ui <name>       → src/components/<name>.tsx
 *   bun scripts/port-ui.ts <shadcn>/apps/v4/registry/new-york-v4 examples <name> → demo/examples/<name>.tsx
 *
 * Pass --force to overwrite an existing port.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [registry, kind, name] = Bun.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const force = Bun.argv.includes("--force");
if (!registry || (kind !== "ui" && kind !== "examples") || !name) {
  throw new Error("usage: bun scripts/port-ui.ts <registry> <ui|examples> <name> [--force]");
}

const source = await Bun.file(join(registry, kind, `${name}.tsx`)).text();
const fromComponents = kind === "ui";
const ui = (component: string) =>
  fromComponents ? `./${component}.tsx` : `../../src/components/${component}.tsx`;
const lib = fromComponents ? ".." : "../../src";

export function rewrite(code: string): string {
  return code
    .replace(/^"use client"\n+/m, "")
    .replace(/from "cn"/g, `from "${lib}/lib/cn.ts"`)
    .replace(/from "@\/lib\/utils"/g, `from "${lib}/lib/cn.ts"`)
    .replace(/from "class-variance-authority"/g, `from "${lib}/lib/cn.ts"`)
    .replace(/from "radix-ui"/g, `from "${lib}/primitives/index.ts"`)
    .replace(/from "@radix-ui\/react-([\w-]+)"/g, `from "${lib}/primitives/index.ts"`)
    .replace(/from "lucide-react"/g, `from "${lib}/icons/index.ts"`)
    .replace(
      /from "@\/registry\/new-york-v4\/ui\/([\w-]+)"/g,
      (_, component: string) => `from "${ui(component)}"`,
    )
    .replace(/from "@\/registry\/new-york-v4\/hooks\/([\w-]+)"/g, `from "${lib}/hooks/$1.ts"`)
    .replace(/from "@\/registry\/new-york-v4\/lib\/([\w-]+)"/g, `from "${lib}/lib/$1.ts"`);
}

const target = fromComponents
  ? join(import.meta.dir, "..", "src", "components", `${name}.tsx`)
  : join(import.meta.dir, "..", "demo", "examples", `${name}.tsx`);
if (existsSync(target) && !force) {
  console.log(`skip ${target} (exists; --force to overwrite)`);
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, rewrite(source));
  console.log(`wrote ${target}`);
}
