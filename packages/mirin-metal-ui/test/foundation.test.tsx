import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { Button } from "../src/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../src/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../src/components/dropdown-menu.tsx";
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

describe("html elements through the JSX runtime", () => {
  test("div, p, strong, and lists render as views and text", async () => {
    const h = await mount(
      <ThemeProvider>
        <div className="flex flex-col gap-4 p-6">
          <p className="text-sm text-muted-foreground">
            Hello <strong>bold</strong> world
          </p>
          <ul className="ml-6 list-disc">
            <li>first</li>
            <li>second</li>
          </ul>
        </div>
      </ThemeProvider>,
    );
    expect(h.texts()).toEqual(
      expect.arrayContaining(["Hello ", "bold", " world", "•", "first", "second"]),
    );
    const bold = find(h.tree(), (n) => n.type === "text" && (n.children ?? [])[0] === "bold");
    expect(bold?.props.weight).toBe("bold");
    expect(bold?.props.color).toBe(darkTokens.mutedForeground);
    h.unmount();
  });
});

describe("Button", () => {
  test("default variant paints primary and fires onClick", async () => {
    let clicks = 0;
    const h = await mount(
      <ThemeProvider>
        <Button data-testid="go" onClick={() => clicks++}>
          Deploy
        </Button>
      </ThemeProvider>,
    );
    const button = find(h.tree(), (n) => n.props.background === darkTokens.primary);
    expect(button).toBeDefined();
    expect(button?.props.direction).toBe("row");
    expect(button?.props.height).toBe(36);
    await h.press("go");
    expect(clicks).toBe(1);
    h.unmount();
  });
});

describe("Dialog", () => {
  test("opens from its trigger in the overlay layer and closes from the X", async () => {
    const h = await mount(
      <ThemeProvider>
        <Dialog>
          <DialogTrigger asChild>
            <Button data-testid="open">Open</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit profile</DialogTitle>
              <DialogDescription>Make changes here.</DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      </ThemeProvider>,
    );
    expect(h.hasText("Edit profile")).toBe(false);
    await h.press("open");
    expect(h.hasText("Edit profile")).toBe(true);
    const content = find(
      h.tree(),
      (n) => n.props.occlude === true && n.props.background === darkTokens.background,
    );
    expect(content?.props.cornerRadius).toBe(10);
    await h.press("dialog-close");
    expect(h.hasText("Edit profile")).toBe(false);
    h.unmount();
  });
});

describe("DropdownMenu", () => {
  test("opens, toggles a checkbox item, and closes on select", async () => {
    let chosen = "";
    function Menu() {
      const [bar, setBar] = useState(true);
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button data-testid="menu">Menu</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem checked={bar} onCheckedChange={setBar}>
              Status Bar
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem
              onSelect={() => {
                chosen = "profile";
              }}
            >
              Profile
            </DropdownMenuItem>
          </DropdownMenuContent>
          <span>{bar ? "bar on" : "bar off"}</span>
        </DropdownMenu>
      );
    }
    const h = await mount(
      <ThemeProvider>
        <Menu />
      </ThemeProvider>,
    );
    await h.press("menu");
    expect(h.hasText("Profile")).toBe(true);
    await h.pressText("Status Bar");
    expect(h.hasText("bar off")).toBe(true);
    expect(h.hasText("Profile")).toBe(false);
    await h.press("menu");
    await h.pressText("Profile");
    expect(chosen).toBe("profile");
    expect(h.hasText("Profile")).toBe(false);
    h.unmount();
  });
});

describe("w-fit", () => {
  test("stops a column from stretching the element, but leaves rows alone", async () => {
    const h = await mount(
      <ThemeProvider>
        <div className="flex flex-col">
          <div className="w-fit" data-testid="in-column">
            a
          </div>
          <div className="flex items-center">
            <div className="w-fit" data-testid="in-row">
              b
            </div>
          </div>
        </div>
      </ThemeProvider>,
    );
    // The view that directly holds the text run with this label.
    const holder = (label: string) =>
      find(h.tree(), (node) =>
        (node.children ?? []).some(
          (child) =>
            typeof child !== "string" && child.type === "text" && child.children?.includes(label),
        ),
      );
    expect(holder("a")?.props.alignSelf).toBe("start");
    expect(holder("b")?.props.alignSelf).toBeUndefined();
    h.unmount();
  });

  test("a centering parent keeps centering a w-fit child", async () => {
    const h = await mount(
      <ThemeProvider>
        <div className="flex flex-col items-center">
          <div className="w-fit">c</div>
        </div>
      </ThemeProvider>,
    );
    const holder = find(h.tree(), (node) =>
      (node.children ?? []).some(
        (child) =>
          typeof child !== "string" && child.type === "text" && child.children?.includes("c"),
      ),
    );
    expect(holder?.props.alignSelf).toBeUndefined();
    h.unmount();
  });
});

describe("event handlers written for the DOM", () => {
  test("DOM traversal finds nothing, and a throwing handler doesn't stop the app", async () => {
    let closest: unknown = "unset";
    let clicks = 0;
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    const h = await mount(
      <ThemeProvider>
        <button
          type="button"
          data-testid="traverse"
          onClick={(event: unknown) => {
            const target = (event as { target: { closest: (selector: string) => unknown } }).target;
            closest = target.closest("button");
          }}
        >
          traverse
        </button>
        <button
          type="button"
          data-testid="throws"
          onClick={() => {
            clicks += 1;
            throw new Error("handler failed");
          }}
        >
          throws
        </button>
      </ThemeProvider>,
    );
    try {
      await h.press("traverse");
      expect(closest).toBeNull();
      await h.press("throws");
      await h.press("throws");
      expect(clicks).toBe(2);
      expect(errors.length).toBe(2);
    } finally {
      console.error = original;
      h.unmount();
    }
  });
});
