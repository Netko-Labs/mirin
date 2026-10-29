/**
 * JSX runtime for Metal: lowercase tags (`<div>`, `<p>`, `<input>`) become
 * Metal-backed elements, so shadcn components and examples written for React
 * DOM render unchanged. Use with `"jsxImportSource": "@mirinjs/metal-ui"`
 * (tsconfig) or a `/** @jsxImportSource @mirinjs/metal-ui *\/` pragma.
 */

import type { JSX as ReactJSX } from "react";
import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from "react/jsx-runtime";
import { intrinsicComponent } from "./runtime/element.tsx";

type Props = Record<string, unknown> & { children?: unknown };

/**
 * Map a lowercase tag to its Metal component. The props object is tagged in
 * place: compiled JSX creates a fresh one per call, and copying it for every
 * element was a measurable share of render time.
 */
export function host(type: unknown, props: Props): [unknown, Props] {
  if (typeof type !== "string") return [type, props];
  props.__tag = type;
  return [intrinsicComponent(type), props];
}

export function jsx(type: unknown, props: Props, key?: string): ReturnType<typeof reactJsx> {
  const [resolved, resolvedProps] = host(type, props);
  return reactJsx(resolved as never, resolvedProps as never, key);
}

export function jsxs(type: unknown, props: Props, key?: string): ReturnType<typeof reactJsxs> {
  const [resolved, resolvedProps] = host(type, props);
  return reactJsxs(resolved as never, resolvedProps as never, key);
}

export { Fragment };

/** React DOM's JSX types, so `<div className>` type-checks the same as on the web. */
export namespace JSX {
  export type Element = ReactJSX.Element;
  export type ElementType = ReactJSX.ElementType;
  export type ElementClass = ReactJSX.ElementClass;
  export type ElementAttributesProperty = ReactJSX.ElementAttributesProperty;
  export type ElementChildrenAttribute = ReactJSX.ElementChildrenAttribute;
  export type LibraryManagedAttributes<C, P> = ReactJSX.LibraryManagedAttributes<C, P>;
  export type IntrinsicAttributes = ReactJSX.IntrinsicAttributes;
  export type IntrinsicClassAttributes<T> = ReactJSX.IntrinsicClassAttributes<T>;
  export type IntrinsicElements = ReactJSX.IntrinsicElements;
}
