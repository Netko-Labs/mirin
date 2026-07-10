/**
 * Native dialogs. Async: each call gets a `requestId` the native side echoes
 * back in a `dialog.result` event, which resolves the matching promise.
 */

import { onNativeEvent, runtime } from "./runtime.ts";

export interface OpenDialogOptions {
  message?: string;
  /** Allow selecting multiple items. */
  multiple?: boolean;
  /** Choose directories instead of files. */
  directories?: boolean;
}

export interface SaveDialogOptions {
  message?: string;
  /** Pre-filled file name. */
  defaultName?: string;
}

export interface MessageDialogOptions {
  message: string;
  detail?: string;
  /** Button titles, left to right; the result is the clicked index. */
  buttons?: string[];
}

const pending = new Map<number, (value: unknown) => void>();
let nextRequestId = 1;

onNativeEvent("dialog.result", (event) => {
  const requestId = event.requestId as number;
  const resolve = pending.get(requestId);
  if (resolve) {
    pending.delete(requestId);
    resolve(event.value);
  }
});

function show<T>(spec: Record<string, unknown>): Promise<T> {
  const requestId = nextRequestId++;
  return new Promise<T>((resolve) => {
    pending.set(requestId, resolve as (value: unknown) => void);
    runtime().core.dialogShow(JSON.stringify({ ...spec, requestId }));
  });
}

export const dialog = {
  /** Open file/directory picker; resolves to the chosen paths, or null if cancelled. */
  openFile(options: OpenDialogOptions = {}): Promise<string[] | null> {
    return show({ kind: "openFile", ...options });
  },
  /** Save panel; resolves to the chosen path, or null if cancelled. */
  saveFile(options: SaveDialogOptions = {}): Promise<string | null> {
    return show({ kind: "saveFile", ...options });
  },
  /** Alert with buttons; resolves to `{ button }` (0-based clicked index). */
  message(options: MessageDialogOptions): Promise<{ button: number }> {
    return show({ kind: "message", ...options });
  },
};
