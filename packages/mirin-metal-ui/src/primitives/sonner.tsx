/**
 * Stand-in for the `sonner` package on Metal: a module-level toast store,
 * the `toast()` API (`success/info/warning/error/loading/message/promise/
 * dismiss/custom`), and a `Toaster` that renders the store into the overlay
 * layer as a stack in a window corner (bottom-right by default), newest
 * nearest the edge, every toast expanded (sonner's collapsed deck and swipe
 * gestures are not drawn). Toasts auto-dismiss after `duration` (4s);
 * loading toasts stay until updated or dismissed.
 *
 * Only one Toaster paints at a time: the most recently mounted explicit one,
 * else the ambient fallback (`components/sonner.tsx` registers one with the
 * overlay host), so `toast()` works without mounting `<Toaster />`.
 */

import { View } from "@mirinjs/metal";
import { isValidElement, type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { cn } from "../lib/cn.ts";
import { useStableId } from "../lib/state.ts";
import { Portal as OverlayPortal } from "../overlay/host.tsx";

export type ToastType = "default" | "success" | "info" | "warning" | "error" | "loading";
export type Position =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface ToastAction {
  label: ReactNode;
  onClick: (event: unknown) => void;
}

export interface ExternalToast {
  id?: string | number;
  description?: ReactNode | (() => ReactNode);
  action?: ToastAction | ReactNode;
  cancel?: ToastAction | ReactNode;
  duration?: number;
  icon?: ReactNode;
  closeButton?: boolean;
  dismissible?: boolean;
  className?: string;
  descriptionClassName?: string;
  onDismiss?: (toast: ToastT) => void;
  onAutoClose?: (toast: ToastT) => void;
  [option: string]: unknown;
}

export interface ToastT extends ExternalToast {
  id: string | number;
  type: ToastType;
  title?: ReactNode | (() => ReactNode);
  /** `toast.custom(jsx)`: rendered instead of the default layout. */
  jsx?: ReactNode;
}

type Listener = () => void;

let toasts: ToastT[] = [];
const listeners = new Set<Listener>();
const timers = new Map<string | number, ReturnType<typeof setTimeout>>();
let counter = 0;
const DEFAULT_DURATION = 4000;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function schedule(toast: ToastT): void {
  const existing = timers.get(toast.id);
  if (existing) clearTimeout(existing);
  timers.delete(toast.id);
  if (toast.type === "loading") return;
  const duration = toast.duration ?? DEFAULT_DURATION;
  if (!Number.isFinite(duration)) return;
  timers.set(
    toast.id,
    setTimeout(() => {
      timers.delete(toast.id);
      const current = toasts.find((entry) => entry.id === toast.id);
      if (!current) return;
      current.onAutoClose?.(current);
      remove(toast.id);
    }, duration),
  );
}

function remove(id: string | number): void {
  const removed = toasts.find((entry) => entry.id === id);
  toasts = toasts.filter((entry) => entry.id !== id);
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  if (removed) emit();
}

function upsert(title: ReactNode | (() => ReactNode), type: ToastType, data: ExternalToast = {}) {
  counter += 1;
  const id = data.id ?? counter;
  const index = toasts.findIndex((entry) => entry.id === id);
  const next: ToastT = { ...(index >= 0 ? toasts[index] : {}), ...data, id, type, title };
  toasts = index >= 0 ? toasts.map((entry, i) => (i === index ? next : entry)) : [...toasts, next];
  schedule(next);
  emit();
  return id;
}

type PromiseData<T> = {
  loading?: ReactNode;
  success?: ReactNode | ((data: T) => ReactNode);
  error?: ReactNode | ((error: unknown) => ReactNode);
  description?: ReactNode | ((data: T) => ReactNode);
  finally?: () => void;
} & Omit<ExternalToast, "description">;

function basic(message: ReactNode | (() => ReactNode), data?: ExternalToast): string | number {
  return upsert(message, "default", data);
}

/** sonner's `toast` API. */
export const toast = Object.assign(basic, {
  message: (message: ReactNode, data?: ExternalToast) => upsert(message, "default", data),
  success: (message: ReactNode, data?: ExternalToast) => upsert(message, "success", data),
  info: (message: ReactNode, data?: ExternalToast) => upsert(message, "info", data),
  warning: (message: ReactNode, data?: ExternalToast) => upsert(message, "warning", data),
  error: (message: ReactNode, data?: ExternalToast) => upsert(message, "error", data),
  loading: (message: ReactNode, data?: ExternalToast) => upsert(message, "loading", data),
  custom: (jsx: ReactNode | ((id: string | number) => ReactNode), data?: ExternalToast) => {
    counter += 1;
    const id = data?.id ?? counter;
    const node = typeof jsx === "function" ? jsx(id) : jsx;
    return upsert(undefined, "default", { ...data, id, jsx: node });
  },
  promise: <T,>(promise: Promise<T> | (() => Promise<T>), data: PromiseData<T> = {}) => {
    const { loading, success, error, description, finally: done, ...rest } = data;
    const id = upsert(loading ?? "Loading...", "loading", rest);
    const run = typeof promise === "function" ? promise() : promise;
    run
      .then((value) => {
        if (success === undefined) return remove(id);
        const title = typeof success === "function" ? success(value) : success;
        const detail = typeof description === "function" ? description(value) : description;
        upsert(title, "success", { ...rest, id, description: detail });
      })
      .catch((reason: unknown) => {
        if (error === undefined) return remove(id);
        const title = typeof error === "function" ? error(reason) : error;
        upsert(title, "error", { ...rest, id });
      })
      .finally(() => done?.());
    return { unwrap: () => run, id };
  },
  dismiss: (id?: string | number) => {
    if (id === undefined) {
      const all = toasts;
      for (const entry of all) entry.onDismiss?.(entry);
      toasts = [];
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      if (all.length > 0) emit();
      return id;
    }
    const entry = toasts.find((t) => t.id === id);
    entry?.onDismiss?.(entry);
    remove(id);
    return id;
  },
  getToasts: (): ToastT[] => toasts,
  getHistory: (): ToastT[] => toasts,
});

export function useSonner(): { toasts: ToastT[] } {
  return { toasts: useSyncExternalStore(subscribe, () => toasts) };
}

/** Which Toaster paints: the latest explicit one, else the ambient fallback. */
const mounted: string[] = [];
const mountListeners = new Set<Listener>();
function useActiveToaster(id: string, ambient: boolean): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((v) => v + 1);
    mountListeners.add(listener);
    if (!ambient) {
      mounted.push(id);
      for (const l of mountListeners) l();
    }
    return () => {
      mountListeners.delete(listener);
      const at = mounted.indexOf(id);
      if (at >= 0) {
        mounted.splice(at, 1);
        for (const l of mountListeners) l();
      }
    };
  }, [id, ambient]);
  return ambient ? mounted.length === 0 : mounted[mounted.length - 1] === id;
}

