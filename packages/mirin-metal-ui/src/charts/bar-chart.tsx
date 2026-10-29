/**
 * recharts' `BarChart` drawn with Metal views: one band per datum, one box
 * per `Bar` sized by value against "nice" y ticks, grid lines as 1px views,
 * axis ticks as text, and the `Tooltip` content shown for the hovered band.
 * Colors such as `var(--color-desktop)` resolve through the CSS variables
 * `ChartContainer` defines.
 */

import type { Bounds } from "@mirinjs/metal";
import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useState,
} from "react";
import { Box } from "../runtime/box.tsx";
import { VarsContext } from "../runtime/vars.ts";
import { useTheme } from "../theme.ts";
import {
  Bar,
  CartesianGrid,
  Cell,
  ContainerSize,
  LabelList,
  Legend,
  Tooltip,
  XAxis,
  YAxis,
} from "./components.tsx";
import { niceTicks, resolveColor } from "./scale.ts";
import type {
  AxisProps,
  BarProps,
  CartesianGridProps,
  ContentType,
  LabelListProps,
  LegendPayload,
  LegendProps,
  TooltipPayloadItem,
  TooltipProps,
} from "./types.ts";

type Datum = Record<string, unknown>;

export interface BarChartProps {
  data?: Datum[];
  width?: number;
  height?: number;
  margin?: { top?: number; right?: number; bottom?: number; left?: number };
  barGap?: number;
  barCategoryGap?: number | `${number}%`;
  layout?: "horizontal" | "vertical";
  accessibilityLayer?: boolean;
  className?: string;
  children?: ReactNode;
  [prop: string]: unknown;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function propsOf<P>(items: ReactElement[], type: unknown): P | undefined {
  const found = items.find((item) => item.type === type);
  return found ? (found.props as P) : undefined;
}

function renderContent<P extends object>(
  content: ContentType<P> | undefined,
  props: P,
  fallback: (props: P) => ReactNode,
): ReactNode {
  if (isValidElement(content)) return cloneElement(content, props as Record<string, unknown>);
  if (typeof content === "function") return content(props);
  return fallback(props);
}

function DefaultTooltip({ payload, label }: { payload?: TooltipPayloadItem[]; label?: unknown }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <span className="font-medium">{String(label ?? "")}</span>
      {(payload ?? []).map((item) => (
        <span key={String(item.dataKey)}>{`${String(item.name)} : ${String(item.value)}`}</span>
      ))}
    </div>
  );
}

function DefaultLegend({ payload }: { payload?: LegendPayload[] }) {
  return (
    <div className="flex items-center justify-center gap-4 pt-3">
      {(payload ?? []).map((item) => (
        <div key={String(item.dataKey)} className="flex items-center gap-1.5">
          <Box viewStyle={{ width: 8, height: 8, backgroundColor: item.color }} />
          <span>{String(item.value ?? "")}</span>
        </div>
      ))}
    </div>
  );
}

const Y_AXIS_WIDTH = 60;
const X_AXIS_HEIGHT = 30;

