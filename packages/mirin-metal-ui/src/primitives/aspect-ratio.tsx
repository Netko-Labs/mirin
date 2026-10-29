/**
 * Radix `AspectRatio` on Metal: `Root` takes the full width and sizes its
 * height from `ratio` (width / height) via the Metal `aspectRatio` style.
 */

import type { ReactNode } from "react";
import { Slot } from "../lib/slot.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

function Root({ ratio = 1, asChild, ...props }: Props & { ratio?: number }) {
  const safe = typeof ratio === "number" && ratio > 0 && Number.isFinite(ratio) ? ratio : 1;
  // metal: one box with `aspectRatio` instead of radix's padding-bottom wrapper.
  const shared: Props = {
    ...props,
    "data-radix-aspect-ratio-wrapper": "",
    viewStyle: { width: "100%", aspectRatio: safe, position: "relative" },
  };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

export const AspectRatio = { Root };
