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
  /** Main axis of the parent element, for `w-fit`. */
  parentDirection?: "row" | "column";
}

export const InheritedContext = createContext<Inherited>({ text: {}, svg: {} });

export function useInherited(): Inherited {
  return useContext(InheritedContext);
}

/** Attributes of `group`/`group/<name>` ancestors, keyed by name ("" = unnamed). */
export const GroupContext = createContext<Record<string, Attrs>>({});

/** Position among the parent element's children, for `first:`/`last:` variants. */
export interface SiblingPosition {
  first: boolean;
  last: boolean;
}

export const SiblingContext = createContext<SiblingPosition | null>(null);

/** A named control as the enclosing `<form>` sees it (see `runtime/form.tsx`). */
export interface FormField {
  name: string;
  /** Current value; `undefined` contributes nothing (an unchecked checkbox). */
  value: () => string | string[] | undefined;
  reset?: () => void;
}

export interface FormApi {
  /** Submit the enclosing `<form>` (a `type="submit"` button calls this). */
  submit: () => void;
  reset: () => void;
  /** Track a named control; returns the unregister function. */
  register: (field: FormField) => () => void;
  /** The registered controls' values, as a DOM form would serialize them. */
  formData: () => FormData;
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
