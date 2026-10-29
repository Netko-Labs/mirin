/**
 * Radix-style `Slot` / `asChild`: render the single child element with the
 * slot's props merged in (classes concatenated, handlers chained, the
 * child's own props winning for everything else).
 */

import { cloneElement, isValidElement, type ReactNode } from "react";
import { cn } from "./cn.ts";

type Props = Record<string, unknown>;

export function mergeProps(slot: Props, child: Props): Props {
  const merged: Props = { ...slot, ...child };
  for (const [key, value] of Object.entries(slot)) {
    const own = child[key];
    if (key === "className") {
      merged.className = cn(value as string, own as string);
    } else if (key === "style") {
      merged.style = { ...(value as Props), ...(own as Props) };
    } else if (/^on[A-Z]/.test(key) && typeof value === "function" && typeof own === "function") {
      merged[key] = (...args: unknown[]) => {
        (own as (...a: unknown[]) => void)(...args);
        (value as (...a: unknown[]) => void)(...args);
      };
    }
  }
  return merged;
}

export function Slot({ children, ...props }: Props & { children?: ReactNode }): ReactNode {
  if (!isValidElement(children)) return children ?? null;
  return cloneElement(children, mergeProps(props, children.props as Props));
}

/** Render `children` through a Slot when `asChild`, else as `fallback` element. */
export function slotOr(
  asChild: boolean | undefined,
  render: (props: Props) => ReactNode,
  props: Props,
): ReactNode {
  return asChild ? <Slot {...props} /> : render(props);
}
