/** Retains the latest pre-core-ready Dock visibility request. */
export class DockPolicy {
  #pending: boolean | undefined;

  set(visible: boolean, coreReady: boolean, apply: (visible: boolean) => void): void {
    if (coreReady) {
      apply(visible);
      return;
    }
    this.#pending = visible;
  }

  flush(apply: (visible: boolean) => void): void {
    const visible = this.#pending;
    this.#pending = undefined;
    if (visible !== undefined) apply(visible);
  }
}
