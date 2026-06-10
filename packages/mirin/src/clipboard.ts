/** Clipboard text access (synchronous). */

import { runtime } from "./runtime.ts";

export const clipboard = {
  readText(): string {
    return runtime().core.clipboardReadText();
  },
  writeText(text: string): void {
    runtime().core.clipboardWriteText(text);
  },
};
