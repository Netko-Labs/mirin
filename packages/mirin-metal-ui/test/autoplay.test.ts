import { describe, expect, test } from "bun:test";
import type {
  EmblaCarouselType,
  EmblaEventListener,
  EmblaEventType,
} from "../src/primitives/embla.tsx";
import Autoplay from "../src/primitives/embla-autoplay.ts";

/** Enough of embla's API for the plugin: listeners and the scroll calls. */
function carousel(): { api: EmblaCarouselType; emit: (event: EmblaEventType) => void } {
  const listeners = new Map<EmblaEventType, Set<EmblaEventListener>>();
  const api = {
    on(event: EmblaEventType, listener: EmblaEventListener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return api;
    },
    off(event: EmblaEventType, listener: EmblaEventListener) {
      listeners.get(event)?.delete(listener);
      return api;
    },
    canScrollNext: () => true,
    scrollNext: () => {},
    scrollTo: () => {},
  } as unknown as EmblaCarouselType;
  const emit = (event: EmblaEventType) => {
    for (const listener of listeners.get(event) ?? []) listener(api, event);
  };
  return { api, emit };
}

describe("Autoplay", () => {
  test("a pointerDown stops it for good with stopOnInteraction", () => {
    const { api, emit } = carousel();
    const autoplay = Autoplay({ delay: 10_000 });
    autoplay.init(api);
    expect(autoplay.isPlaying()).toBe(true);
    emit("pointerDown");
    emit("pointerUp");
    expect(autoplay.isPlaying()).toBe(false);
    autoplay.destroy();
  });

  test("without stopOnInteraction a press pauses it until the pointer is up", () => {
    const { api, emit } = carousel();
    const autoplay = Autoplay({ delay: 10_000, stopOnInteraction: false });
    autoplay.init(api);
    emit("pointerDown");
    expect(autoplay.timeUntilNext()).not.toBeNull();
    emit("pointerUp");
    expect(autoplay.isPlaying()).toBe(true);
    autoplay.destroy();
  });

  test("stopOnMouseEnter pauses on hover and resumes on leave", () => {
    const { api } = carousel();
    const autoplay = Autoplay({
      delay: 10_000,
      stopOnInteraction: false,
      stopOnMouseEnter: true,
    });
    autoplay.init(api);
    autoplay.hover(true);
    autoplay.hover(false);
    expect(autoplay.isPlaying()).toBe(true);
    const stopping = Autoplay({ delay: 10_000, stopOnMouseEnter: true });
    stopping.init(api);
    stopping.hover(true);
    stopping.hover(false);
    expect(stopping.isPlaying()).toBe(false);
    autoplay.destroy();
    stopping.destroy();
  });

  test("hover does nothing without stopOnMouseEnter", () => {
    const { api } = carousel();
    const autoplay = Autoplay({ delay: 10_000 });
    autoplay.init(api);
    autoplay.hover(true);
    expect(autoplay.isPlaying()).toBe(true);
    autoplay.destroy();
  });
});
