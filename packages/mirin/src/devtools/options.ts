/**
 * Resolved devtools settings for the running process.
 *
 * Module level (not `lib/`) because sibling modules read it — `rpc-server` asks
 * whether it may record payloads — and because it must not import the runtime.
 *
 * Defaults are deliberately asymmetric: everything is on under `mirin dev` and
 * off in a packaged build. The inspector can evaluate JavaScript in a webview
 * and drive synthetic input, so shipping it enabled would hand any local process
 * full control of the app. Turning it on in production is an explicit,
 * documented opt-in (`devtools.production`).
 */

import type { DevtoolsConfig } from "../config/index.ts";
import { asBoolean, asNumber, asRecord } from "./lib/parse.ts";

export interface DevtoolsOptions {
  /** Master switch. When false, nothing is written and no server binds. */
  enabled: boolean;
  /** Bind the loopback inspector HTTP/SSE server. */
  inspector: boolean;
  /** Mirror events to `events.jsonl`. */
  file: boolean;
  /** Ring-buffer capacity. */
  bufferSize: number;
  /** Include RPC inputs/outputs in traces. Off by default: they carry app data. */
  rpcPayloads: boolean;
  /** Attach to CEF's remote-debugging port for screenshots, snapshots, and eval. */
  cdp: boolean;
}

const DEV_DEFAULTS: DevtoolsOptions = {
  enabled: true,
  inspector: true,
  file: true,
  bufferSize: 2000,
  rpcPayloads: false,
  cdp: true,
};

const PRODUCTION_DEFAULTS: DevtoolsOptions = {
  enabled: false,
  inspector: false,
  file: false,
  bufferSize: 2000,
  rpcPayloads: false,
  cdp: false,
};

let current: DevtoolsOptions = { ...PRODUCTION_DEFAULTS };

/** The live settings. Read at each use so a late `configure` is honored. */
export function devtoolsOptions(): DevtoolsOptions {
  return current;
}

/**
 * Narrow the `devtools` block of the manifest, which reaches the Worker as JSON.
 * Non-boolean and out-of-range values are dropped so a typo in `mirin.config.ts`
 * cannot silently enable a capability.
 */
export function parseDevtoolsConfig(value: unknown): DevtoolsConfig | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const bufferSize = asNumber(record.bufferSize);
  const flag = (key: keyof DevtoolsConfig): boolean | undefined => asBoolean(record[key]);
  return {
    ...(flag("enabled") !== undefined ? { enabled: flag("enabled") } : {}),
    ...(flag("inspector") !== undefined ? { inspector: flag("inspector") } : {}),
    ...(flag("file") !== undefined ? { file: flag("file") } : {}),
    ...(flag("rpcPayloads") !== undefined ? { rpcPayloads: flag("rpcPayloads") } : {}),
    ...(flag("cdp") !== undefined ? { cdp: flag("cdp") } : {}),
    ...(flag("production") !== undefined ? { production: flag("production") } : {}),
    ...(bufferSize !== undefined && Number.isSafeInteger(bufferSize) && bufferSize > 0
      ? { bufferSize }
      : {}),
  };
}

/**
 * Resolve config against the run mode. Pure, so the precedence rules are
 * directly testable: in a packaged build every capability stays off unless
 * `production` is set, and only then do the individual switches apply.
 */
export function resolveDevtoolsOptions(
  config: DevtoolsConfig | undefined,
  isDev: boolean,
): DevtoolsOptions {
  const allowed = isDev || config?.production === true;
  if (!allowed) return { ...PRODUCTION_DEFAULTS };

  const base = isDev ? DEV_DEFAULTS : { ...PRODUCTION_DEFAULTS, enabled: true };
  const bufferSize = config?.bufferSize;
  return {
    enabled: config?.enabled ?? true,
    // A production opt-in enables the same capability set as dev; the gate is
    // `production`, not each individual switch.
    inspector: config?.inspector ?? (isDev ? base.inspector : true),
    file: config?.file ?? (isDev ? base.file : true),
    bufferSize:
      typeof bufferSize === "number" && Number.isSafeInteger(bufferSize) && bufferSize > 0
        ? bufferSize
        : DEV_DEFAULTS.bufferSize,
    rpcPayloads: config?.rpcPayloads ?? base.rpcPayloads,
    cdp: config?.cdp ?? (isDev ? base.cdp : true),
  };
}

/** Install resolved settings. Called once during runtime boot. */
export function setDevtoolsOptions(options: DevtoolsOptions): void {
  current = options;
}