export function BarChart({
  data = [],
  width,
  height,
  margin = {},
  barGap = 4,
  barCategoryGap = "10%",
  children,
}: BarChartProps): ReactNode {
  const theme = useTheme();
  const vars = useContext(VarsContext);
  const container = useContext(ContainerSize);
  const [plot, setPlot] = useState<Bounds | null>(null);
  const [active, setActive] = useState<{ index: number; bounds?: Bounds } | null>(null);

  const items = Children.toArray(children).filter(isValidElement) as ReactElement[];
  const barElements = items.filter((item) => item.type === Bar);
  const bars = barElements.map((item) => item.props as BarProps).filter((bar) => !bar.hide);
  const xAxis = propsOf<AxisProps>(items, XAxis);
  const yAxis = propsOf<AxisProps>(items, YAxis);
  const grid = propsOf<CartesianGridProps>(items, CartesianGrid);
  const tooltip = propsOf<TooltipProps>(items, Tooltip);
  const legend = propsOf<LegendProps>(items, Legend);

  const fills = bars.map(
    (bar) =>
      resolveColor(bar.fill ?? bar.style?.fill, vars, theme.colors) ?? theme.colors.foreground,
  );
  // Bars sharing a `stackId` stack in one column; others get their own.
  const stacks: number[][] = [];
  const stackOf = new Map<string, number[]>();
  bars.forEach((bar, index) => {
    const key = bar.stackId === undefined ? undefined : String(bar.stackId);
    const existing = key === undefined ? undefined : stackOf.get(key);
    if (existing) existing.push(index);
    else {
      const stack = [index];
      stacks.push(stack);
      if (key !== undefined) stackOf.set(key, stack);
    }
  });
  const max = Math.max(
    0,
    ...data.map((datum) =>
      Math.max(
        0,
        ...stacks.map((stack) =>
          stack.reduce((sum, i) => sum + number(datum[bars[i]?.dataKey ?? ""]), 0),
        ),
      ),
    ),
  );
  const ticks = niceTicks(max, yAxis?.tickCount ?? 5);
  const top = ticks[ticks.length - 1] || 1;

  const showY = yAxis !== undefined && !yAxis.hide;
  const showX = xAxis !== undefined && !xAxis.hide;
  const yWidth = showY ? (yAxis?.width ?? Y_AXIS_WIDTH) : 0;
  const totalWidth = width ?? container?.width ?? 320;
  const totalHeight = height ?? container?.height ?? 200;
  const plotWidth =
    plot?.width ?? Math.max(0, totalWidth - yWidth - (margin.left ?? 5) - (margin.right ?? 5));
  const plotHeight =
    plot?.height ??
    Math.max(
      0,
      totalHeight - (showX ? X_AXIS_HEIGHT : 0) - (margin.top ?? 5) - (margin.bottom ?? 5),
    );
  const band = data.length > 0 ? plotWidth / data.length : plotWidth;
  const gapRatio =
    typeof barCategoryGap === "number"
      ? barCategoryGap / Math.max(1, band)
      : Number.parseFloat(barCategoryGap) / 100;
  const inner = Math.max(0, band * (1 - 2 * gapRatio) - barGap * (stacks.length - 1));
  const barWidth = stacks.length > 0 ? inner / stacks.length : 0;
  const heightOf = (value: number) => Math.max(0, (value / top) * plotHeight);

  const payloadFor = (datum: Datum): TooltipPayloadItem[] =>
    bars.map((bar, i) => ({
      dataKey: bar.dataKey,
      name: bar.name ?? bar.dataKey,
      value: datum[bar.dataKey] as number,
      color: fills[i],
      fill: fills[i],
      payload: datum,
    }));
  const legendPayload: LegendPayload[] = bars.map((bar, i) => ({
    value: bar.name ?? bar.dataKey,
    dataKey: bar.dataKey,
    color: fills[i],
    type: "rect",
  }));
  const legendNode = legend
    ? renderContent(
        legend.content,
        {
          payload: legendPayload,
          verticalAlign: legend.verticalAlign ?? "bottom",
          align: legend.align,
          layout: legend.layout,
        },
        DefaultLegend,
      )
    : null;
  const legendTop = legend?.verticalAlign === "top";

  const labelFor = (datum: Datum, index: number): string => {
    const raw = xAxis?.dataKey ? datum[xAxis.dataKey] : index;
    return xAxis?.tickFormatter ? xAxis.tickFormatter(raw, index) : String(raw ?? "");
  };

  const activeDatum = active ? data[active.index] : undefined;
  const cursorOn = tooltip !== undefined && tooltip.cursor !== false;

  return (
    <Box
      className="recharts-wrapper"
      viewStyle={{
        flexDirection: "column",
        width: width ?? "100%",
        height: height ?? "100%",
        paddingTop: margin.top ?? 5,
        paddingBottom: margin.bottom ?? 5,
        paddingLeft: margin.left ?? 5,
        paddingRight: margin.right ?? 5,
      }}
    >
      {legendTop ? legendNode : null}
      <Box viewStyle={{ flex: 1, flexDirection: "row" }}>
        {showY ? (
          <Box viewStyle={{ width: yWidth, position: "relative" }}>
            {ticks.map((tick) => (
              <Box
                key={tick}
                className="text-muted-foreground"
                viewStyle={{ position: "absolute", right: 8, top: plotHeight - heightOf(tick) - 7 }}
              >
                {yAxis?.tickFormatter ? yAxis.tickFormatter(tick, 0) : String(tick)}
              </Box>
            ))}
          </Box>
        ) : null}
        <Box
          className="recharts-surface"
          viewStyle={{ flex: 1, flexDirection: "row", position: "relative" }}
          onLayout={(bounds: Bounds) =>
            setPlot((current) =>
              current && current.width === bounds.width && current.height === bounds.height
                ? current
                : bounds,
            )
          }
        >
          {grid && grid.horizontal !== false
            ? ticks.map((tick) => (
                <Box
                  key={`h${tick}`}
                  className="bg-border/50"
                  viewStyle={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    height: 1,
                    top: plotHeight - heightOf(tick),
                  }}
                />
              ))
            : null}
          {grid && grid.vertical !== false
            ? data.map((_, index) => (
                <Box
                  key={`v${index}`}
                  className="bg-border/50"
                  viewStyle={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    width: 1,
                    left: (index + 0.5) * band,
                  }}
                />
              ))
            : null}
          {data.map((datum, index) => (
            <Box
              key={index}
              data-testid={`recharts-band-${index}`}
              className={cursorOn && active?.index === index ? "bg-muted" : undefined}
              viewStyle={{
                flex: 1,
                height: "100%",
                flexDirection: "row",
                alignItems: "flex-end",
                justifyContent: "center",
                gap: barGap,
              }}
              onMouseEnter={
                tooltip
                  ? (event) => {
                      const r = event.target.getBoundingClientRect();
                      setActive({
                        index,
                        bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
                      });
                    }
                  : undefined
              }
              onMouseLeave={
                tooltip
                  ? () => setActive((current) => (current?.index === index ? null : current))
                  : undefined
              }
            >
              {stacks.map((stack) => (
                <Box
                  key={stack.join("-")}
                  viewStyle={{ width: barWidth, flexDirection: "column", alignItems: "center" }}
                >
                  {[...stack].reverse().map((barIndex) => {
                    const bar = bars[barIndex] as BarProps;
                    const element = barElements[barIndex];
                    const extras = Children.toArray(
                      element?.props ? (element.props as BarProps).children : null,
                    ).filter(isValidElement) as ReactElement[];
                    const cell = extras.filter((child) => child.type === Cell)[index]?.props as
                      | { fill?: string }
                      | undefined;
                    const label = propsOf<LabelListProps>(extras, LabelList);
                    const value = number(datum[bar.dataKey]);
                    const radius = Array.isArray(bar.radius) ? bar.radius[0] : bar.radius;
                    const text = label
                      ? (label.formatter?.(datum[label.dataKey ?? bar.dataKey]) ??
                        String(datum[label.dataKey ?? bar.dataKey] ?? ""))
                      : null;
                    const labelClass = (label?.className ?? "").replace(/\bfill-/g, "text-");
                    const inside =
                      label?.position?.startsWith("inside") || label?.position === "center";
                    return (
                      <Box
                        key={bar.dataKey}
                        viewStyle={{ flexDirection: "column", alignItems: "center", width: "100%" }}
                      >
                        {label && !inside ? (
                          <Box
                            className={labelClass}
                            viewStyle={{ paddingBottom: Math.max(0, (label.offset ?? 5) - 5) }}
                          >
                            {text}
                          </Box>
                        ) : null}
                        <Box
                          data-testid={`recharts-bar-${bar.dataKey}-${index}`}
                          className="recharts-rectangle"
                          viewStyle={{
                            width: "100%",
                            height: heightOf(value),
                            backgroundColor:
                              resolveColor(cell?.fill, vars, theme.colors) ?? fills[barIndex],
                            borderRadius: radius,
                            justifyContent: "center",
                            alignItems: "center",
                          }}
                        >
                          {label && inside ? <Box className={labelClass}>{text}</Box> : null}
                        </Box>
                      </Box>
                    );
                  })}
                </Box>
              ))}
            </Box>
          ))}
          {tooltip && active && activeDatum ? (
            <Box
              viewStyle={{
                position: "absolute",
                top: 0,
                ...(active.index < data.length / 2
                  ? { left: (active.index + 1) * band + 8 }
                  : { right: (data.length - active.index) * band + 8 }),
              }}
            >
              {renderContent(
                tooltip.content,
                {
                  active: true,
                  payload: payloadFor(activeDatum),
                  label: (xAxis?.dataKey ? activeDatum[xAxis.dataKey] : active.index) as string,
                  labelFormatter: tooltip.labelFormatter,
                  formatter: tooltip.formatter,
                  coordinate: { x: (active.index + 0.5) * band, y: 0 },
                },
                DefaultTooltip,
              )}
            </Box>
          ) : null}
        </Box>
      </Box>
      {showX ? (
        <Box
          viewStyle={{
            flexDirection: "row",
            paddingLeft: yWidth,
            paddingTop: xAxis?.tickMargin ?? 4,
          }}
        >
          {data.map((datum, index) => (
            <Box
              key={index}
              className="text-muted-foreground"
              viewStyle={{ flex: 1, alignItems: "center" }}
            >
              {labelFor(datum, index)}
            </Box>
          ))}
        </Box>
      ) : null}
      {legendTop ? null : legendNode}
    </Box>
  );
}
