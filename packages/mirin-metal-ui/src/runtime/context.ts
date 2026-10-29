/**
 * What flows down the tree the way CSS inheritance and selectors do on the
 * web: text styling, descendant icon defaults, `group` state, list markers,
 * and the enclosing `<form>`.
 */

import type { TextStyle } from "@mirinjs/metal";
import { createContext, useContext } from "react";
import type { Attrs } from "../tw/variants.ts";

export interface Inherited {
  text: TextStyle;
  transform?: "uppercase" | "lowercase" | "capitalize";
  /** Defaults for descendant icons (`[&_svg]:size-4`, `currentColor`). */
  svg: { size?: number; color?: string };
}

export const InheritedContext = createContext<Inherited>({ text: {}, svg: {} });

export function useInherited(): Inherited {
  return useContext(InheritedContext);
}

/** Attributes of `group`/`group/<name>` ancestors, keyed by name ("" = unnamed). */
export const GroupContext = createContext<Record<string, Attrs>>({});

export interface FormApi {
  /** Submit the enclosing `<form>` (a `type="submit"` button calls this). */
  submit: () => void;
  reset: () => void;
}

export const FormContext = createContext<FormApi | null>(null);

/** Apply `uppercase`/`lowercase`/`capitalize` to a text run. */
export function transformText(value: string, transform: Inherited["transform"]): string {
  switch (transform) {
    case "uppercase":
      return value.toUpperCase();
    case "lowercase":
      return value.toLowerCase();
    case "capitalize":
      return value.replace(/\b\p{L}/gu, (ch) => ch.toUpperCase());
    default:
      return value;
  }
}