export interface ToasterProps {
  position?: Position;
  theme?: "light" | "dark" | "system";
  richColors?: boolean;
  expand?: boolean;
  closeButton?: boolean;
  visibleToasts?: number;
  duration?: number;
  gap?: number;
  offset?: number | string;
  className?: string;
  style?: object;
  icons?: Partial<Record<Exclude<ToastType, "default"> | "close", ReactNode>>;
  toastOptions?: {
    className?: string;
    descriptionClassName?: string;
    duration?: number;
    closeButton?: boolean;
    classNames?: Record<string, string>;
  };
  /** metal: set by the overlay host's fallback Toaster; yields to any explicit `<Toaster />`. */
  ambient?: boolean;
  [prop: string]: unknown;
}

function textOrNode(value: ReactNode | (() => ReactNode)): ReactNode {
  return typeof value === "function" ? value() : value;
}

function ActionButton({
  action,
  className,
  onDone,
}: {
  action: ToastAction | ReactNode;
  className: string;
  onDone: () => void;
}) {
  if (isValidElement(action)) return action;
  if (!action || typeof action !== "object" || !("label" in action)) return null;
  const { label, onClick } = action as ToastAction;
  return (
    <button
      type="button"
      data-button=""
      className={className}
      onClick={(event: unknown) => {
        onClick(event);
        onDone();
      }}
    >
      {label}
    </button>
  );
}

