/**
 * Radix `ScrollArea` on Metal: `Root`, `Viewport`, `Scrollbar`, `Thumb`,
 * `Corner` (plus the `ScrollArea*` aliases). The viewport scrolls natively
 * along the axes whose scrollbars are mounted (vertical when none are);
 * the scrollbar parts render nothing.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Slot } from "../lib/slot.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

type Orientation = "vertical" | "horizontal";

interface ScrollAreaApi {
  axes: { vertical: number; horizontal: number };
  register: (orientation: Orientation) => () => void;
}

const ScrollAreaContext = createContext<ScrollAreaApi | null>(null);

function Root({ type: _type, scrollHideDelay: _delay, dir: _dir, asChild, ...props }: Props) {
  const [axes, setAxes] = useState({ vertical: 0, horizontal: 0 });
  const register = useCallback((orientation: Orientation) => {
    setAxes((current) => ({ ...current, [orientation]: current[orientation] + 1 }));
    return () => setAxes((current) => ({ ...current, [orientation]: current[orientation] - 1 }));
  }, []);
  const api = useMemo(() => ({ axes, register }), [axes, register]);
  return (
    <ScrollAreaContext.Provider value={api}>
      {asChild ? <Slot {...props} /> : <div {...props} />}
    </ScrollAreaContext.Provider>
  );
}

function Viewport({ asChild, ...props }: Props) {
  const area = useContext(ScrollAreaContext);
  const vertical = (area?.axes.vertical ?? 0) > 0;
  const horizontal = (area?.axes.horizontal ?? 0) > 0;
  const overflow =
    vertical && horizontal ? "scroll-both" : horizontal ? "scroll-x" : ("scroll" as const);
  const shared: Props = { ...props, viewStyle: { overflow } };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

/** Registers its axis with the root so the viewport scrolls that way; draws nothing. */
function Scrollbar({ orientation = "vertical" }: Props & { orientation?: Orientation }) {
  const area = useContext(ScrollAreaContext);
  const register = area?.register;
  useEffect(() => register?.(orientation), [register, orientation]);
  // metal: no custom track/thumb is drawn; the viewport scrolls natively.
  return null;
}

function Thumb(_props: Props) {
  return null;
}

function Corner(_props: Props) {
  return null;
}

export const ScrollArea = {
  Root,
  Viewport,
  Scrollbar,
  Thumb,
  Corner,
  ScrollAreaScrollbar: Scrollbar,
  ScrollAreaThumb: Thumb,
  ScrollAreaCorner: Corner,
};
