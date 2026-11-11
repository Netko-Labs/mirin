/**
 * recharts' declarative parts. `Bar`, `XAxis`, `YAxis`, `CartesianGrid`,
 * `Tooltip`, `Legend`, `LabelList`, and `Cell` render nothing themselves:
 * `BarChart` reads their props and draws. `ResponsiveContainer` measures
 * its box and hands the size to the chart inside.
 */

import type { Bounds } from "@mirinjs/metal";
import { createContext, type ReactNode, useState } from "react";
import { Box } from "../runtime/box.tsx";
import type {
  AxisProps,
  BarProps,
  CartesianGridProps,
  LabelListProps,
  LegendProps,
  TooltipProps,
} from "./types.ts";

export interface Size {
  width: number;
  height: number;
}

/** The measured size of the nearest `ResponsiveContainer`. */
export const ContainerSize = createContext<Size | null>(null);

export function ResponsiveContainer({
  width = "100%",
  height = "100%",
  initialDimension = { width: 320, height: 200 },
  minHeight,
  aspect: _aspect,
  children,
}: {
  width?: number | `${number}%`;
  height?: number | `${number}%`;
  initialDimension?: Size;
  minWidth?: number;
  minHeight?: number;
  aspect?: number;
  debounce?: number;
  className?: string;
  children?: ReactNode;
}) {
  const [size, setSize] = useState<Size>(initialDimension);
  return (
    <Box
      className="recharts-responsive-container"
      viewStyle={{ width, height, minHeight, flexDirection: "column" }}
      onLayout={(bounds: Bounds) =>
        setSize((current) =>
          current.width === bounds.width && current.height === bounds.height
            ? current
            : { width: bounds.width, height: bounds.height },
        )
      }
    >
      <ContainerSize.Provider value={size}>{children}</ContainerSize.Provider>
    </Box>
  );
}

export function Bar(_props: BarProps): ReactNode {
  return null;
}
export function XAxis(_props: AxisProps): ReactNode {
  return null;
}
export function YAxis(_props: AxisProps): ReactNode {
  return null;
}
export function CartesianGrid(_props: CartesianGridProps): ReactNode {
  return null;
}
export function Tooltip(_props: TooltipProps): ReactNode {
  return null;
}
export function Legend(_props: LegendProps): ReactNode {
  return null;
}
export function LabelList(_props: LabelListProps): ReactNode {
  return null;
}
/** Per-datum override inside a `Bar` (`<Cell fill={…} />`). */
export function Cell(_props: { fill?: string; [prop: string]: unknown }): ReactNode {
  return null;
}

/** A filled rectangle (recharts' shape primitive), drawn as a box. */
export function Rectangle({
  width = 0,
  height = 0,
  fill,
  radius = 0,
  fillOpacity,
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  radius?: number | number[];
  fillOpacity?: number;
  [prop: string]: unknown;
}): ReactNode {
  return (
    <Box
      viewStyle={{
        width,
        height,
        backgroundColor: fill,
        borderRadius: Array.isArray(radius) ? radius[0] : radius,
        opacity: fillOpacity,
      }}
    />
  );
}
