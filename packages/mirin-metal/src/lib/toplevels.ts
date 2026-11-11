/**
 * The `shell.toplevels` capability's wire format: the host reports every
 * window as `{"type":"toplevel","toplevel":{...}}` and closed ones as
 * `{"type":"toplevel-closed","id":N}` (crates/mirin-metal/src/toplevels.rs).
 */

import type { Toplevel, ToplevelAction, ToplevelEvent } from "../types.ts";

function isWindowId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseToplevel(value: unknown): Toplevel | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, title, appId, activated, minimized, maximized, fullscreen } = value as Record<
    string,
    unknown
  >;
  if (!isWindowId(id) || typeof title !== "string" || typeof appId !== "string") return null;
  const flags = [activated, minimized, maximized, fullscreen];
  if (!flags.every((flag) => typeof flag === "boolean")) return null;
  return {
    id,
    title,
    appId,
    activated: activated as boolean,
    minimized: minimized as boolean,
    maximized: maximized as boolean,
    fullscreen: fullscreen as boolean,
  };
}

/** A toplevel event from an already-parsed host line, or null for any other line. */
export function parseToplevelEvent(record: Record<string, unknown>): ToplevelEvent | null {
  if (record.type === "toplevel") {
    const toplevel = parseToplevel(record.toplevel);
    return toplevel ? { type: "changed", toplevel } : null;
  }
  if (record.type === "toplevel-closed") {
    return isWindowId(record.id) ? { type: "closed", id: record.id } : null;
  }
  return null;
}

/** The stdin line asking the host to act on window `id`. */
export function toplevelCommand(id: number, action: ToplevelAction): string {
  return JSON.stringify({ toplevel: { id, action } });
}
