import { expect, test } from "bun:test";
import * as lucide from "lucide";
import * as core from "../src/icons/core.generated.ts";
import * as icons from "../src/icons/index.ts";
import { createLucideIcon, type IconNode, type LucideIcon } from "../src/icons/index.ts";
import { mount, type TreeNode } from "./harness.ts";

/** lucide's data for an icon as the markup Metal draws, written out independently of `create.tsx`. */
function markupOf(node: IconNode): string {
  const body = node
    .map(([tag, attrs]) => {
      const rendered = Object.entries(attrs)
        .filter(([key]) => key !== "key")
        .map(
          ([key, value]) => `${key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}="${value}"`,
        )
        .join(" ");
      return `<${tag} ${rendered}/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

function svgMarkups(tree: TreeNode): string[] {
  const out: string[] = [];
  const visit = (node: TreeNode | string): void => {
    if (typeof node === "string") return;
    if (node.type === "svg") out.push(String(node.props.markup));
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return out;
}

const data = lucide as unknown as Record<string, IconNode>;
const names = Object.keys(data)
  .filter((name) => Array.isArray(data[name]))
  .sort();

test("every icon draws lucide's data for its name, under its three names", async () => {
  const all = icons as unknown as Record<string, LucideIcon>;
  expect(names.length).toBeGreaterThan(2000);
  for (const name of names) {
    expect(all[name]?.displayName).toBe(name);
    expect(all[`${name}Icon`]).toBe(all[name]);
    expect(all[`Lucide${name}`]).toBe(all[name]);
  }
  const h = await mount(
    <div>
      {names.map((name) => {
        const Icon = all[name] as LucideIcon;
        return <Icon key={name} />;
      })}
    </div>,
  );
  const drawn = svgMarkups(h.tree());
  expect(drawn.length).toBe(names.length);
  names.forEach((name, index) => {
    expect(drawn[index]).toBe(markupOf(data[name] as IconNode));
  });
  h.unmount();
});

test("the components' own icons are the same ones the icons entry exports", () => {
  const all = icons as unknown as Record<string, unknown>;
  for (const [name, icon] of Object.entries(core)) expect(all[name]).toBe(icon);
});

test("an icon's data is loaded by its first render, once", async () => {
  let loads = 0;
  const Lazy = createLucideIcon("Lazy", () => {
    loads += 1;
    return { default: [["path", { d: "M1 1h2", strokeWidth: 3, key: "k" }]] };
  });
  expect(loads).toBe(0);
  const h = await mount(
    <div>
      <Lazy />
      <Lazy />
    </div>,
  );
  expect(loads).toBe(1);
  expect(svgMarkups(h.tree())[0]).toContain('<path d="M1 1h2" stroke-width="3"/>');
  h.unmount();
});
