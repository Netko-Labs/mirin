import type { CSSProperties } from "react";
/** Prop and payload types of the recharts subset (shapes follow recharts 3). */

import type { ReactElement, ReactNode } from "react";

export type TooltipValueType = number | string | Array<number | string>;
export type NameType = number | string;
type Datum = Record<string, unknown>;

export interface TooltipPayloadItem<V = TooltipValueType, N = NameType> {
  dataKey?: string | number;
  name?: N;
  value?: V;
  color?: string;
  fill?: string;
  type?: "none" | string;
  unit?: ReactNode;
  // biome-ignore lint/suspicious/noExplicitAny: type-only; recharts types the datum as any so callers can read `item.payload.fill` without narrowing.
  payload?: any;
}

export type Formatter<V = TooltipValueType, N = NameType> = (
  value: V,
  name: N,
  item: TooltipPayloadItem<V, N>,
  index: number,
  payload: Datum,
) => ReactNode | [ReactNode, ReactNode];

export interface DefaultTooltipContentProps<V = TooltipValueType, N = NameType> {
  active?: boolean;
  payload?: Array<TooltipPayloadItem<V, N>>;
  label?: string | number;
  labelFormatter?: (label: ReactNode, payload: Array<TooltipPayloadItem<V, N>>) => ReactNode;
  formatter?: Formatter<V, N>;
  separator?: string;
  labelClassName?: string;
  wrapperClassName?: string;
  contentStyle?: Record<string, unknown>;
  itemStyle?: Record<string, unknown>;
  labelStyle?: Record<string, unknown>;
  accessibilityLayer?: boolean;
  coordinate?: { x: number; y: number };
}

export type ContentType<P> = ReactElement | ((props: P) => ReactNode);

export interface TooltipProps<V = TooltipValueType, N = NameType>
  extends DefaultTooltipContentProps<V, N> {
  content?: ContentType<DefaultTooltipContentProps<V, N>>;
  cursor?: boolean | Record<string, unknown> | ReactElement;
  defaultIndex?: number;
  offset?: number;
  animationDuration?: number;
  isAnimationActive?: boolean;
}

export interface LegendPayload {
  value?: ReactNode;
  dataKey?: string | number;
  color?: string;
  type?: "none" | string;
  id?: string;
  // biome-ignore lint/suspicious/noExplicitAny: type-only, mirrors recharts' `payload?: any`.
  payload?: any;
}

export interface DefaultLegendContentProps {
  payload?: LegendPayload[];
  verticalAlign?: "top" | "middle" | "bottom";
  align?: "left" | "center" | "right";
  layout?: "horizontal" | "vertical";
}

export interface LegendProps extends DefaultLegendContentProps {
  content?: ContentType<DefaultLegendContentProps>;
  height?: number;
  iconType?: string;
}

export interface LabelListProps {
  dataKey?: string;
  position?:
    | "top"
    | "bottom"
    | "inside"
    | "insideTop"
    | "insideBottom"
    | "center"
    | "right"
    | "left";
  offset?: number;
  className?: string;
  fontSize?: number;
  fill?: string;
  formatter?: (value: unknown) => ReactNode;
}

export interface BarProps {
  dataKey: string;
  name?: string;
  fill?: string;
  radius?: number | [number, number, number, number];
  stackId?: string | number;
  style?: CSSProperties | Record<string, unknown>;
  hide?: boolean;
  children?: ReactNode;
  [prop: string]: unknown;
}

export interface AxisProps {
  dataKey?: string;
  hide?: boolean;
  tickLine?: boolean;
  axisLine?: boolean;
  tickMargin?: number;
  // biome-ignore lint/suspicious/noExplicitAny: type-only; recharts passes the raw tick as any so `(value) => value.slice(0, 3)` type-checks.
  tickFormatter?: (value: any, index: number) => string;
  width?: number;
  height?: number;
  tickCount?: number;
  domain?: [number | "auto" | "dataMin" | "dataMax", number | "auto" | "dataMin" | "dataMax"];
  type?: "number" | "category";
  [prop: string]: unknown;
}

export interface CartesianGridProps {
  vertical?: boolean;
  horizontal?: boolean;
  strokeDasharray?: string;
  [prop: string]: unknown;
}
