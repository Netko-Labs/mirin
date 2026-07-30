/**
 * Dev-session bookkeeping for the CLI side of the agent devtools
 * (docs/agent-devtools.md).
 *
 * The CLI owns `session.json` (app metadata plus a phase timeline) and
 * `exit.json` (the post-mortem); the app's Bun Worker owns `inspector.json` and
 * `events.jsonl`. One writer per file, so nothing needs locking.
 *
 * The timeline matters more than it looks: when an agent's app never appears, the
 * question is always "how far did startup get?". Phases answer that from a file,
 * without a terminal to read.
 */

import {
  createSessionDir,
  DEV_SESSION_ENV,
  type InspectorEndpoint,
  newSessionId,
  readEventsFile,
  readInspectorEndpoint,
  type SessionInfo,
  type SessionPaths,
  type SessionPhase,
  writeCurrentSession,
  writeSessionExit,
  writeSessionInfo,
} from "mirinjs/devtools/session";

/** Events kept in `exit.json`, so the post-mortem is self-contained. */
const EXIT_TAIL = 50;

/** A phase in progress; call exactly one terminal method. */
export interface PhaseHandle {
  ok(detail?: string): void;
  fail(detail?: string): void;
}

export interface DevSessionInit {
  projectDir: string;
  appName: string;
  appId: string;
  version?: string;
  devUrl?: string;
}

export class DevSession {
  readonly paths: SessionPaths;
  #info: SessionInfo;

  private constructor(paths: SessionPaths, info: SessionInfo) {
    this.paths = paths;
    this.#info = info;
  }

  /**
   * Create `.mirin/dev/<id>/` and point `current.json` at it. Failures are not
   * fatal: a project on a read-only volume should still be able to run `mirin dev`,
   * just without the session artifacts.
   */
  static create(init: DevSessionInit): DevSession | undefined {
    const now = Date.now();
    const id = newSessionId(now, process.pid);
    try {
      const paths = createSessionDir(init.projectDir, id);
      const info: SessionInfo = {
        version: 1,
        id,
        app: {
          name: init.appName,
          id: init.appId,
          ...(init.version !== undefined ? { version: init.version } : {}),
        },
        projectDir: init.projectDir,
        startedAt: now,
        dev: true,
        ...(init.devUrl !== undefined ? { devUrl: init.devUrl } : {}),
        phases: [],
      };
      const session = new DevSession(paths, info);
      session.#save();
      writeCurrentSession(init.projectDir, paths.dir);
      return session;
    } catch {
      return undefined;
    }
  }

  /** Env additions that point the app process at this session. */
  env(): Record<string, string> {
    return { [DEV_SESSION_ENV]: this.paths.dir };
  }

  /**
   * Wait for the app's Worker to publish `inspector.json`. The app binds the
   * inspector after the CLI has already spawned it, so the endpoint only becomes
   * knowable a moment later; give up quietly rather than delay the dev loop.
   */
  async waitForInspector(timeoutMs = 10_000): Promise<InspectorEndpoint | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const endpoint = readInspectorEndpoint(this.paths);
      if (endpoint !== undefined) return endpoint;
      await Bun.sleep(100);
    }
    return undefined;
  }

  /** Record the start of a phase and return its terminal handles. */
  phase(name: string): PhaseHandle {
    const startedAt = Date.now();
    this.#push({ name, status: "start", ts: startedAt });
    const settle = (status: "ok" | "fail", detail?: string): void => {
      this.#push({
        name,
        status,
        ts: Date.now(),
        ms: Date.now() - startedAt,
        ...(detail !== undefined ? { detail } : {}),
      });
    };
    return {
      ok: (detail) => settle("ok", detail),
      fail: (detail) => settle("fail", detail),
    };
  }

  setDevUrl(devUrl: string): void {
    this.#info = { ...this.#info, devUrl };
    this.#save();
  }

  setPid(pid: number): void {
    this.#info = { ...this.#info, pid };
    this.#save();
  }

  /**
   * Write the post-mortem. The tail is read back from `events.jsonl` so a reader
   * needs only this one file to know what the app was doing when it stopped.
   */
  finish(code: number | null, signal?: string): void {
    const events = readEventsFile(this.paths.events);
    try {
      writeSessionExit(this.paths, {
        version: 1,
        exitedAt: Date.now(),
        code,
        ...(signal !== undefined ? { signal } : {}),
        errorCount: events.filter((event) => event.level === "error").length,
        tail: events.slice(-EXIT_TAIL),
      });
    } catch {
      // Best effort: the app has already exited, and the exit code still reaches
      // the caller through the normal return path.
    }
  }

  #push(phase: SessionPhase): void {
    this.#info = { ...this.#info, phases: [...this.#info.phases, phase] };
    this.#save();
  }

  #save(): void {
    try {
      writeSessionInfo(this.paths, this.#info);
    } catch {
      // Diagnostics only — never interrupt the dev loop for them.
    }
  }
}
