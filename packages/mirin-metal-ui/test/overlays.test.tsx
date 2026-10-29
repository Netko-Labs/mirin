import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import ComboboxDemo from "../demo/examples/combobox-demo.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../src/components/alert-dialog.tsx";
import { Button } from "../src/components/button.tsx";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "../src/components/combobox.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../src/components/command.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../src/components/context-menu.tsx";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "../src/components/drawer.tsx";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../src/components/hover-card.tsx";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarTrigger,
} from "../src/components/menubar.tsx";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "../src/components/navigation-menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../src/components/popover.tsx";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "../src/components/sheet.tsx";
import { Toaster, toast } from "../src/components/sonner.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip.tsx";
import { ThemeProvider } from "../src/provider.tsx";
import { darkTokens } from "../src/theme.ts";
import { type Harness, mount, type TreeNode } from "./harness.ts";

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

/** The serialized node a testID resolves to. */
function byTestID(h: Harness, testID: string): TreeNode | undefined {
  const id = h.nodeId(testID);
  return id ? find(h.tree(), (n) => n.props.id === id) : undefined;
}

afterEach(() => {
  toast.dismiss();
});

describe("AlertDialog", () => {
  test("opens, ignores the scrim, and the action closes and runs onClick", async () => {
    let deleted = 0;
    const h = await mount(
      <ThemeProvider>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button data-testid="open">Delete</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="confirm" onClick={() => deleted++}>
              Continue
            </AlertDialogAction>
          </AlertDialogContent>
        </AlertDialog>
      </ThemeProvider>,
    );
    expect(h.hasText("Are you absolutely sure?")).toBe(false);
    await h.press("open");
    expect(h.hasText("Are you absolutely sure?")).toBe(true);
    await h.press("alert-dialog-overlay");
    expect(h.hasText("Are you absolutely sure?")).toBe(true);
    await h.press("confirm");
    expect(deleted).toBe(1);
    expect(h.hasText("Are you absolutely sure?")).toBe(false);
    h.unmount();
  });
});

describe("Sheet", () => {
  test("opens pinned to the right edge and closes from SheetClose and the scrim", async () => {
    const h = await mount(
      <ThemeProvider>
        <Sheet>
          <SheetTrigger asChild>
            <Button data-testid="open">Open</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetTitle>Edit profile</SheetTitle>
            <SheetClose asChild>
              <Button data-testid="done">Done</Button>
            </SheetClose>
          </SheetContent>
        </Sheet>
      </ThemeProvider>,
    );
    await h.press("open");
    expect(h.hasText("Edit profile")).toBe(true);
    const content = byTestID(h, "sheet-content");
    expect(content?.props.absolute).toBe(true);
    expect(content?.props.right).toBe(0);
    expect(content?.props.top).toBe(0);
    expect(content?.props.bottom).toBe(0);
    expect(content?.props.widthPercent).toBe(0.75);
    await h.press("done");
    expect(h.hasText("Edit profile")).toBe(false);
    await h.press("open");
    await h.press("sheet-overlay");
    expect(h.hasText("Edit profile")).toBe(false);
    h.unmount();
  });
});

describe("Popover", () => {
  test("opens anchored to the trigger and closes on an outside press", async () => {
    const h = await mount(
      <ThemeProvider>
        <Popover>
          <PopoverTrigger asChild>
            <Button data-testid="open">Open popover</Button>
          </PopoverTrigger>
          <PopoverContent>Dimensions</PopoverContent>
        </Popover>
      </ThemeProvider>,
    );
    await h.press("open");
    expect(h.hasText("Dimensions")).toBe(true);
    const content = byTestID(h, "popover-content");
    expect(content?.props.background).toBe(darkTokens.popover);
    await h.press("popover-dismiss");
    expect(h.hasText("Dimensions")).toBe(false);
    h.unmount();
  });
});

describe("Tooltip", () => {
  test("shows on hover and hides on leave", async () => {
    const h = await mount(
      <ThemeProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button data-testid="hover-me">Hover</Button>
          </TooltipTrigger>
          <TooltipContent>Add to library</TooltipContent>
        </Tooltip>
      </ThemeProvider>,
    );
    expect(h.hasText("Add to library")).toBe(false);
    await h.hover("hover-me", true);
    expect(h.hasText("Add to library")).toBe(true);
    await h.hover("hover-me", false);
    expect(h.hasText("Add to library")).toBe(false);
    h.unmount();
  });
});