function Toast({
  item,
  icons,
  closeButton,
  toastClassName,
  descriptionClassName,
}: {
  item: ToastT;
  icons: ToasterProps["icons"];
  closeButton: boolean;
  toastClassName?: string;
  descriptionClassName?: string;
}) {
  if (item.jsx !== undefined) {
    return (
      <div data-sonner-toast="" data-testid={`toast-${item.id}`}>
        {item.jsx}
      </div>
    );
  }
  const icon = item.icon ?? (item.type !== "default" ? icons?.[item.type] : undefined);
  const dismiss = () => toast.dismiss(item.id);
  return (
    <div
      data-sonner-toast=""
      data-type={item.type}
      data-testid={`toast-${item.id}`}
      className={cn(
        "relative flex w-[356px] items-center gap-1.5 rounded-lg border bg-popover p-4 text-[13px] text-popover-foreground shadow-lg",
        toastClassName,
        item.className,
      )}
    >
      {closeButton || item.closeButton ? (
        <button
          type="button"
          aria-label="Close toast"
          data-close-button=""
          data-testid={`toast-close-${item.id}`}
          className="absolute -top-2 -left-2 flex size-5 items-center justify-center rounded-full border bg-popover text-popover-foreground"
          onClick={dismiss}
        >
          {icons?.close ?? "×"}
        </button>
      ) : null}
      {icon ? (
        <div data-icon="" className="flex size-4 shrink-0 items-center justify-center">
          {icon}
        </div>
      ) : null}
      <div data-content="" className="flex flex-1 flex-col gap-0.5">
        {item.title !== undefined ? (
          <div data-title="" className="font-medium leading-normal">
            {textOrNode(item.title)}
          </div>
        ) : null}
        {item.description !== undefined ? (
          <div
            data-description=""
            className={cn(
              "leading-snug text-muted-foreground",
              descriptionClassName,
              item.descriptionClassName,
            )}
          >
            {textOrNode(item.description)}
          </div>
        ) : null}
      </div>
      {item.cancel ? (
        <ActionButton
          action={item.cancel}
          onDone={dismiss}
          className="ml-auto h-6 shrink-0 rounded-sm bg-muted px-2 text-xs font-medium text-foreground"
        />
      ) : null}
      {item.action ? (
        <ActionButton
          action={item.action}
          onDone={dismiss}
          className="ml-auto h-6 shrink-0 rounded-sm bg-foreground px-2 text-xs font-medium text-background"
        />
      ) : null}
    </div>
  );
}

/** sonner's `<Toaster />`: paints the toast store into the overlay layer. */
export function Toaster({
  position = "bottom-right",
  visibleToasts = 3,
  closeButton = false,
  gap = 14,
  offset = 32,
  icons,
  toastOptions,
  className,
  ambient = false,
}: ToasterProps) {
  const id = useStableId("toaster");
  const active = useActiveToaster(id, ambient);
  const { toasts: all } = useSonner();
  if (!active || all.length === 0) return null;
  const [vertical, horizontal] = position.split("-") as ["top" | "bottom", string];
  const inset = typeof offset === "number" ? offset : Number.parseFloat(offset) || 32;
  // Newest nearest the window edge; at most `visibleToasts`, like sonner's deck.
  const shown = all.slice(-Math.max(1, visibleToasts));
  const ordered = vertical === "bottom" ? shown : [...shown].reverse();
  return (
    <OverlayPortal>
      <View
        testID="sonner-toaster"
        occlude
        style={{
          position: "absolute",
          [vertical]: inset,
          ...(horizontal === "left"
            ? { left: inset }
            : horizontal === "right"
              ? { right: inset }
              : { left: 0, right: 0, alignItems: "center" }),
          flexDirection: "column",
          gap,
        }}
      >
        <div data-sonner-toaster="" data-y-position={vertical} className={className}>
          <div className="flex flex-col" style={{ gap }}>
            {ordered.map((item) => (
              <Toast
                key={item.id}
                item={item}
                icons={icons}
                closeButton={toastOptions?.closeButton ?? closeButton}
                toastClassName={toastOptions?.className ?? toastOptions?.classNames?.toast}
                descriptionClassName={
                  toastOptions?.descriptionClassName ?? toastOptions?.classNames?.description
                }
              />
            ))}
          </div>
        </div>
      </View>
    </OverlayPortal>
  );
}
