/**
 * The window as the native side reports it. Its chrome: which title bar style
 * the window effectively has and the area the compositor's window controls
 * (the traffic lights) cover when the app asked for a unified title bar
 * (`useWindowChrome()`). Its glass (Dashi): whether its host takes `material`
 * at all (its `protocol` line says `glass`), whether the compositor draws the
 * panes now (`drawing`: while it does not, a material view paints its own
 * `backgroundColor`), and the colour behind the first pane (`tone`,
 * `#rrggbb`), so words on the glass can lean to it (`useWindowGlass()`).
 * Whether it is the active window (`useWindowActive()`), and what its host
 * said it takes (`useHostProtocol()`). A tree root provides them.
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

/** What a window knows of its glass. */
export interface WindowGlass {
  /** The host takes a view's `material` (an older one refuses a tree with it). */
  available: boolean;
  /** The compositor draws the panes now: a material view paints no fill. */
  drawing: boolean;
  /** The colour behind the first pane, `#rrggbb`, or null until it says. */
  tone: string | null;
}

/** Before the host says, and wherever there is no glass. */
export const NO_GLASS: WindowGlass = { available: false, drawing: false, tone: null };

/** Holds the latest glass for one mounted root; changes notify subscribers. */
export class GlassStore {
  #glass: WindowGlass = NO_GLASS;
  readonly #listeners = new Set<() => void>();

  readonly get = (): WindowGlass => this.#glass;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Hear one of the host's events: its `protocol` line or a `glass` report. */
  hear(event: NativeEvent): void {
    if (event.type === "protocol") this.#set({ ...this.#glass, available: event.glass === true });
    else if (event.type === "glass")
      this.#set({ ...this.#glass, drawing: event.drawing, tone: event.tone });
  }

  #set(glass: WindowGlass): void {
    const now = this.#glass;
    if (
      now.available === glass.available &&
      now.drawing === glass.drawing &&
      now.tone === glass.tone
    )
      return;
    this.#glass = glass;
    for (const listener of this.#listeners) listener();
  }
}

const GlassContext = createContext<GlassStore | null>(null);
const none = (): WindowGlass => NO_GLASS;

/**
 * Whether the window is the active one, as the host last said: true until it
 * says otherwise (a host from before never does, and its windows stay as if
 * active). A tree root provides it; `useWindowActive()` reads it.
 */
export class ActiveStore {
  #active = true;
  readonly #listeners = new Set<() => void>();

  readonly get = (): boolean => this.#active;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Hear one of the host's events: an `active` report. */
  hear(event: NativeEvent): void {
    if (event.type !== "active" || event.active === this.#active) return;
    this.#active = event.active;
    for (const listener of this.#listeners) listener();
  }
}

const ActiveContext = createContext<ActiveStore | null>(null);
const always = (): boolean => true;

type Protocol = Extract<NativeEvent, { type: "protocol" }>;

/** What the window's host said it takes (its `protocol` line), or null until it says. */
export class ProtocolStore {
  #said: Protocol | null = null;
  readonly #listeners = new Set<() => void>();

  readonly get = (): Protocol | null => this.#said;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  hear(event: NativeEvent): void {
    if (event.type !== "protocol") return;
    this.#said = event;
    for (const listener of this.#listeners) listener();
  }
}

const ProtocolContext = createContext<ProtocolStore | null>(null);
const unsaid = (): Protocol | null => null;

/** Wrap `children` so `useWindowGlass()` reads `store`. */
export function withGlass(
  store: GlassStore,
  active: ActiveStore,
  protocol: ProtocolStore,
  children: ReactNode,
): ReactNode {
  return createElement(
    GlassContext.Provider,
    { value: store },
    createElement(
      ActiveContext.Provider,
      { value: active },
      createElement(ProtocolContext.Provider, { value: protocol }, children),
    ),
  );
}

/**
 * What the window's host said it takes (its `protocol` line: `glass`,
 * `focusGap`, `pulse`…), so a view sends a prop only to a host that draws it
 * (an older one refuses the tree). Null outside a rendered root and until
 * the host says.
 */
export function useHostProtocol(): Protocol | null {
  const store = useContext(ProtocolContext);
  return useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.get ?? unsaid);
}

/**
 * Whether the window is the active one (it has the keyboard's focus): a
 * selection in a window without it turns neutral, as the Mac does. True
 * outside a rendered root and until the host says otherwise.
 */
export function useWindowActive(): boolean {
  const store = useContext(ActiveContext);
  return useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.get ?? always);
}

/**
 * The window's glass: whether its host takes `material` (`available`),
 * whether the compositor draws it now (`drawing`), and the colour behind it
 * (`tone`). Outside a rendered root, and until the host says, none.
 */
export function useWindowGlass(): WindowGlass {
  const store = useContext(GlassContext);
  return useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.get ?? none);
}
