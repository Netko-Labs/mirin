/**
 * Radix `Slider` on Metal: one or more thumbs over a track. Pressing the
 * root moves the nearest thumb to the pointer and dragging keeps moving it
 * (pointer moves keep arriving after the pointer leaves the element).
 * Supports `min`/`max`/`step`, controlled and uncontrolled values, and
 * `orientation="vertical"` (bottom is `min`, like Radix).
 */

import { View } from "@mirinjs/metal";
import { Children, createContext, isValidElement, type ReactNode, useContext, useRef } from "react";
import { Slot } from "../lib/slot.tsx";
import { useControllableState } from "../lib/state.ts";
import type { SyntheticEvent } from "../runtime/events.ts";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

type Orientation = "horizontal" | "vertical";

interface SliderApi {
  values: number[];
  min: number;
  max: number;
  orientation: Orientation;
  disabled: boolean;
}

const SliderContext = createContext<SliderApi>({
  values: [],
  min: 0,
  max: 100,
  orientation: "horizontal",
  disabled: false,
});
const ThumbIndexContext = createContext(0);

/** Thumb size the in-bounds offset assumes (shadcn's `size-4`). */
const THUMB = 16;

function percent(value: number, min: number, max: number): number {
  return max === min ? 0 : ((value - min) / (max - min)) * 100;
}

function snap(raw: number, min: number, max: number, step: number): number {
  const stepped = Math.round((raw - min) / step) * step + min;
  const decimals = (String(step).split(".")[1] ?? "").length;
  return Math.min(max, Math.max(min, Number(stepped.toFixed(decimals))));
}

export interface RootProps extends Props {
  value?: number[];
  defaultValue?: number[];
  onValueChange?: (value: number[]) => void;
  onValueCommit?: (value: number[]) => void;
  min?: number;
  max?: number;
  step?: number;
  minStepsBetweenThumbs?: number;
  orientation?: Orientation;
  disabled?: boolean;
  inverted?: boolean;
}

function Root({
  asChild,
  value,
  defaultValue,
  onValueChange,
  onValueCommit,
  min = 0,
  max = 100,
  step = 1,
  minStepsBetweenThumbs = 0,
  orientation = "horizontal",
  disabled = false,
  inverted = false,
  name: _n,
  dir: _d,
  children,
  ...props
}: RootProps) {
  const [values, setValues] = useControllableState<number[]>({
    prop: value,
    defaultProp: defaultValue ?? [min],
    onChange: onValueChange,
  });
  const active = useRef<number | null>(null);
  const vertical = orientation === "vertical";

  const valueAt = (event: SyntheticEvent): number => {
    const rect = event.target.getBoundingClientRect();
    let ratio = vertical
      ? rect.height > 0
        ? (rect.y + rect.height - event.clientY) / rect.height
        : 0
      : rect.width > 0
        ? (event.clientX - rect.x) / rect.width
        : 0;
    if (inverted) ratio = 1 - ratio;
    return snap(min + Math.min(1, Math.max(0, ratio)) * (max - min), min, max, step);
  };

  const moveTo = (index: number, next: number) => {
    const gap = minStepsBetweenThumbs * step;
    const lower = index > 0 ? (values[index - 1] ?? min) + gap : min;
    const upper = index < values.length - 1 ? (values[index + 1] ?? max) - gap : max;
    const clamped = Math.min(upper, Math.max(lower, next));
    if (values[index] === clamped) return;
    setValues(values.map((v, i) => (i === index ? clamped : v)));
  };

  // Number the thumbs in render order, like Radix's collection.
  let thumbIndex = 0;
  const numbered = Children.map(children, (child) => {
    if (isValidElement(child) && child.type === Thumb) {
      const index = thumbIndex++;
      return <ThumbIndexContext.Provider value={index}>{child}</ThumbIndexContext.Provider>;
    }
    return child;
  });

  const shared: Props = {
    ...props,
    "data-orientation": orientation,
    "data-disabled": disabled ? "" : undefined,
    "aria-disabled": disabled ? "true" : undefined,
    onPointerDown: (event: SyntheticEvent) => {
      if (disabled) return;
      const next = valueAt(event);
      const nearest = values.reduce(
        (best, v, i) => (Math.abs(v - next) < Math.abs((values[best] ?? 0) - next) ? i : best),
        0,
      );
      active.current = nearest;
      moveTo(nearest, next);
    },
    onPointerMove: (event: SyntheticEvent) => {
      if (active.current === null) return;
      moveTo(active.current, valueAt(event));
    },
    onPointerUp: () => {
      if (active.current === null) return;
      active.current = null;
      onValueCommit?.(values);
    },
  };
  return (
    <SliderContext.Provider value={{ values, min, max, orientation, disabled }}>
      {asChild ? <Slot {...shared}>{numbered}</Slot> : <span {...shared}>{numbered}</span>}
    </SliderContext.Provider>
  );
}

