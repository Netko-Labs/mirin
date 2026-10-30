/**
 * The window's chrome as the native side reports it: which title bar style the
 * window effectively has and the area the compositor's window controls (the
 * traffic lights) cover when the app asked for a unified title bar. A tree
 * root provides it; `useWindowChrome()` reads it.
 */

import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from "react";
import type { Bounds, NativeEvent, WindowChrome } from "./types.ts";

/** What a window has before the native side reports, and on compositors without a unified title bar. */
export const STANDARD_CHROME: WindowChrome = { titleBar: "standard", controls: null };

type ChromeEvent = Extract<NativeEvent, { type: "chrome" }>;

/** The chrome a `chrome` event describes. */
export function chromeFromEvent(event: ChromeEvent): WindowChrome {
  return { titleBar: event.titleBar, controls: event.controls };
}

/** Holds the latest chrome for one mounted root; changes notify subscribers. */
export class ChromeStore {
  #chrome: WindowChrome = STANDARD_CHROME;
  readonly #listeners = new Set<() => void>();

  readonly get = (): WindowChrome => this.#chrome;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Replace the chrome; a report identical to the current one changes nothing. */
  set(chrome: WindowChrome): void {
    if (sameChrome(this.#chrome, chrome)) return;
    this.#chrome = chrome;
    for (const listener of this.#listeners) listener();
  }
}

function sameBounds(a: Bounds | null, b: Bounds | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function sameChrome(a: WindowChrome, b: WindowChrome): boolean {
  return a.titleBar === b.titleBar && sameBounds(a.controls, b.controls);
}

const ChromeContext = createContext<ChromeStore | null>(null);
const noopSubscribe = (): (() => void) => () => {};

/** Wrap `children` so `useWindowChrome()` reads `store`. */
export function withChrome(store: ChromeStore, children: ReactNode): ReactNode {
  return createElement(ChromeContext.Provider, { value: store }, children);
}

/**
 * The window's title bar style and, for a unified title bar, the area the
 * compositor's window controls cover (window pixels, top-left): keep it
 * empty and start toolbar content past `controls.x + controls.width`.
 *
 * `controls` is `null` for the standard title bar, on compositors without
 * Dashi's chrome protocol (where `titleBar: "unified"` falls back to the
 * standard title bar), and until the compositor reports.
 */
export function useWindowChrome(): WindowChrome {
  const store = useContext(ChromeContext);
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.get ?? (() => STANDARD_CHROME),
  );
}
