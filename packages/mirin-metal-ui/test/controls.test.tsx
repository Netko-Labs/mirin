import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { Checkbox } from "../src/components/checkbox.tsx";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "../src/components/input-otp.tsx";
import { Label } from "../src/components/label.tsx";
import { RadioGroup, RadioGroupItem } from "../src/components/radio-group.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../src/components/select.tsx";
import { Slider } from "../src/components/slider.tsx";
import { Switch } from "../src/components/switch.tsx";
import { ToggleGroup, ToggleGroupItem } from "../src/components/toggle-group.tsx";
import { ThemeProvider } from "../src/provider.tsx";
import { mount, type TreeNode } from "./harness.ts";

function count(node: TreeNode | string, predicate: (node: TreeNode) => boolean): number {
  if (typeof node === "string") return 0;
  return (
    (predicate(node) ? 1 : 0) +
    (node.children ?? []).reduce((sum, child) => sum + count(child, predicate), 0)
  );
}

const isSvg = (node: TreeNode) => node.type === "svg";

describe("Checkbox", () => {
  test("toggles and shows its indicator; a Label htmlFor toggles it too", async () => {
    const changes: unknown[] = [];
    const h = await mount(
      <ThemeProvider>
        <Checkbox id="terms" data-testid="box" onCheckedChange={(v) => changes.push(v)} />
        <Label htmlFor="terms" data-testid="label">
          Accept
        </Label>
      </ThemeProvider>,
    );
    expect(count(h.tree(), isSvg)).toBe(0);
    await h.press("box");
    expect(changes).toEqual([true]);
    expect(count(h.tree(), isSvg)).toBe(1);
    await h.press("label");
    expect(changes).toEqual([true, false]);
    expect(count(h.tree(), isSvg)).toBe(0);
    h.unmount();
  });
});

describe("RadioGroup", () => {
  test("selects one item at a time", async () => {
    const changes: string[] = [];
    const h = await mount(
      <ThemeProvider>
        <RadioGroup defaultValue="a" onValueChange={(v) => changes.push(v)}>
          <RadioGroupItem value="a" data-testid="a" />
          <RadioGroupItem value="b" data-testid="b" />
        </RadioGroup>
      </ThemeProvider>,
    );
    expect(count(h.tree(), isSvg)).toBe(1);
    await h.press("b");
    await h.press("b");
    expect(changes).toEqual(["b"]);
    expect(count(h.tree(), isSvg)).toBe(1);
    await h.press("a");
    expect(changes).toEqual(["b", "a"]);
    h.unmount();
  });
});

describe("Switch", () => {
  test("toggles checked state", async () => {
    const changes: boolean[] = [];
    const h = await mount(
      <ThemeProvider>
        <Switch data-testid="sw" onCheckedChange={(v) => changes.push(v)} />
      </ThemeProvider>,
    );
    await h.press("sw");
    await h.press("sw");
    expect(changes).toEqual([true, false]);
    h.unmount();
  });
});

describe("Select", () => {
  test("Value shows the selected item's text before and after choosing", async () => {
    const changes: string[] = [];
    const h = await mount(
      <ThemeProvider>
        <Select defaultValue="apple" onValueChange={(v) => changes.push(v)}>
          <SelectTrigger data-testid="trigger">
            <SelectValue placeholder="Pick a fruit" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="apple">Apple</SelectItem>
            <SelectItem value="banana">Banana</SelectItem>
          </SelectContent>
        </Select>
      </ThemeProvider>,
    );
    expect(h.hasText("Apple")).toBe(true);
    expect(h.hasText("Banana")).toBe(false);
    await h.press("trigger");
    expect(h.hasText("Banana")).toBe(true);
    await h.pressText("Banana");
    expect(changes).toEqual(["banana"]);
    expect(h.texts().filter((t) => t === "Banana")).toHaveLength(1);
    expect(h.hasText("Apple")).toBe(false);
    h.unmount();
  });

  test("shows the placeholder with no value", async () => {
    const h = await mount(
      <ThemeProvider>
        <Select>
          <SelectTrigger>
            <SelectValue placeholder="Pick a fruit" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="apple">Apple</SelectItem>
          </SelectContent>
        </Select>
      </ThemeProvider>,
    );
    expect(h.hasText("Pick a fruit")).toBe(true);
    h.unmount();
  });
});

