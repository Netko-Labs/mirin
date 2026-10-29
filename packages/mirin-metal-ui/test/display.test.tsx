import { describe, expect, test } from "bun:test";
import type { ComponentType } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../src/components/accordion.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "../src/components/avatar.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../src/components/collapsible.tsx";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
} from "../src/components/pagination.tsx";
import { Progress } from "../src/components/progress.tsx";
import { Table, TableBody, TableCell, TableRow } from "../src/components/table.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../src/components/tabs.tsx";
import { ThemeProvider } from "../src/provider.tsx";
import { darkTokens } from "../src/theme.ts";
import { mount, type TreeNode } from "./harness.ts";

function find(
  node: TreeNode | string,
  predicate: (node: TreeNode) => boolean,
): TreeNode | undefined {
  if (typeof node === "string") return undefined;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, predicate);
    if (hit) return hit;
  }
  return undefined;
}

function findAll(node: TreeNode | string, predicate: (node: TreeNode) => boolean): TreeNode[] {
  if (typeof node === "string") return [];
  const own = predicate(node) ? [node] : [];
  return [...own, ...(node.children ?? []).flatMap((child) => findAll(child, predicate))];
}

describe("Accordion", () => {
  test("single opens one item at a time and collapses when collapsible", async () => {
    const h = await mount(
      <ThemeProvider>
        <Accordion type="single" collapsible>
          <AccordionItem value="a">
            <AccordionTrigger>First</AccordionTrigger>
            <AccordionContent>First body</AccordionContent>
          </AccordionItem>
          <AccordionItem value="b">
            <AccordionTrigger>Second</AccordionTrigger>
            <AccordionContent>Second body</AccordionContent>
          </AccordionItem>
        </Accordion>
      </ThemeProvider>,
    );
    expect(h.hasText("First body")).toBe(false);
    await h.pressText("First");
    expect(h.hasText("First body")).toBe(true);
    await h.pressText("Second");
    expect(h.hasText("First body")).toBe(false);
    expect(h.hasText("Second body")).toBe(true);
    await h.pressText("Second");
    expect(h.hasText("Second body")).toBe(false);
    h.unmount();
  });

  test("single without collapsible keeps the open item open", async () => {
    const h = await mount(
      <ThemeProvider>
        <Accordion type="single" defaultValue="a">
          <AccordionItem value="a">
            <AccordionTrigger>First</AccordionTrigger>
            <AccordionContent>First body</AccordionContent>
          </AccordionItem>
        </Accordion>
      </ThemeProvider>,
    );
    expect(h.hasText("First body")).toBe(true);
    await h.pressText("First");
    expect(h.hasText("First body")).toBe(true);
    h.unmount();
  });

  test("multiple keeps several items open", async () => {
    let last: string[] = [];
    const h = await mount(
      <ThemeProvider>
        <Accordion
          type="multiple"
          onValueChange={(value: string[]) => {
            last = value;
          }}
        >
          <AccordionItem value="a">
            <AccordionTrigger>First</AccordionTrigger>
            <AccordionContent>First body</AccordionContent>
          </AccordionItem>
          <AccordionItem value="b">
            <AccordionTrigger>Second</AccordionTrigger>
            <AccordionContent>Second body</AccordionContent>
          </AccordionItem>
        </Accordion>
      </ThemeProvider>,
    );
    await h.pressText("First");
    await h.pressText("Second");
    expect(h.hasText("First body")).toBe(true);
    expect(h.hasText("Second body")).toBe(true);
    expect(last).toEqual(["a", "b"]);
    h.unmount();
  });
});

describe("Tabs", () => {
  test("switches content and marks the active trigger", async () => {
    const changes: string[] = [];
    const h = await mount(
      <ThemeProvider>
        <Tabs defaultValue="account" onValueChange={(value) => changes.push(value)}>
          <TabsList>
            <TabsTrigger value="account">Account</TabsTrigger>
            <TabsTrigger value="password">Password</TabsTrigger>
          </TabsList>
          <TabsContent value="account">Account panel</TabsContent>
          <TabsContent value="password">Password panel</TabsContent>
        </Tabs>
      </ThemeProvider>,
    );
    expect(h.hasText("Account panel")).toBe(true);
    expect(h.hasText("Password panel")).toBe(false);
    await h.pressText("Password");
    expect(h.hasText("Account panel")).toBe(false);
    expect(h.hasText("Password panel")).toBe(true);
    expect(changes).toEqual(["password"]);
    const active = find(
      h.tree(),
      (n) =>
        n.type === "text" &&
        (n.children ?? []).join("") === "Password" &&
        n.props.color === darkTokens.foreground,
    );
    expect(active).toBeDefined();
    h.unmount();
  });
});

