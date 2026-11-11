/**
 * `embla-carousel-autoplay` on Metal: a timer that advances the carousel
 * every `delay` ms (wrapping to the first slide at the end). `stop`,
 * `play`, and `reset` follow the plugin's semantics: `reset` restarts the
 * timer only while autoplay is active. Like the plugin, a `pointerDown` on
 * the carousel stops it for good with `stopOnInteraction` (else it pauses
 * until `pointerUp`), and with `stopOnMouseEnter` the pointer over the track
 * pauses it (resuming on leave unless `stopOnInteraction`). The stand-in has
 * no drag, so `pointerDown` comes only from code that emits it.
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
  /** The pointer entered (`true`) or left the track (`useEmblaTrack` calls it). */
  hover: (inside: boolean) => void;
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
    paused = false;
  }
  function reset() {
    if (active) play();
  }
  /** Pause without forgetting that autoplay is on, for a press or a hover. */
  let paused = false;
  function pause() {
    if (!active) return;
    clear();
    paused = true;
  }
  function resume() {
    if (!paused) return;
    paused = false;
    play();
  }
  const interaction = () => {
    if (options.stopOnInteraction) stop();
    else pause();
  };
  const released = () => {
    if (!options.stopOnInteraction) resume();
  };
  function hover(inside: boolean) {
    if (!options.stopOnMouseEnter) return;
    if (inside) interaction();
    else resume();
  }

  return {
    name: "autoplay",
    options,
    init(instance) {
      api = instance;
      instance.on("pointerDown", interaction).on("pointerUp", released);
      if (options.playOnInit && options.active !== false) play();
    },
    destroy() {
      api?.off("pointerDown", interaction).off("pointerUp", released);
      stop();
      api = undefined;
    },
    hover,
    play,
    stop,
    reset,
    isPlaying: () => active,
    timeUntilNext: () => (active ? Math.max(0, delay - (Date.now() - startedAt)) : null),
  };
}