describe("HoverCard", () => {
  test("opens after its open delay on hover", async () => {
    const h = await mount(
      <ThemeProvider>
        <HoverCard openDelay={0} closeDelay={0}>
          <HoverCardTrigger asChild>
            <Button data-testid="card">@nextjs</Button>
          </HoverCardTrigger>
          <HoverCardContent>The React Framework</HoverCardContent>
        </HoverCard>
      </ThemeProvider>,
    );
    await h.hover("card", true);
    expect(h.hasText("The React Framework")).toBe(true);
    await h.hover("card", false);
    expect(h.hasText("The React Framework")).toBe(false);
    h.unmount();
  });
});

describe("ContextMenu", () => {
  test("opens at the pointer on right-click and an item fires", async () => {
    let chosen = "";
    const h = await mount(
      <ThemeProvider>
        <ContextMenu>
          <ContextMenuTrigger className="flex h-[150px] w-[300px]">
            Right click here
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              onSelect={() => {
                chosen = "back";
              }}
            >
              Back
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </ThemeProvider>,
    );
    expect(h.hasText("Back")).toBe(false);
    await h.contextMenu("context-menu-trigger", 120, 60);
    expect(h.hasText("Back")).toBe(true);
    await h.pressText("Back");
    expect(chosen).toBe("back");
    expect(h.hasText("Back")).toBe(false);
    h.unmount();
  });
});

describe("Menubar", () => {
  test("opens a menu on press and switches menus on hover", async () => {
    const h = await mount(
      <ThemeProvider>
        <Menubar>
          <MenubarMenu>
            <MenubarTrigger data-testid="file">File</MenubarTrigger>
            <MenubarContent>
              <MenubarItem>New Tab</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger data-testid="edit">Edit</MenubarTrigger>
            <MenubarContent>
              <MenubarItem>Undo</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>
      </ThemeProvider>,
    );
    await h.hover("edit", true);
    expect(h.hasText("Undo")).toBe(false);
    await h.press("file");
    expect(h.hasText("New Tab")).toBe(true);
    await h.hover("edit", true);
    expect(h.hasText("Undo")).toBe(true);
    expect(h.hasText("New Tab")).toBe(false);
    await h.press("menu-dismiss");
    expect(h.hasText("Undo")).toBe(false);
    h.unmount();
  });
});

describe("NavigationMenu", () => {
  test("opens content under a trigger on hover and switches", async () => {
    const h = await mount(
      <ThemeProvider>
        <NavigationMenu viewport={false}>
          <NavigationMenuList>
            <NavigationMenuItem>
              <NavigationMenuTrigger data-testid="home">Home</NavigationMenuTrigger>
              <NavigationMenuContent>Introduction</NavigationMenuContent>
            </NavigationMenuItem>
            <NavigationMenuItem>
              <NavigationMenuTrigger data-testid="components">Components</NavigationMenuTrigger>
              <NavigationMenuContent>Alert Dialog</NavigationMenuContent>
            </NavigationMenuItem>
          </NavigationMenuList>
        </NavigationMenu>
      </ThemeProvider>,
    );
    await h.hover("home", true);
    expect(h.hasText("Introduction")).toBe(true);
    await h.hover("components", true);
    expect(h.hasText("Alert Dialog")).toBe(true);
    expect(h.hasText("Introduction")).toBe(false);
    await h.press("menu-dismiss");
    expect(h.hasText("Alert Dialog")).toBe(false);
    h.unmount();
  });
});

