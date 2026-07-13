import { logger } from "../../logger.ts";

type Listener<P> = (payload: P) => void;

export class Emitter<Events extends Record<string, unknown>> {
  #listeners = new Map<keyof Events, Set<Listener<unknown>>>();

  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener as Listener<unknown>);
    return () => {
      set.delete(listener as Listener<unknown>);
    };
  }

  async *events<K extends keyof Events>(type: K): AsyncIterableIterator<Events[K]> {
    const queue: Events[K][] = [];
    let wake: (() => void) | undefined;
    const off = this.on(type, (payload) => {
      queue.push(payload);
      wake?.();
    });
    try {
      while (true) {
        while (queue.length) yield queue.shift()!;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      off();
    }
  }

  protected emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    // One throwing subscriber must not stop the rest of the fan-out.
    for (const fn of this.#listeners.get(type) ?? []) {
      try {
        fn(payload);
      } catch (err) {
        logger.error(`event handler for "${String(type)}" threw`, err);
      }
    }
  }
}
