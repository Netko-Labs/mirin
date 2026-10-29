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

/** Radix primitive name → `src/primitives/<file>.tsx`. */
const PRIMITIVE_FILES: Record<string, string> = {
  AlertDialog: "dialog",
  DropdownMenu: "menu",
};

function primitiveFile(name: string): string {
  return PRIMITIVE_FILES[name] ?? name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Third-party packages that have a metal-ui stand-in. Paths are relative to `src/`. */
const MODULES: Record<string, string> = {
  sonner: "components/sonner.tsx",
  recharts: "charts/index.ts",
  "next/link": "compat/next-link.tsx",
  "next/image": "compat/next-image.tsx",
  "next/form": "compat/next-form.tsx",
  "next/font/google": "compat/next-font.ts",
  "next-themes": "compat/next-themes.ts",
  "@tabler/icons-react": "compat/tabler-icons.ts",
  "react-day-picker": "compat/react-day-picker.tsx",
  "react-day-picker/persian": "compat/react-day-picker.tsx",
  "input-otp": "primitives/input-otp.tsx",
  vaul: "primitives/vaul.tsx",
  cmdk: "primitives/cmdk.tsx",
  "react-resizable-panels": "primitives/resizable-panels.tsx",
  "embla-carousel-react": "primitives/embla.tsx",
  "embla-carousel-autoplay": "primitives/embla-autoplay.ts",
  "@base-ui/react": "primitives/base-ui.tsx",
  "@shadcn/react/message-scroller": "primitives/message-scroller.tsx",
  "react-textarea-autosize": "compat/textarea-autosize.tsx",
  "@/hooks/use-media-query": "hooks/use-media-query.ts",
  "@/hooks/use-copy-to-clipboard": "hooks/use-copy-to-clipboard.ts",
};

export function rewrite(code: string): string {
  return code
    .replace(/^"use client"\n+/m, "")
    .replace(
      /import\s*\{([^}]*)\}\s*from\s*"radix-ui"/g,
      (_, specifiers: string) =>
        specifiers
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const name = part.replace(/^type\s+/, "").split(/\s+as\s+/)[0] ?? part;
            return `import { ${part} } from "${lib}/primitives/${primitiveFile(name)}.tsx"`;
          })
          .join("\n"),
    )
    .replace(/from "cn"/g, `from "${lib}/lib/cn.ts"`)
    .replace(/from "@\/lib\/utils"/g, `from "${lib}/lib/cn.ts"`)
    .replace(/from "class-variance-authority"/g, `from "${lib}/lib/cn.ts"`)
    .replace(/from "lucide-react"/g, `from "${lib}/icons/index.ts"`)
    .replace(/from "([^"]+)"/g, (whole, module: string) =>
      MODULES[module] ? `from "${lib}/${MODULES[module]}"` : whole,
    )
    .replace(/from "@\/registry\/new-york-v4\/ui\/([\w-]+)"/g, (_, component: string) => `from "${ui(component)}"`)
    .replace(/from "@\/registry\/new-york-v4\/examples\/([\w-]+)"/g, (_, example: string) =>
      fromComponents ? `from "../../demo/examples/${example}.tsx"` : `from "./${example}.tsx"`,
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
