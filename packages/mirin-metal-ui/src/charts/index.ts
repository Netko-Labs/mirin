/**
 * The subset of `recharts` shadcn's `ui/chart.tsx` and chart examples use,
 * drawn with Metal views: `ResponsiveContainer`, `BarChart`, `Bar`, `XAxis`,
 * `YAxis`, `CartesianGrid`, `Tooltip`, `Legend`, `LabelList`, `Cell`, and
 * `Rectangle`. Line, area, pie, and radial charts are not implemented.
 */

export { BarChart, type BarChartProps } from "./bar-chart.tsx";
export {
  Bar,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "./components.tsx";
export type {
  AxisProps,
  BarProps,
  CartesianGridProps,
  DefaultLegendContentProps,
  DefaultTooltipContentProps,
  LabelListProps,
  LegendPayload,
  LegendProps,
  NameType,
  TooltipPayloadItem,
  TooltipProps,
  TooltipValueType,
} from "./types.ts";
