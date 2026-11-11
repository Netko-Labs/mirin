/** Radix `Separator` on Metal: a thin rule with `data-orientation`. */

import type { ReactNode } from "react";
import { Slot } from "../lib/slot.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
  orientation?: "horizontal" | "vertical";
  decorative?: boolean;
};

function Root({ asChild, orientation = "horizontal", decorative = false, ...props }: Props) {
  const shared: Props = {
    ...props,
    role: decorative ? "none" : "separator",
    "aria-orientation": decorative || orientation === "horizontal" ? undefined : orientation,
    "data-orientation": orientation,
  };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

export const Separator = { Root };
