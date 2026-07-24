interface StartupCallbacks {
  signalReady: () => void;
  initialize: () => void;
  defer?: (task: () => void) => void;
}

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
  requestQuit();
  notifyComplete();
}
