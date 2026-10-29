/**
 * Radix `Progress` on Metal: `Root` (role `progressbar`, `data-state`,
 * `data-value`, `data-max`) and `Indicator`.
 */

import { createContext, type ReactNode, useContext } from "react";
import { Slot } from "../lib/slot.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

interface ProgressApi {
  value: number | null;
  max: number;
}

const ProgressContext = createContext<ProgressApi>({ value: null, max: 100 });

function stateOf({ value, max }: ProgressApi): "indeterminate" | "complete" | "loading" {
  if (value === null) return "indeterminate";
  return value >= max ? "complete" : "loading";
}

function Root({
  value,
  max = 100,
  getValueLabel: _label,
  asChild,
  ...props
}: Props & { value?: number | null; max?: number }) {
  const safeMax = typeof max === "number" && max > 0 ? max : 100;
  const safeValue =
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.min(safeMax, value))
      : null;
  const api: ProgressApi = { value: safeValue, max: safeMax };
  const shared: Props = {
    ...props,
    role: "progressbar",
    "aria-valuemax": safeMax,
    "aria-valuemin": 0,
    "aria-valuenow": safeValue ?? undefined,
    "data-state": stateOf(api),
    "data-value": safeValue ?? undefined,
    "data-max": safeMax,
  };
  return (
    <ProgressContext.Provider value={api}>
      {asChild ? <Slot {...shared} /> : <div {...shared} />}
    </ProgressContext.Provider>
  );
}

/** shadcn passes the fill as `style.transform: translateX(-N%)`; read it back as a percent. */
function percentFromTransform(style: unknown): number | undefined {
  const transform = (style as { transform?: unknown } | undefined)?.transform;
  if (typeof transform !== "string") return undefined;
  const match = transform.match(/translateX\((-?\d+(?:\.\d+)?)%\)/);
  return match ? Math.max(0, Math.min(100, 100 + Number(match[1]))) : undefined;
}

function Indicator({ asChild, style, ...props }: Props) {
  const progress = useContext(ProgressContext);
  // metal: upstream slides a full-width bar with translateX; transforms are
  // unsupported, so the indicator's width is the percent of the track instead
  // (from the root's `value`, else from the translateX the component passes).
  const percent =
    progress.value !== null
      ? (progress.value / progress.max) * 100
      : (percentFromTransform(style) ?? 0);
  const shared: Props = {
    ...props,
    "data-state": stateOf(progress),
    "data-value": progress.value ?? undefined,
    "data-max": progress.max,
    viewStyle: { width: `${Math.round(percent * 100) / 100}%` },
  };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

export const Progress = { Root, Indicator };
