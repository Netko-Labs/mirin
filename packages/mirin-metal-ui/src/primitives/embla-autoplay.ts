/**
 * `embla-carousel-autoplay` on Metal: a timer that advances the carousel
 * every `delay` ms (wrapping to the first slide at the end). `stop`,
 * `play`, and `reset` follow the plugin's semantics: `reset` restarts the
 * timer only while autoplay is active.
 */

import type { EmblaCarouselType, EmblaPluginType } from "./embla.tsx";

export type AutoplayOptionsType = {
  delay?: number;
  jump?: boolean;
  playOnInit?: boolean;
  stopOnInteraction?: boolean;
  stopOnMouseEnter?: boolean;
  stopOnFocusIn?: boolean;
  stopOnLastSnap?: boolean;
  active?: boolean;
};

export interface AutoplayType extends EmblaPluginType {
  name: "autoplay";
  options: AutoplayOptionsType;
  play: (jump?: boolean) => void;
  stop: () => void;
  reset: () => void;
  isPlaying: () => boolean;
  timeUntilNext: () => number | null;
}

export default function Autoplay(userOptions: AutoplayOptionsType = {}): AutoplayType {
  const options: AutoplayOptionsType = {
    delay: 4000,
    jump: false,
    playOnInit: true,
    stopOnInteraction: true,
    stopOnMouseEnter: false,
    stopOnLastSnap: false,
    ...userOptions,
  };
  const delay = options.delay ?? 4000;
  let api: EmblaCarouselType | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active = false;
  let startedAt = 0;

  const tick = () => {
    if (!api) return;
    if (api.canScrollNext()) api.scrollNext(options.jump);
    else if (options.stopOnLastSnap) stop();
    else api.scrollTo(0, options.jump);
    startedAt = Date.now();
  };
  const clear = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  function play() {
    if (!api) return;
    clear();
    active = true;
    startedAt = Date.now();
    timer = setInterval(tick, delay);
  }
  function stop() {
    clear();
    active = false;
  }
  function reset() {
    if (active) play();
  }

  return {
    name: "autoplay",
    options,
    init(instance) {
      api = instance;
      if (options.playOnInit && options.active !== false) play();
    },
    destroy() {
      stop();
      api = undefined;
    },
    play,
    stop,
    reset,
    isPlaying: () => active,
    timeUntilNext: () => (active ? Math.max(0, delay - (Date.now() - startedAt)) : null),
  };
}
