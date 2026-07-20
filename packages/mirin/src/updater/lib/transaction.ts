export interface PendingGeneration {
  generation: number;
  version: string;
  tarHash: string;
}

export interface StagedGeneration extends PendingGeneration {
  staged: string;
  workDir: string;
}

export class UpdateTransactionState {
  #generation = 0;
  #pending: PendingGeneration | null = null;
  #staged: StagedGeneration | null = null;
  #downloading: number | null = null;
  #applying = false;

  get pending(): PendingGeneration | null {
    return this.#pending;
  }

  get staged(): StagedGeneration | null {
    return this.#staged;
  }

  get isApplying(): boolean {
    return this.#applying;
  }

  beginCheck(): number {
    if (this.#applying) throw new Error("cannot check for updates while applying");
    this.#generation += 1;
    this.#pending = null;
    this.#staged = null;
    return this.#generation;
  }

  commitCheck(generation: number, version: string, tarHash: string): PendingGeneration | null {
    if (generation !== this.#generation) return null;
    this.#pending = { generation, version, tarHash };
    return this.#pending;
  }

  beginDownload(): PendingGeneration {
    if (this.#applying) throw new Error("cannot download an update while applying");
    if (this.#downloading !== null) throw new Error("an update download is already in progress");
    if (!this.#pending) throw new Error("no update to download — call checkForUpdate() first");
    this.#downloading = this.#pending.generation;
    return { ...this.#pending };
  }

  completeDownload(snapshot: PendingGeneration, staged: string, workDir: string): boolean {
    if (this.#downloading === snapshot.generation) this.#downloading = null;
    if (!this.matches(snapshot)) return false;
    this.#staged = { ...snapshot, staged, workDir };
    return true;
  }

  failDownload(snapshot: PendingGeneration): boolean {
    if (this.#downloading === snapshot.generation) this.#downloading = null;
    if (!this.matches(snapshot)) return false;
    this.#pending = null;
    this.#staged = null;
    return true;
  }

  beginApply(): StagedGeneration {
    if (this.#applying) throw new Error("an update apply is already in progress");
    if (this.#downloading !== null) throw new Error("cannot apply while an update is downloading");
    if (!this.#staged || !this.matches(this.#staged)) {
      throw new Error("no staged update — call download() first");
    }
    this.#applying = true;
    return { ...this.#staged };
  }

  finishApply(success: boolean): void {
    this.#applying = false;
    if (!success) {
      this.#pending = null;
      this.#staged = null;
    }
  }

  isCurrent(snapshot: PendingGeneration): boolean {
    return this.matches(snapshot);
  }

  invalidate(): StagedGeneration | null {
    const staged = this.#staged;
    this.#generation += 1;
    this.#pending = null;
    this.#staged = null;
    return staged;
  }

  private matches(snapshot: PendingGeneration): boolean {
    return (
      this.#pending?.generation === snapshot.generation &&
      this.#pending.version === snapshot.version &&
      this.#pending.tarHash === snapshot.tarHash
    );
  }
}

export class SingleFlight<T> {
  #operation: Promise<T> | null = null;

  get isRunning(): boolean {
    return this.#operation !== null;
  }

  run(operation: () => Promise<T>): Promise<T> {
    if (this.#operation) return this.#operation;
    const promise = operation().finally(() => {
      if (this.#operation === promise) this.#operation = null;
    });
    this.#operation = promise;
    return promise;
  }
}

export function generationDirectoryName(snapshot: PendingGeneration): string {
  return `generation-${snapshot.generation}-${snapshot.version}-${snapshot.tarHash.slice(0, 16)}`;
}
