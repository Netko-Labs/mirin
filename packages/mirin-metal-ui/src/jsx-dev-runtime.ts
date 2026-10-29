/** Development JSX runtime: same intrinsic mapping as `jsx-runtime.ts`. */

import { Fragment, jsxDEV as reactJsxDEV } from "react/jsx-dev-runtime";
import { Element } from "./runtime/element.tsx";

export { Fragment };
export type { JSX } from "./jsx-runtime.ts";

type Props = Record<string, unknown>;

export function jsxDEV(
  type: unknown,
  props: Props,
  key: string | undefined,
  isStatic: boolean,
  source?: unknown,
  self?: unknown,
): ReturnType<typeof reactJsxDEV> {
  const resolved = typeof type === "string" ? Element : type;
  const resolvedProps = typeof type === "string" ? { ...props, __tag: type } : props;
  return reactJsxDEV(
    resolved as never,
    resolvedProps as never,
    key,
    isStatic,
    source as never,
    self,
  );
}