describe("Command", () => {
  test("filters on typed input, shows Empty, and fires onSelect", async () => {
    const selected: string[] = [];
    const h = await mount(
      <ThemeProvider>
        <Command>
          <CommandInput data-testid="search" placeholder="Search..." />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup heading="Suggestions">
              <CommandItem data-testid="calendar" onSelect={(value) => selected.push(value)}>
                Calendar
              </CommandItem>
              <CommandItem data-testid="emoji" onSelect={(value) => selected.push(value)}>
                Search Emoji
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="Settings">
              <CommandItem keywords={["account"]} onSelect={(value) => selected.push(value)}>
                Profile
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </ThemeProvider>,
    );
    expect(h.hasText("No results found.")).toBe(false);
    // The first item is selected (data-selected=true → bg-accent).
    expect(byTestID(h, "calendar")?.props.background).toBe(darkTokens.accent);
    expect(byTestID(h, "emoji")?.props.background).toBeUndefined();
    await h.hover("emoji", true);
    expect(byTestID(h, "emoji")?.props.background).toBe(darkTokens.accent);
    expect(byTestID(h, "calendar")?.props.background).toBeUndefined();
    await h.type("search", "cal");
    expect(h.hasText("Calendar")).toBe(true);
    expect(h.hasText("Profile")).toBe(false);
    expect(h.hasText("Settings")).toBe(false);
    await h.type("search", "account");
    expect(h.hasText("Profile")).toBe(true);
    expect(h.hasText("Calendar")).toBe(false);
    await h.type("search", "zzz");
    expect(h.hasText("No results found.")).toBe(true);
    await h.type("search", "");
    await h.pressText("Search Emoji");
    expect(selected).toEqual(["Search Emoji"]);
    h.unmount();
  });
});

