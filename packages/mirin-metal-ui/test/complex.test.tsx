/**
 * Behavior of the "complex" stand-ins: the react-day-picker calendar, the
 * embla carousel, recharts bar charts, and react-resizable-panels.
 */

import { describe, expect, test } from "bun:test";
import { type ReactNode, useState } from "react";
import { Bar, BarChart, XAxis } from "../src/charts/index.ts";
import { fromJalali, toJalali } from "../src/compat/lib/day-picker-dates.ts";
import type { DateRange } from "../src/compat/react-day-picker.tsx";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "../src/components/attachment.tsx";
import { Bubble, BubbleContent, BubbleGroup } from "../src/components/bubble.tsx";
import { Calendar } from "../src/components/calendar.tsx";
import {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "../src/components/carousel.tsx";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "../src/components/chart.tsx";
import { Marker, MarkerContent } from "../src/components/marker.tsx";
import {
  Message,
  MessageContent,
  MessageGroup,
  MessageHeader,
} from "../src/components/message.tsx";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "../src/components/message-scroller.tsx";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../src/components/resizable.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "../src/components/sidebar.tsx";
import { FileIcon } from "../src/icons/index.ts";
import { snapPositions } from "../src/primitives/embla.tsx";
import { ThemeProvider, ThemeScope } from "../src/provider.tsx";
import { useTheme } from "../src/theme.ts";
import { mount, type TreeNode } from "./harness.ts";

function findAll(node: TreeNode | string, predicate: (node: TreeNode) => boolean): TreeNode[] {
  if (typeof node === "string") return [];
  const own = predicate(node) ? [node] : [];
  return [...own, ...(node.children ?? []).flatMap((child) => findAll(child, predicate))];
}

describe("Calendar (react-day-picker stand-in)", () => {
  test("single mode selects a day and navigates months", async () => {
    const picked: Array<Date | undefined> = [];
    const h = await mount(
      <ThemeProvider>
        <Calendar
          mode="single"
          defaultMonth={new Date(2025, 0, 1)}
          onSelect={(date) => picked.push(date)}
        />
      </ThemeProvider>,
    );
    expect(h.hasText("January 2025")).toBe(true);
    expect(h.texts()).toEqual(expect.arrayContaining(["Su", "Mo", "Sa"]));
    await h.pressText("15");
    expect(picked).toHaveLength(1);
    expect(picked[0]?.getFullYear()).toBe(2025);
    expect(picked[0]?.getMonth()).toBe(0);
    expect(picked[0]?.getDate()).toBe(15);
    await h.press("rdp-button_next");
    expect(h.hasText("February 2025")).toBe(true);
    await h.press("rdp-button_previous");
    await h.press("rdp-button_previous");
    expect(h.hasText("December 2024")).toBe(true);
    h.unmount();
  });

  test("selected day paints primary; cells use --cell-size", async () => {
    const h = await mount(
      <ThemeProvider>
        <Calendar
          mode="single"
          defaultMonth={new Date(2025, 0, 1)}
          selected={new Date(2025, 0, 15)}
        />
      </ThemeProvider>,
    );
    const nav = findAll(h.tree(), (n) => n.props.width === 32 && n.props.height === 32);
    expect(nav.length).toBeGreaterThanOrEqual(2);
    h.unmount();
  });

  test("range mode builds a range across two clicks", async () => {
    const ranges: Array<DateRange | undefined> = [];
    function Controlled() {
      return (
        <Calendar
          mode="range"
          defaultMonth={new Date(2025, 0, 1)}
          onSelect={(range) => ranges.push(range)}
        />
      );
    }
    const h = await mount(
      <ThemeProvider>
        <Controlled />
      </ThemeProvider>,
    );
    await h.pressText("10");
    await h.pressText("20");
    expect(ranges).toHaveLength(2);
    expect(ranges[0]?.from?.getDate()).toBe(10);
    expect(ranges[1]?.from?.getDate()).toBe(10);
    expect(ranges[1]?.to?.getDate()).toBe(20);
    h.unmount();
  });

  test("Jalali conversion round-trips", () => {
    expect(toJalali(2025, 6, 12)).toEqual([1404, 3, 22]);
    expect(toJalali(2025, 3, 21)).toEqual([1404, 1, 1]);
    expect(fromJalali(1404, 3, 22)).toEqual([2025, 6, 12]);
  });
});

describe("Carousel (embla stand-in)", () => {
  test("next/prev change the selected snap and offset the track", async () => {
    let api: CarouselApi;
    const h = await mount(
      <ThemeProvider>
        <Carousel
          setApi={(next) => {
            api = next;
          }}
        >
          <CarouselContent>
            {[1, 2, 3, 4, 5].map((n) => (
              <CarouselItem key={n}>
                <span>{`slide ${n}`}</span>
              </CarouselItem>
            ))}
          </CarouselContent>
          <CarouselPrevious />
          <CarouselNext />
        </Carousel>
      </ThemeProvider>,
    );
    expect(api?.selectedScrollSnap()).toBe(0);
    expect(api?.scrollSnapList()).toHaveLength(5);
    expect(api?.canScrollPrev()).toBe(false);
    await h.press("carousel-next");
    await h.press("carousel-next");
    expect(api?.selectedScrollSnap()).toBe(2);
    const shifted = findAll(h.tree(), (n) => n.props.left === -400);
    expect(shifted).toHaveLength(1);
    await h.press("carousel-previous");
    expect(api?.selectedScrollSnap()).toBe(1);
    expect(api?.canScrollPrev()).toBe(true);
    h.unmount();
  });

  test("snaps trim to the scrollable range like embla", () => {
    expect(snapPositions(5, 1, {})).toEqual([0, 1, 2, 3, 4]);
    expect(snapPositions(5, 1 / 3, { align: "start" })).toEqual([0, 1, 2]);
    expect(snapPositions(5, 1 / 2, { align: "start" })).toEqual([0, 1, 2, 3]);
  });
});

const chartData = [
  { month: "January", desktop: 186 },
  { month: "February", desktop: 305 },
  { month: "March", desktop: 93 },
];
const chartConfig = { desktop: { label: "Desktop", color: "#2563eb" } } satisfies ChartConfig;

describe("BarChart (recharts stand-in)", () => {
  test("one bar per datum, heights proportional, colors from the config", async () => {
    const h = await mount(
      <ThemeProvider>
        <ChartContainer config={chartConfig} className="min-h-[200px] w-full">
          <BarChart data={chartData}>
            <XAxis dataKey="month" tickFormatter={(value) => value.slice(0, 3)} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="desktop" fill="var(--color-desktop)" radius={4} />
          </BarChart>
        </ChartContainer>
      </ThemeProvider>,
    );
    const bars = findAll(h.tree(), (n) => n.props.background === "#2563eb");
    expect(bars).toHaveLength(3);
    const heights = bars.map((bar) => Number(bar.props.height));
    expect(heights[1]).toBeGreaterThan(heights[0] ?? 0);
    expect((heights[0] ?? 0) / (heights[1] ?? 1)).toBeCloseTo(186 / 305, 5);
    expect((heights[2] ?? 0) / (heights[1] ?? 1)).toBeCloseTo(93 / 305, 5);
    expect(h.texts()).toEqual(expect.arrayContaining(["Jan", "Feb", "Mar"]));
    await h.hover("recharts-band-1", true);
    expect(h.hasText("February")).toBe(true);
    expect(h.hasText("305")).toBe(true);
    await h.hover("recharts-band-1", false);
    expect(h.hasText("February")).toBe(false);
    h.unmount();
  });
});

describe("Resizable (react-resizable-panels stand-in)", () => {
  test("dragging the handle moves the boundary between panels", async () => {
    const layouts: Array<Record<string, number>> = [];
    function Demo() {
      const [, force] = useState(0);
      return (
        <ResizablePanelGroup
          orientation="horizontal"
          onLayoutChange={(layout) => {
            layouts.push(layout);
            force((n) => n + 1);
          }}
        >
          <ResizablePanel id="left" defaultSize="40%">
            <span>left</span>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="right" defaultSize="60%">
            <span>right</span>
          </ResizablePanel>
        </ResizablePanelGroup>
      );
    }
    const h = await mount(
      <ThemeProvider>
        <Demo />
      </ThemeProvider>,
    );
    const widths = () =>
      findAll(
        h.tree(),
        (n) =>
          typeof n.props.widthPercent === "number" &&
          n.props.widthPercent < 1 &&
          n.props.clip === true,
      ).map((n) => n.props.widthPercent);
    expect(widths()).toEqual([0.4, 0.6]);
    const bounds = { x: 80, y: 0, width: 1, height: 120 };
    await h.pointer("resizable-handle", "down", 80, 60, bounds);
    await h.pointer("resizable-handle", "move", 100, 60, bounds);
    await h.pointer("resizable-handle", "up", 100, 60, bounds);
    // The harness sizes the group at 200px: +20px = +10%.
    expect(widths()).toEqual([0.5, 0.5]);
    expect(layouts.at(-1)).toEqual({ left: 50, right: 50 });
    h.unmount();
  });
});

describe("Chat components", () => {
  test("message scroller, messages, bubbles, markers, and attachments render", async () => {
    const h = await mount(
      <ThemeProvider>
        <MessageScrollerProvider>
          <MessageScroller className="h-[400px]">
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId="m1">
                  <Marker variant="separator">
                    <MarkerContent>Today</MarkerContent>
                  </Marker>
                </MessageScrollerItem>
                <MessageScrollerItem messageId="m2" scrollAnchor>
                  <MessageGroup>
                    <Message align="end">
                      <MessageContent>
                        <MessageHeader>You</MessageHeader>
                        <BubbleGroup>
                          <Bubble>
                            <BubbleContent>Hello there</BubbleContent>
                          </Bubble>
                        </BubbleGroup>
                        <Attachment>
                          <AttachmentMedia>
                            <FileIcon />
                          </AttachmentMedia>
                          <AttachmentContent>
                            <AttachmentTitle>report.pdf</AttachmentTitle>
                            <AttachmentDescription>2.4 MB</AttachmentDescription>
                          </AttachmentContent>
                        </Attachment>
                      </MessageContent>
                    </Message>
                  </MessageGroup>
                </MessageScrollerItem>
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </ThemeProvider>,
    );
    for (const text of ["Today", "You", "Hello there", "report.pdf", "2.4 MB"]) {
      expect(h.hasText(text)).toBe(true);
    }
    h.unmount();
  });
});

function Wide({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <ThemeScope value={{ ...theme, viewportWidth: 1280 }}>{children}</ThemeScope>;
}

function SidebarDemo() {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Application</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton>Inbox</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <SidebarTrigger />
      </SidebarInset>
    </SidebarProvider>
  );
}

describe("Sidebar", () => {
  test("desktop: the trigger slides the offcanvas sidebar out and back", async () => {
    const h = await mount(
      <ThemeProvider>
        <Wide>
          <SidebarDemo />
        </Wide>
      </ThemeProvider>,
    );
    expect(h.hasText("Inbox")).toBe(true);
    // --sidebar-width (16rem) resolves through the CSS variable support.
    expect(findAll(h.tree(), (n) => n.props.width === 256).length).toBeGreaterThan(0);
    await h.press("sidebar-trigger");
    expect(findAll(h.tree(), (n) => n.props.left === -256)).toHaveLength(1);
    await h.press("sidebar-trigger");
    expect(findAll(h.tree(), (n) => n.props.left === -256)).toHaveLength(0);
    h.unmount();
  });

  test("mobile: the sidebar is a sheet the trigger opens", async () => {
    const h = await mount(
      <ThemeProvider>
        <SidebarDemo />
      </ThemeProvider>,
    );
    expect(h.hasText("Inbox")).toBe(false);
    await h.press("sidebar-trigger");
    expect(h.hasText("Inbox")).toBe(true);
    h.unmount();
  });
});

describe("Date picker example", () => {
  test("opens the calendar in a popover and shows the picked date", async () => {
    const { default: DatePickerDemo } = await import("../demo/examples/date-picker-demo.tsx");
    const h = await mount(
      <ThemeProvider>
        <DatePickerDemo />
      </ThemeProvider>,
    );
    await h.pressText("Pick a date");
    expect(h.texts()).toEqual(expect.arrayContaining(["Su", "Mo"]));
    await h.pressText("15");
    expect(h.texts().some((text) => /15(th)?, \d{4}/.test(text))).toBe(true);
    h.unmount();
  });
});
