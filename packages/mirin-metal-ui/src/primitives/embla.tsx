/**
 * `embla-carousel-react` on Metal: `useEmblaCarousel(options, plugins)`
 * returns `[viewportRef, api]` with embla's API (`scrollPrev`/`scrollNext`/
 * `scrollTo`, `canScrollPrev`/`canScrollNext`, `selectedScrollSnap`,
 * `scrollSnapList`, `on`/`off("select" | "reInit" | …)`, plugins). Snaps
 * follow embla's `align` and `containScroll: "trimSnaps"` rules; `loop`
 * wraps the index. Slides are shown by offsetting the track (no animation).
 *
 * Embla moves the track by writing a transform on its DOM node. Metal has no
 * imperative styles, so the track spreads `useEmblaTrack(api, children)`:
 * it reports the slide count and size and receives the offset.
 */

import type { Bounds } from "@mirinjs/metal";
import { Children, isValidElement, type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import { useTheme } from "../theme.ts";
import { translate } from "../tw/index.ts";

export type EmblaEventType =
  | "init"
  | "pointerDown"
  | "pointerUp"
  | "slidesChanged"
  | "slidesInView"
  | "scroll"
  | "select"
  | "settle"
  | "destroy"
  | "reInit"
  | "resize";

export interface EmblaOptionsType {
  axis?: "x" | "y";
  align?: "start" | "center" | "end" | number;
  loop?: boolean;
  startIndex?: number;
  containScroll?: false | "trimSnaps" | "keepSnaps";
  slidesToScroll?: number | "auto";
  dragFree?: boolean;
  duration?: number;
  skipSnaps?: boolean;
  active?: boolean;
  direction?: "ltr" | "rtl";
  breakpoints?: Record<string, Omit<EmblaOptionsType, "breakpoints">>;
  [option: string]: unknown;
}

export type EmblaEventListener = (api: EmblaCarouselType, event: EmblaEventType) => void;

export interface EmblaPluginType {
  name: string;
  options?: Record<string, unknown>;
  init: (api: EmblaCarouselType, optionsHandler?: unknown) => void;
  destroy: () => void;
  [member: string]: unknown;
}

export interface EmblaCarouselType {
  canScrollNext(): boolean;
  canScrollPrev(): boolean;
  scrollNext(jump?: boolean): void;
  scrollPrev(jump?: boolean): void;
  scrollTo(index: number, jump?: boolean): void;
  selectedScrollSnap(): number;
  previousScrollSnap(): number;
  scrollSnapList(): number[];
  scrollProgress(): number;
  slidesInView(): number[];
  slidesNotInView(): number[];
  slideNodes(): unknown[];
  rootNode(): unknown;
  containerNode(): unknown;
  plugins(): Record<string, EmblaPluginType>;
  on(event: EmblaEventType, listener: EmblaEventListener): EmblaCarouselType;
  off(event: EmblaEventType, listener: EmblaEventListener): EmblaCarouselType;
  emit(event: EmblaEventType): EmblaCarouselType;
  reInit(options?: EmblaOptionsType, plugins?: EmblaPluginType[]): void;
  destroy(): void;
}

export type EmblaViewportRefType = (instance: unknown) => void;
export type UseEmblaCarouselType = [EmblaViewportRefType, EmblaCarouselType | undefined];

interface Engine {
  options: EmblaOptionsType;
  plugins: EmblaPluginType[];
  /** Slide count and size (fraction of the track) reported by the track. */
  count: number;
  fraction: number;
  index: number;
  previous: number;
  listeners: Map<EmblaEventType, Set<EmblaEventListener>>;
  root: unknown;
  /** Re-render the carousel after the index changes. */
  render: () => void;
}

const ENGINES = new WeakMap<EmblaCarouselType, Engine>();

/** Snap positions in slide units (embla `align` + `containScroll: "trimSnaps"`). */
export function snapPositions(
  count: number,
  fraction: number,
  options: EmblaOptionsType,
): number[] {
  if (count <= 0) return [0];
  const view = 1 / Math.max(fraction, 1e-6);
  const align = options.align ?? "center";
  const shift =
    typeof align === "number"
      ? -align * view
      : align === "start"
        ? 0
        : align === "end"
          ? 1 - view
          : (1 - view) / 2;
  const raw = Array.from({ length: count }, (_, i) => i + shift);
  if (options.loop || options.containScroll === false) return raw;
  const max = Math.max(0, count - view);
  const clamped = raw.map((snap) => Math.round(Math.min(max, Math.max(0, snap)) * 1000) / 1000);
  if (options.containScroll === "keepSnaps") return clamped;
  return clamped.filter((snap, i) => i === 0 || snap !== clamped[i - 1]);
}

function createApi(engine: Engine): EmblaCarouselType {
  const snaps = () => snapPositions(engine.count, engine.fraction, engine.options);
  const api: EmblaCarouselType = {
    canScrollNext: () => engine.options.loop === true || engine.index < snaps().length - 1,
    canScrollPrev: () => engine.options.loop === true || engine.index > 0,
    scrollNext: () => api.scrollTo(engine.index + 1),
    scrollPrev: () => api.scrollTo(engine.index - 1),
    scrollTo(index) {
      const total = snaps().length;
      const next = engine.options.loop
        ? ((index % total) + total) % total
        : Math.min(total - 1, Math.max(0, index));
      if (next === engine.index) return;
      engine.previous = engine.index;
      engine.index = next;
      engine.render();
      api.emit("select").emit("scroll").emit("settle");
    },
    selectedScrollSnap: () => engine.index,
    previousScrollSnap: () => engine.previous,
    scrollSnapList: () => {
      const list = snaps();
      const last = list[list.length - 1] || 1;
      return list.map((snap) => snap / last);
    },
    scrollProgress: () => {
      const total = snaps().length;
      return total > 1 ? engine.index / (total - 1) : 0;
    },
    slidesInView: () => {
      const start = Math.floor(snaps()[engine.index] ?? 0);
      const visible = Math.ceil(1 / Math.max(engine.fraction, 1e-6));
      return Array.from({ length: engine.count }, (_, i) => i).filter(
        (i) => i >= start && i < start + visible,
      );
    },
    slidesNotInView: () => {
      const inView = new Set(api.slidesInView());
      return Array.from({ length: engine.count }, (_, i) => i).filter((i) => !inView.has(i));
    },
    slideNodes: () => [],
    rootNode: () => engine.root,
    containerNode: () => engine.root,
    plugins: () => Object.fromEntries(engine.plugins.map((plugin) => [plugin.name, plugin])),
    on(event, listener) {
      const set = engine.listeners.get(event) ?? new Set();
      set.add(listener);
      engine.listeners.set(event, set);
      return api;
    },
    off(event, listener) {
      engine.listeners.get(event)?.delete(listener);
      return api;
    },
    emit(event) {
      for (const listener of [...(engine.listeners.get(event) ?? [])]) listener(api, event);
      return api;
    },
    reInit(options, plugins) {
      if (options) engine.options = { ...engine.options, ...options };
      if (plugins) engine.plugins = plugins;
      const total = snaps().length;
      if (engine.index > total - 1) engine.index = Math.max(0, total - 1);
      engine.render();
      api.emit("reInit");
    },
    destroy() {
      for (const plugin of engine.plugins) plugin.destroy();
      api.emit("destroy");
      engine.listeners.clear();
    },
  };
  ENGINES.set(api, engine);
  return api;
}

export default function useEmblaCarousel(
  options: EmblaOptionsType = {},
  plugins: EmblaPluginType[] = [],
): UseEmblaCarouselType {
  const [, setTick] = useState(0);
  const engine = useRef<Engine | null>(null);
  engine.current ??= {
    options,
    plugins,
    count: 0,
    fraction: 1,
    index: options.startIndex ?? 0,
    previous: options.startIndex ?? 0,
    listeners: new Map(),
    root: null,
    render: () => setTick((tick) => tick + 1),
  };
  engine.current.options = options;
  engine.current.plugins = plugins;
  const api = useRef<EmblaCarouselType | null>(null);
  api.current ??= createApi(engine.current);
  const ref = useRef<EmblaViewportRefType>((instance) => {
    if (engine.current) engine.current.root = instance;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: plugins init once, like embla
  useEffect(() => {
    const instance = api.current as EmblaCarouselType;
    for (const plugin of plugins) plugin.init(instance);
    instance.emit("init");
    return () => instance.destroy();
  }, []);

  return [ref.current, api.current];
}

/** Props for the track element (embla's container): slide metrics in, offset out. */
export function useEmblaTrack(
  api: EmblaCarouselType | undefined,
  children: ReactNode,
): Record<string, unknown> {
  const theme = useTheme();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const engine = api ? ENGINES.get(api) : undefined;
  const slides = Children.toArray(children).filter(isValidElement);
  const first = slides[0]?.props as { className?: unknown } | undefined;
  const basis = translate(
    cn("basis-full", typeof first?.className === "string" ? first.className : undefined),
    theme.colors,
    theme.radius,
    { attrs: {}, groups: {}, dark: theme.mode === "dark", viewportWidth: theme.viewportWidth },
  ).view.width;
  const fraction = typeof basis === "string" ? Number.parseFloat(basis) / 100 : 1;
  const changed =
    engine !== undefined && (engine.count !== slides.length || engine.fraction !== fraction);
  if (engine) {
    engine.count = slides.length;
    engine.fraction = fraction;
  }
  useEffect(() => {
    if (changed) api?.reInit();
  });
  const vertical = engine?.options.axis === "y";
  const snap = engine
    ? (snapPositions(engine.count, engine.fraction, engine.options)[engine.index] ?? 0)
    : 0;
  const offset = snap * (vertical ? size.height : size.width) * fraction;
  return {
    viewStyle: vertical
      ? { position: "relative", top: -offset }
      : { position: "relative", left: -offset },
    onLayout: (bounds: Bounds) =>
      setSize((current) =>
        current.width === bounds.width && current.height === bounds.height
          ? current
          : { width: bounds.width, height: bounds.height },
      ),
  };
}