describe("Collapsible", () => {
  test("toggles its content from the trigger", async () => {
    const h = await mount(
      <ThemeProvider>
        <Collapsible>
          <CollapsibleTrigger data-testid="toggle">Toggle</CollapsibleTrigger>
          <CollapsibleContent>Hidden stuff</CollapsibleContent>
        </Collapsible>
      </ThemeProvider>,
    );
    expect(h.hasText("Hidden stuff")).toBe(false);
    await h.press("toggle");
    expect(h.hasText("Hidden stuff")).toBe(true);
    await h.press("toggle");
    expect(h.hasText("Hidden stuff")).toBe(false);
    h.unmount();
  });
});

describe("Avatar", () => {
  test("shows the fallback when the image cannot load", async () => {
    const h = await mount(
      <ThemeProvider>
        <Avatar>
          <AvatarImage src="/definitely/not/here.png" alt="missing" />
          <AvatarFallback>CN</AvatarFallback>
        </Avatar>
      </ThemeProvider>,
    );
    await h.settle();
    expect(h.hasText("CN")).toBe(true);
    expect(find(h.tree(), (n) => n.type === "image")).toBeUndefined();
    h.unmount();
  });

  test("swaps the fallback for the image once it loads", async () => {
    const h = await mount(
      <ThemeProvider>
        <Avatar>
          <AvatarImage src={import.meta.path} alt="local" />
          <AvatarFallback>CN</AvatarFallback>
        </Avatar>
      </ThemeProvider>,
    );
    await h.settle();
    expect(h.hasText("CN")).toBe(false);
    expect(find(h.tree(), (n) => n.type === "image")?.props.src).toBe(import.meta.path);
    h.unmount();
  });
});

describe("Progress", () => {
  test("indicator width tracks the value", async () => {
    function widthFor(tree: TreeNode): unknown {
      return find(tree, (n) => n.props.background === darkTokens.primary)?.props.widthPercent;
    }
    const at25 = await mount(
      <ThemeProvider>
        <Progress value={25} />
      </ThemeProvider>,
    );
    expect(widthFor(at25.tree())).toBe(0.25);
    at25.unmount();
    const at80 = await mount(
      <ThemeProvider>
        <Progress value={80} />
      </ThemeProvider>,
    );
    expect(widthFor(at80.tree())).toBe(0.8);
    at80.unmount();
  });
});

describe("Pagination", () => {
  test("renders pressable page links", async () => {
    let clicked = "";
    const h = await mount(
      <ThemeProvider>
        <Pagination>
          <PaginationContent>
            {["1", "2", "3"].map((page) => (
              <PaginationItem key={page}>
                <PaginationLink
                  href="#"
                  isActive={page === "2"}
                  onClick={() => {
                    clicked = page;
                  }}
                >
                  {page}
                </PaginationLink>
              </PaginationItem>
            ))}
          </PaginationContent>
        </Pagination>
      </ThemeProvider>,
    );
    expect(h.texts()).toEqual(expect.arrayContaining(["1", "2", "3"]));
    await h.pressText("3");
    expect(clicked).toBe("3");
    h.unmount();
  });
});

describe("Table", () => {
  test("cells in the same column share a width across rows", async () => {
    const h = await mount(
      <ThemeProvider>
        <Table>
          <TableBody>
            <TableRow>
              <TableCell className="w-[100px]">INV001</TableCell>
              <TableCell>Paid</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>INV002</TableCell>
              <TableCell>Pending long label</TableCell>
            </TableRow>
            <TableRow>
              <TableCell colSpan={2}>Total</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </ThemeProvider>,
    );
    const rows = findAll(
      h.tree(),
      (n) => n.props.direction === "row" && n.props.borderBottom === 1,
    );
    const widths = rows.map((row) =>
      (row.children ?? []).map((cell) => (typeof cell === "string" ? 0 : cell.props.width)),
    );
    expect(widths[0]).toEqual([100, 100]);
    expect(widths[1]).toEqual([100, 100]);
    expect(widths[2]).toEqual([200]);
    h.unmount();
  });
});

describe("DataTable", () => {
  test("sorts by email and filters rows", async () => {
    const mod = (await import("../demo/examples/data-table-demo.tsx")) as {
      default: ComponentType;
    };
    const Demo = mod.default;
    const h = await mount(
      <ThemeProvider>
        <Demo />
      </ThemeProvider>,
    );
    const emails = () => h.texts().filter((text) => text.endsWith("@example.com"));
    expect(emails()[0]).toBe("ken99@example.com");
    await h.pressText("Email");
    expect(emails()).toEqual([
      "abe45@example.com",
      "carmella@example.com",
      "ken99@example.com",
      "monserrat44@example.com",
      "silas22@example.com",
    ]);
    await h.pressText("Email");
    expect(emails()[0]).toBe("silas22@example.com");
    await h.type("input", "carm");
    expect(emails()).toEqual(["carmella@example.com"]);
    h.unmount();
  });
});
