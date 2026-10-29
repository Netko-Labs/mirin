/**
 * Radix `Direction` on Metal: `DirectionProvider` passes its children
 * through (Metal lays out left-to-right); `useDirection` reports the value.
 */

import { createContext, type ReactNode, useContext } from "react";

type Dir = "ltr" | "rtl";

const DirectionContext = createContext<Dir>("ltr");

function Provider({ dir = "ltr", children }: { dir?: Dir; children?: ReactNode }) {
  return <DirectionContext.Provider value={dir}>{children}</DirectionContext.Provider>;
}

export function useDirection(local?: Dir): Dir {
  const global = useContext(DirectionContext);
  return local ?? global;
}

export const Direction = { Provider, DirectionProvider: Provider, useDirection };
export { Provider as DirectionProvider };
