import { randomUUID } from "node:crypto";

export interface PendingGeneration {
  generation: number;
  version: string;
  tarHash: string;
}

export interface GenerationOwner {
  pid: number;
  session: string;
}

export const UPDATER_PROCESS_SESSION = randomUUID().replaceAll("-", "");

let processGeneration = 0;

function nextProcessGeneration(): number {
  if (processGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new Error("updater generation space exhausted");
  }
  processGeneration += 1;
  return processGeneration;
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
  #handedOff = false;

  get pending(): PendingGeneration | null {
    return this.#pending;
  }

  get staged(): StagedGeneration | null {
    return this.#staged;
  }

  get isApplying(): boolean {
    return this.#applying || this.#handedOff;
  }

  get isDownloading(): boolean {
    return this.#downloading !== null;
  }

  get isHandedOff(): boolean {
    return this.#handedOff;
  }

  beginCheck(): number {
    if (this.isApplying) throw new Error("cannot check for updates while applying");
    if (this.#downloading !== null) throw new Error("cannot check while an update is downloading");
    if (this.#staged) throw new Error("cannot check while an update is staged");
    this.#generation = nextProcessGeneration();
    this.#pending = null;
    return this.#generation;
  }

  commitCheck(generation: number, version: string, tarHash: string): PendingGeneration | null {
    if (generation !== this.#generation) return null;
    this.#pending = { generation, version, tarHash };
    return this.#pending;
  }

  beginDownload(): PendingGeneration {
    if (this.isApplying) throw new Error("cannot download an update while applying");
    if (this.#downloading !== null) throw new Error("an update download is already in progress");
    if (this.#staged) throw new Error("an update is already staged");
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
    if (this.isApplying) throw new Error("an update apply is already in progress");
    if (this.#downloading !== null) throw new Error("cannot apply while an update is downloading");
    if (!this.#staged || !this.matches(this.#staged)) {
      throw new Error("no staged update — call download() first");
    }
    this.#applying = true;
    return { ...this.#staged };
  }

  finishApply(success: boolean): void {
    if (this.#handedOff) return;
    if (success) {
      this.#applying = false;
      this.#handedOff = true;
      return;
    }
    this.#applying = false;
    this.#pending = null;
    this.#staged = null;
  }

  isCurrent(snapshot: PendingGeneration): boolean {
    return this.matches(snapshot);
  }

  invalidate(): StagedGeneration | null {
    const staged = this.#staged;
    this.#generation = nextProcessGeneration();
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

interface DownloadOperationOptions<T> {
  state: UpdateTransactionState;
  snapshot: PendingGeneration;
  operation: () => Promise<T>;
  onCurrentFailure: (error: unknown) => void;
  cleanup: () => void;
}

export async function runDownloadOperation<T>(options: DownloadOperationOptions<T>): Promise<T> {
  try {
    return await options.operation();
  } catch (error) {
    const current = options.state.failDownload(options.snapshot);
    if (current) {
      try {
        options.onCurrentFailure(error);
      } catch {
        // Reporting must not replace the download failure.
      }
    }
    try {
      options.cleanup();
    } catch {
      // Cleanup must not replace the download failure.
    }
    throw error;
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

/** Reject downloads only while a check has not yet committed usable metadata. */
export function assertDownloadCanStart(
  state: UpdateTransactionState,
  checkIsRunning: boolean,
): void {
  if (checkIsRunning && state.pending === null) {
    throw new Error("cannot download while an update check is in progress");
  }
}

export function generationDirectoryName(
  snapshot: PendingGeneration,
  owner: GenerationOwner = { pid: process.pid, session: UPDATER_PROCESS_SESSION },
): string {
  return `generation-${owner.pid}-${owner.session}-${snapshot.generation}-${snapshot.version}-${snapshot.tarHash.slice(0, 16)}`;
}
