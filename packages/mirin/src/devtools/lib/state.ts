/**
 * The `/state` snapshot: what the app *is* right now — windows, RPC procedures,
 * published state — as opposed to the event stream's what-has-happened.
 */

import { app } from "../../app/index.ts";
import { maybeRuntime } from "../../runtime.ts";
import { devtoolsOptions } from "../options.ts";
import { sink } from "../sink.ts";

export interface WindowSnapshot {
  id: number;
  /** Always present — an unnamed window is named from its id (`window-2`). */
  name: string;
  /** The URL the window was last asked to load. */
  url?: string;
  title?: string;
  frame: { x: number; y: number; width: number; height: number };
  maximized: boolean;
}

export interface StateSnapshot {
  app: {
    id?: string;
    dev: boolean;
    devUrl?: string;
    pid: number;
    uptimeMs: number;
  };
  windows: WindowSnapshot[];
  rpc: { routes: { name: string; type: string }[] };
  /** Slices registered with `devtools.expose`, evaluated now. */
  exposed: Record<string, unknown>;
  stream: {
    lastSeq: number;
    /** Events evicted from the ring buffer; a nonzero value means gaps in `/logs`. */
    dropped: number;
    bufferSize: number;
    file?: string;
  };
  platform: { os: string; arch: string; bun: string };
}

const startedAt = Date.now();

function windowSnapshots(): WindowSnapshot[] {
  try {
    return app.windows.all().map((handle) => ({
      id: handle.id,
      name: handle.name,
      ...(handle.url.length > 0 ? { url: handle.url } : {}),
      ...(handle.title !== undefined ? { title: handle.title } : {}),
      frame: handle.getFrame(),
      maximized: handle.isMaximized(),
    }));
  } catch {
    // Detached, or the core never came up. An empty list is the honest answer.
    return [];
  }
}

/** Assemble the snapshot. `exposed` is supplied by the caller (the facade owns it). */
export function stateSnapshot(exposed: Record<string, unknown>): StateSnapshot {
  const runtime = maybeRuntime();
  const options = devtoolsOptions();
  return {
    app: {
      ...(runtime?.id !== undefined ? { id: runtime.id } : {}),
      dev: runtime?.isDev ?? false,
      ...(runtime?.devUrl !== undefined ? { devUrl: runtime.devUrl } : {}),
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
    },
    windows: windowSnapshots(),
    rpc: { routes: runtime?.rpc.routes() ?? [] },
    exposed,
    stream: {
      lastSeq: sink.lastSeq,
      dropped: sink.dropped,
      bufferSize: options.bufferSize,
      ...(sink.filePath !== undefined ? { file: sink.filePath } : {}),
    },
    platform: { os: process.platform, arch: process.arch, bun: Bun.version },
  };
}
