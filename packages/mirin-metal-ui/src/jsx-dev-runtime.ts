/** Development JSX runtime: same intrinsic mapping as `jsx-runtime.ts`. */

import { Fragment, jsxDEV as reactJsxDEV } from "react/jsx-dev-runtime";
import { host } from "./jsx-runtime.ts";

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
  const [resolved, resolvedProps] = host(type, props);
  return reactJsxDEV(
    resolved as never,
    resolvedProps as never,
    key,
    isStatic,
    source as never,
    self,
  );
}
