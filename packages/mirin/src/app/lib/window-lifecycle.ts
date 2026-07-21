interface PendingCreation {
  resolve(): void;
  reject(error: Error): void;
}

interface WindowRegistration {
  id: number;
  name: string | undefined;
}

/** Correlates asynchronous native window creation results with create calls. */
export class WindowCreationTracker {
  #created = new Set<number>();
  #completed = new Set<number>();
  #failed = new Map<number, Error>();
  #pending = new Map<number, PendingCreation>();

  waitFor(id: number): Promise<void> {
    if (this.#created.delete(id)) {
      this.#completed.add(id);
      return Promise.resolve();
    }
    const failure = this.#failed.get(id);
    if (failure) {
      this.#failed.delete(id);
      return Promise.reject(failure);
    }
    return new Promise<void>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  markCreated(id: number): void {
    this.#failed.delete(id);
    const pending = this.#pending.get(id);
    if (!pending) {
      this.#created.add(id);
      return;
    }
    this.#pending.delete(id);
    this.#completed.add(id);
    pending.resolve();
  }

  reject(id: number, error: Error): void {
    if (this.#completed.delete(id)) return;
    this.#created.delete(id);
    const pending = this.#pending.get(id);
    if (!pending) {
      this.#failed.set(id, error);
      return;
    }
    this.#pending.delete(id);
    pending.reject(error);
  }
}

/** Remove only the handle currently registered under its id/name. */
export function unregisterWindow<T extends WindowRegistration>(
  byId: Map<number, T>,
  byName: Map<string, T>,
  handle: T,
): void {
  if (byId.get(handle.id) === handle) byId.delete(handle.id);
  if (handle.name && byName.get(handle.name) === handle) byName.delete(handle.name);
}

/** Open every automatic manifest window and wait for native creation. */
export async function openAutomaticWindows<T extends { open?: "auto" | "manual" }>(
  windows: readonly T[],
  open: (window: T) => Promise<unknown>,
): Promise<void> {
  await Promise.all(windows.filter((window) => window.open !== "manual").map(open));
}

/** Resolve public readiness or route an automatic-window failure to orderly quit. */
export function runAutomaticWindowStartup<T extends { open?: "auto" | "manual" }>(
  windows: readonly T[],
  open: (window: T) => Promise<unknown>,
  ready: () => void,
  quit: (error: unknown) => void,
): void {
  void openAutomaticWindows(windows, open).then(ready, quit);
}
