interface StartupCallbacks {
  signalReady: () => void;
  initialize: () => void;
  defer?: (task: () => void) => void;
}

export class UpdaterProcessTerminalError extends Error {
  constructor() {
    super("updater process is in terminal handoff");
  }
}

export class UpdaterProcessLifecycle {
  #applying = false;
  #terminal = false;
  #terminalListeners = new Set<() => void>();

  get isTerminal(): boolean {
    return this.#terminal;
  }

  assertActive(): void {
    if (this.#terminal) {
      throw new UpdaterProcessTerminalError();
    }
  }

  beginApply(): () => void {
    this.assertActive();
    if (this.#applying) {
      throw new Error("another updater instance is already applying an update");
    }
    this.#applying = true;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (!this.#terminal) this.#applying = false;
    };
  }

  onTerminal(listener: () => void): () => void {
    if (this.#terminal) {
      listener();
      return () => {};
    }
    this.#terminalListeners.add(listener);
    return () => {
      this.#terminalListeners.delete(listener);
    };
  }

  enterTerminal(requestQuit: () => void, notifyComplete: () => void): void {
    this.#terminal = true;
    this.#applying = true;
    for (const listener of this.#terminalListeners) {
      try {
        listener();
      } catch {
        // Terminal shutdown cannot depend on another updater instance's callback.
      }
    }
    this.#terminalListeners.clear();
    requestQuit();
    notifyComplete();
  }
}

export const updaterProcessLifecycle = new UpdaterProcessLifecycle();

/**
 * A replacement receipt must not wait behind synchronous user `app.ready`
 * listeners. Only best-effort startup cleanup is deferred.
 */
export function acknowledgeUpdaterStartup(callbacks: StartupCallbacks): void {
  callbacks.signalReady();
  (callbacks.defer ?? queueMicrotask)(callbacks.initialize);
}

/**
 * Once the detached helper accepts the apply, request terminal native shutdown
 * before notifying synchronous user listeners.
 */
export function enterTerminalUpdateHandoff(
  requestQuit: () => void,
  notifyComplete: () => void,
): void {
  updaterProcessLifecycle.enterTerminal(requestQuit, notifyComplete);
}
