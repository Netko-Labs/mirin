interface PendingCreation {
  resolve(): void;
  reject(error: Error): void;
}

/** Correlates asynchronous native `window.created` events with create calls. */
export class WindowCreationTracker {
  #created = new Set<number>();
  #pending = new Map<number, PendingCreation>();

  waitFor(id: number): Promise<void> {
    if (this.#created.delete(id)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  markCreated(id: number): void {
    const pending = this.#pending.get(id);
    if (!pending) {
      this.#created.add(id);
      return;
    }
    this.#pending.delete(id);
    pending.resolve();
  }

  reject(id: number, error: Error): void {
    this.#created.delete(id);
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.reject(error);
  }
}

/** Open every automatic manifest window and wait for native creation. */
export async function openAutomaticWindows<T extends { open?: "auto" | "manual" }>(
  windows: readonly T[],
  open: (window: T) => Promise<unknown>,
): Promise<void> {
  await Promise.all(windows.filter((window) => window.open !== "manual").map(open));
}