describe("Combobox", () => {
  test("the Popover + Command combobox picks an item", async () => {
    const h = await mount(
      <ThemeProvider>
        <ComboboxDemo />
      </ThemeProvider>,
    );
    await h.pressText("Select framework...");
    expect(h.hasText("SvelteKit")).toBe(true);
    await h.pressText("Remix");
    expect(h.hasText("SvelteKit")).toBe(false);
    expect(h.hasText("Remix")).toBe(true);
    expect(h.hasText("Select framework...")).toBe(false);
    h.unmount();
  });

  test("the Base UI combobox filters by typed text and picks an item", async () => {
    let picked: unknown = null;
    function Demo() {
      const [value, setValue] = useState<unknown>(null);
      return (
        <Combobox
          items={["Next.js", "SvelteKit", "Nuxt.js", "Remix"]}
          value={value}
          onValueChange={(next: unknown) => {
            picked = next;
            setValue(next);
          }}
        >
          <ComboboxInput data-testid="framework" placeholder="Select a framework" />
          <ComboboxContent>
            <ComboboxEmpty>No items found.</ComboboxEmpty>
            <ComboboxList>
              {(item: unknown) => (
                <ComboboxItem key={String(item)} value={item}>
                  {String(item)}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      );
    }
    const h = await mount(
      <ThemeProvider>
        <Demo />
      </ThemeProvider>,
    );
    await h.type("framework", "nu");
    expect(h.hasText("Nuxt.js")).toBe(true);
    expect(h.hasText("Remix")).toBe(false);
    await h.pressText("Nuxt.js");
    expect(picked).toBe("Nuxt.js");
    expect(h.texts()).toContain("Nuxt.js");
    expect(h.hasText("SvelteKit")).toBe(false);
    h.unmount();
  });
});

describe("Drawer", () => {
  test("opens as a bottom sheet and closes from DrawerClose and the scrim", async () => {
    const h = await mount(
      <ThemeProvider>
        <Drawer>
          <DrawerTrigger asChild>
            <Button data-testid="open">Open Drawer</Button>
          </DrawerTrigger>
          <DrawerContent>
            <DrawerTitle>Move Goal</DrawerTitle>
            <DrawerClose asChild>
              <Button data-testid="cancel">Cancel</Button>
            </DrawerClose>
          </DrawerContent>
        </Drawer>
      </ThemeProvider>,
    );
    await h.press("open");
    expect(h.hasText("Move Goal")).toBe(true);
    const content = byTestID(h, "drawer-content");
    expect(content?.props.absolute).toBe(true);
    expect(content?.props.bottom).toBe(0);
    expect(content?.props.left).toBe(0);
    expect(content?.props.right).toBe(0);
    await h.press("cancel");
    expect(h.hasText("Move Goal")).toBe(false);
    await h.press("open");
    await h.press("drawer-overlay");
    expect(h.hasText("Move Goal")).toBe(false);
    h.unmount();
  });
});

describe("sonner", () => {
  test("toast() shows without a mounted Toaster and toast.dismiss removes it", async () => {
    let id: string | number = "";
    const h = await mount(
      <ThemeProvider>
        <Button
          data-testid="show"
          onClick={() => {
            id = toast("Event has been created", {
              description: "Sunday, December 03, 2023 at 9:00 AM",
              action: { label: "Undo", onClick: () => {} },
            });
          }}
        >
          Show Toast
        </Button>
      </ThemeProvider>,
    );
    await h.press("show");
    expect(h.hasText("Event has been created")).toBe(true);
    expect(h.hasText("Sunday, December 03, 2023 at 9:00 AM")).toBe(true);
    toast.dismiss(id);
    await h.settle();
    expect(h.hasText("Event has been created")).toBe(false);
    h.unmount();
  });

  test("typed toasts render once with an explicit Toaster, and the action dismisses", async () => {
    let undone = 0;
    const h = await mount(
      <ThemeProvider>
        <Toaster />
      </ThemeProvider>,
    );
    toast.success("Saved", { action: { label: "Undo", onClick: () => undone++ } });
    await h.settle();
    expect(h.texts().filter((text) => text === "Saved")).toHaveLength(1);
    await h.pressText("Undo");
    expect(undone).toBe(1);
    expect(h.hasText("Saved")).toBe(false);
    h.unmount();
  });

  test("toast.promise moves from loading to success", async () => {
    const h = await mount(<ThemeProvider />);
    toast.promise(Promise.resolve({ name: "Event" }), {
      loading: "Loading...",
      success: (data: { name: string }) => `${data.name} has been created`,
      error: "Error",
    });
    await h.settle();
    expect(h.hasText("Event has been created")).toBe(true);
    h.unmount();
  });
});

/** Every overlay example opens its overlay through the harness without errors. */
describe("examples open their overlays", () => {
  const cases: Array<[string, (h: Awaited<ReturnType<typeof mount>>) => Promise<void>]> = [
    ["alert-dialog-demo", (h) => h.pressText("Show Dialog")],
    ["sheet-demo", (h) => h.pressText("Open")],
    ["sheet-side", (h) => h.pressText("left")],
    ["popover-demo", (h) => h.pressText("Open popover")],
    ["tooltip-demo", (h) => h.hover("tooltip-trigger", true)],
    [
      "hover-card-demo",
      async (h) => {
        await h.hover("hover-card-trigger", true);
        await Bun.sleep(800);
        await h.settle();
      },
    ],
    ["context-menu-demo", (h) => h.contextMenu("context-menu-trigger")],
    ["menubar-demo", (h) => h.pressText("File")],
    ["navigation-menu-demo", (h) => h.pressText("Home")],
    ["combobox-demo", (h) => h.pressText("Select framework...")],
    ["combobox-popover", (h) => h.pressText("+ Set status")],
    ["combobox-responsive", (h) => h.pressText("+ Set status")],
    [
      "combobox-dropdown-menu",
      async (h) => {
        await h.press("dropdown-menu-trigger");
        await h.hover("dropdown-menu-sub-trigger", true);
      },
    ],
    ["drawer-dialog", (h) => h.pressText("Edit Profile")],
    ["dialog-close-button", (h) => h.pressText("Share")],
    ["dropdown-menu-checkboxes", (h) => h.pressText("Open")],
    ["dropdown-menu-radio-group", (h) => h.pressText("Open")],
    ["sonner-demo", (h) => h.pressText("Show Toast")],
    ["sonner-types", (h) => h.pressText("Success")],
  ];
  for (const [name, act] of cases) {
    test(name, async () => {
      const errors: string[] = [];
      const original = console.error;
      console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
      try {
        const mod = await import(`../demo/examples/${name}.tsx`);
        const h = await mount(
          <ThemeProvider>
            <mod.default />
          </ThemeProvider>,
        );
        const before = h.texts().length;
        await act(h);
        const after = h.texts();
        expect(after.length).toBeGreaterThan(before);
        h.unmount();
      } finally {
        console.error = original;
      }
      expect(errors).toEqual([]);
    });
  }
});
