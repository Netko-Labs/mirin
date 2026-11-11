/**
 * Radix `Label` on Metal: a `<label>` that, like `htmlFor` in the DOM,
 * activates the control registered under that id (checkbox, switch, radio
 * item) when pressed.
 */

import { type ReactNode, useEffect } from "react";
import { Slot } from "../lib/slot.tsx";
import type { SyntheticEvent } from "../runtime/events.ts";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
  htmlFor?: string;
};

const targets = new Map<string, () => void>();

/** Register `activate` as what a `<Label htmlFor={id}>` press does. */
export function useLabelTarget(id: unknown, activate: () => void): void {
  useEffect(() => {
    if (typeof id !== "string" || !id) return;
    targets.set(id, activate);
    return () => {
      if (targets.get(id) === activate) targets.delete(id);
    };
  }, [id, activate]);
}

function Root({ asChild, htmlFor, onClick, ...props }: Props) {
  const handle = (event: SyntheticEvent) => {
    (onClick as ((e: SyntheticEvent) => void) | undefined)?.(event);
    if (!event.defaultPrevented && htmlFor) targets.get(htmlFor)?.();
  };
  const shared: Props = { ...props, ...(htmlFor || onClick ? { onClick: handle } : {}) };
  return asChild ? <Slot {...shared} /> : <label {...shared} />;
}

export const Label = { Root };