function Track({ asChild, ...props }: Props) {
  const slider = useContext(SliderContext);
  const shared: Props = {
    ...props,
    "data-orientation": slider.orientation,
    "data-disabled": slider.disabled ? "" : undefined,
    // metal: the range is laid out in flow (see Range), along the track.
    viewStyle: { flexDirection: slider.orientation === "vertical" ? "column" : "row" },
  };
  return asChild ? <Slot {...shared} /> : <span {...shared} />;
}

/** The filled part of the track, between the lowest and highest thumb. */
function Range({ asChild, className, ...props }: Props) {
  const slider = useContext(SliderContext);
  const { values, min, max } = slider;
  const vertical = slider.orientation === "vertical";
  const lo = values.length > 1 ? percent(Math.min(...values), min, max) : 0;
  const hi = percent(Math.max(...values, min), min, max);
  // metal: Radix places the range with absolute `left`/`right` percentages;
  // Metal offsets take pixels only, so a spacer leads it in flow instead.
  const lead = vertical ? 100 - hi : lo;
  const size = `${Math.max(0, hi - lo)}%` as const;
  const shared: Props = {
    ...props,
    className: (className ?? "").replace(/(^|\s)absolute(?=\s|$)/, " "),
    "data-orientation": slider.orientation,
    "data-disabled": slider.disabled ? "" : undefined,
    viewStyle: vertical ? { height: size, flexShrink: 0 } : { width: size, flexShrink: 0 },
  };
  return (
    <>
      <View
        style={
          vertical
            ? { height: `${lead}%`, flexShrink: 0 }
            : { width: `${lead}%`, flexShrink: 0, height: "100%" }
        }
      />
      {asChild ? <Slot {...shared} /> : <span {...shared} />}
    </>
  );
}

function Thumb({ asChild, ...props }: Props) {
  const slider = useContext(SliderContext);
  const index = useContext(ThumbIndexContext);
  const { values, min, max } = slider;
  const value = values[index];
  if (value === undefined) return null;
  const vertical = slider.orientation === "vertical";
  const at = percent(value, min, max);
  // Radix keeps the thumb inside the track: offset by half a thumb at the ends.
  const inBounds = THUMB / 2 - (THUMB * at) / 100;
  const shared: Props = {
    ...props,
    role: "slider",
    "aria-valuemin": min,
    "aria-valuemax": max,
    "aria-valuenow": value,
    "aria-orientation": slider.orientation,
    "data-orientation": slider.orientation,
    "data-disabled": slider.disabled ? "" : undefined,
  };
  const thumb = asChild ? <Slot {...shared} /> : <span {...shared} />;
  // metal: a full-size layer per thumb: a spacer to the value's position,
  // then a zero-size holder that centers the thumb on that point.
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        flexDirection: vertical ? "column" : "row",
      }}
    >
      <View
        style={
          vertical ? { height: `${100 - at}%`, flexShrink: 0 } : { width: `${at}%`, flexShrink: 0 }
        }
      />
      <View
        style={{
          ...(vertical
            ? { height: 0, width: "100%", marginTop: -inBounds }
            : { width: 0, height: "100%", marginLeft: inBounds }),
          flexShrink: 0,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {thumb}
      </View>
    </View>
  );
}

export const Slider = { Root, Track, Range, Thumb };