describe("Slider", () => {
  test("pressing and dragging moves the nearest thumb, snapped to step", async () => {
    let latest: number[] = [];
    function Harnessed() {
      const [value, setValue] = useState([20, 80]);
      latest = value;
      return <Slider data-testid="slider" value={value} onValueChange={setValue} step={10} />;
    }
    const h = await mount(
      <ThemeProvider>
        <Harnessed />
      </ThemeProvider>,
    );
    const bounds = { x: 100, y: 0, width: 200, height: 16 };
    await h.pointer("slider", "down", 100 + 200 * 0.31, 8, bounds);
    expect(latest).toEqual([30, 80]);
    await h.pointer("slider", "move", 100 + 200 * 0.5, 8, bounds);
    expect(latest).toEqual([50, 80]);
    await h.pointer("slider", "up", 100 + 200 * 0.5, 8, bounds);
    await h.pointer("slider", "move", 100 + 200 * 0.9, 8, bounds);
    expect(latest).toEqual([50, 80]);
    await h.pointer("slider", "down", 100 + 200 * 0.95, 8, bounds);
    expect(latest).toEqual([50, 100]);
    h.unmount();
  });

  test("vertical sliders measure from the bottom", async () => {
    const changes: number[][] = [];
    const h = await mount(
      <ThemeProvider>
        <Slider
          data-testid="slider"
          orientation="vertical"
          defaultValue={[0]}
          onValueChange={(v) => changes.push(v)}
        />
      </ThemeProvider>,
    );
    await h.pointer("slider", "down", 8, 25, { x: 0, y: 0, width: 16, height: 100 });
    expect(changes).toEqual([[75]]);
    h.unmount();
  });
});

describe("ToggleGroup", () => {
  test("single keeps one value and can clear it", async () => {
    const changes: string[] = [];
    const h = await mount(
      <ThemeProvider>
        <ToggleGroup type="single" onValueChange={(v: string) => changes.push(v)}>
          <ToggleGroupItem value="a" data-testid="a">
            A
          </ToggleGroupItem>
          <ToggleGroupItem value="b" data-testid="b">
            B
          </ToggleGroupItem>
        </ToggleGroup>
      </ThemeProvider>,
    );
    await h.press("a");
    await h.press("b");
    await h.press("b");
    expect(changes).toEqual(["a", "b", ""]);
    h.unmount();
  });

  test("multiple toggles each value independently", async () => {
    const changes: string[][] = [];
    const h = await mount(
      <ThemeProvider>
        <ToggleGroup type="multiple" onValueChange={(v: string[]) => changes.push(v)}>
          <ToggleGroupItem value="a" data-testid="a">
            A
          </ToggleGroupItem>
          <ToggleGroupItem value="b" data-testid="b">
            B
          </ToggleGroupItem>
        </ToggleGroup>
      </ThemeProvider>,
    );
    await h.press("a");
    await h.press("b");
    await h.press("a");
    expect(changes).toEqual([["a"], ["a", "b"], ["b"]]);
    h.unmount();
  });
});

describe("InputOTP", () => {
  test("typing fills the slots, respects maxLength and pattern, and completes", async () => {
    const completed: string[] = [];
    const h = await mount(
      <ThemeProvider>
        <InputOTP maxLength={4} pattern="^\d+$" onComplete={(v) => completed.push(v)}>
          <InputOTPGroup>
            <InputOTPSlot index={0} />
            <InputOTPSlot index={1} />
            <InputOTPSlot index={2} />
            <InputOTPSlot index={3} />
          </InputOTPGroup>
        </InputOTP>
      </ThemeProvider>,
    );
    await h.type("input-otp", "12");
    expect(h.texts()).toEqual(expect.arrayContaining(["1", "2"]));
    await h.type("input-otp", "12a");
    expect(h.hasText("a")).toBe(false);
    await h.type("input-otp", "123456");
    expect(h.texts()).toEqual(expect.arrayContaining(["1", "2", "3", "4"]));
    expect(h.hasText("5")).toBe(false);
    expect(completed).toEqual(["1234"]);
    h.unmount();
  });
});
