/**
 * `@shadcn/react/message-scroller` on Metal: `MessageScroller.Provider`,
 * `Root`, `Viewport`, `Content`, `Item`, and `Button`, plus the
 * `useMessageScroller*` hooks, with the package's props and data attributes.
 * The viewport is a native vertical scroll view.
 * metal: there is no programmatic scrolling or scroll-position feedback yet,
 * so `scrollTo*` return false, `useMessageScrollerScrollable()` reports no
 * scrollable edges, and the jump buttons stay inactive (`data-active=false`).
 */

import {
  cloneElement,
  createContext,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useStableId } from "../lib/state.ts";
import type { SyntheticEvent } from "../runtime/events.ts";

export type MessageScrollerDefaultScrollPosition = "start" | "end" | "last-anchor";
export type MessageScrollerButtonDirection = "start" | "end";
export type MessageScrollerScrollAlign = "start" | "center" | "end" | "nearest";
export interface MessageScrollerScrollOptions {
  align?: MessageScrollerScrollAlign;
  behavior?: "auto" | "instant" | "smooth";
  scrollMargin?: number;
}
export interface MessageScrollerScrollable {
  start: boolean;
  end: boolean;
}
export interface MessageScrollerVisibilityState {
  currentAnchorId: string | null;
  visibleMessageIds: string[];
}

type Html = Record<string, unknown> & { className?: string; children?: ReactNode };

interface ScrollerApi {
  autoScroll: boolean;
  items: Array<{ id: string; anchor: boolean }>;
  register(id: string, anchor: boolean): () => void;
}

const ScrollerContext = createContext<ScrollerApi | null>(null);

export interface MessageScrollerProviderProps {
  children?: ReactNode;
  autoScroll?: boolean;
  defaultScrollPosition?: MessageScrollerDefaultScrollPosition;
  scrollEdgeThreshold?: number;
  scrollPreviousItemPeek?: number;
  scrollMargin?: number;
}

function useScrollerState(autoScroll: boolean): ScrollerApi {
  const [items, setItems] = useState<Array<{ id: string; anchor: boolean }>>([]);
  return {
    autoScroll,
    items,
    register(id, anchor) {
      setItems((current) => [...current.filter((item) => item.id !== id), { id, anchor }]);
      return () => setItems((current) => current.filter((item) => item.id !== id));
    },
  };
}

function Provider({ children, autoScroll = true }: MessageScrollerProviderProps) {
  const api = useScrollerState(autoScroll);
  return <ScrollerContext.Provider value={api}>{children}</ScrollerContext.Provider>;
}

function Root({ children, ...props }: Html) {
  const outer = useContext(ScrollerContext);
  const own = useScrollerState(true);
  const body = <div {...props}>{children}</div>;
  return outer ? body : <ScrollerContext.Provider value={own}>{body}</ScrollerContext.Provider>;
}

function Viewport({
  children,
  preserveScrollOnPrepend: _preserve,
  "aria-label": ariaLabel,
  role,
  ...props
}: Html & { preserveScrollOnPrepend?: boolean }) {
  const merged: Html = { ...props, role: role ?? "region", "aria-label": ariaLabel };
  return <div {...merged}>{children}</div>;
}

function Content({
  children,
  spacerClassName: _spacer,
  role,
  ...props
}: Html & { spacerClassName?: string }) {
  const merged: Html = {
    ...props,
    role: role ?? "log",
    "aria-relevant": props["aria-relevant"] ?? "additions",
  };
  return <div {...merged}>{children}</div>;
}

function Item({
  messageId,
  scrollAnchor = false,
  ...props
}: Html & { messageId?: string; scrollAnchor?: boolean }) {
  const scroller = useContext(ScrollerContext);
  const fallback = useStableId("message");
  const id = messageId ?? fallback;
  const register = useRef(scroller?.register);
  register.current = scroller?.register;
  useLayoutEffect(() => register.current?.(id, scrollAnchor), [id, scrollAnchor]);
  return <div {...props} data-message-id={id} data-scroll-anchor={scrollAnchor || undefined} />;
}

function Button({
  behavior: _behavior,
  children,
  direction = "end",
  onClick,
  render,
  type,
  ...props
}: Html & {
  behavior?: MessageScrollerScrollOptions["behavior"];
  direction?: MessageScrollerButtonDirection;
  render?:
    | ReactElement
    | ((props: Html, state: { active: boolean; direction: string }) => ReactNode);
  onClick?: (event: SyntheticEvent) => void;
  type?: string;
}) {
  const scrollable = useMessageScrollerScrollable();
  const active = scrollable[direction];
  const merged: Html = {
    ...props,
    type: type ?? "button",
    "data-active": active,
    "aria-hidden": active ? undefined : true,
    tabIndex: active ? undefined : -1,
    onClick: (event: SyntheticEvent) => {
      onClick?.(event);
    },
    children,
  };
  if (typeof render === "function") return render(merged, { active, direction });
  if (isValidElement<Html>(render)) {
    const own = render.props;
    return cloneElement(render, {
      ...own,
      ...merged,
      className: [own.className, merged.className].filter(Boolean).join(" "),
    });
  }
  return <button {...(merged as Record<string, unknown>)} />;
}

export function useMessageScroller(): {
  scrollToEnd: (options?: MessageScrollerScrollOptions) => boolean;
  scrollToMessage: (messageId: string, options?: MessageScrollerScrollOptions) => boolean;
  scrollToStart: (options?: MessageScrollerScrollOptions) => boolean;
} {
  return { scrollToEnd: () => false, scrollToMessage: () => false, scrollToStart: () => false };
}

export function useMessageScrollerScrollable(): MessageScrollerScrollable {
  return { start: false, end: false };
}

export function useMessageScrollerVisibility(): MessageScrollerVisibilityState {
  const scroller = useContext(ScrollerContext);
  const items = scroller?.items ?? [];
  const anchors = items.filter((item) => item.anchor);
  return {
    currentAnchorId: anchors[anchors.length - 1]?.id ?? null,
    visibleMessageIds: items.map((item) => item.id),
  };
}

export const MessageScroller = { Provider, Root, Viewport, Content, Item, Button };
