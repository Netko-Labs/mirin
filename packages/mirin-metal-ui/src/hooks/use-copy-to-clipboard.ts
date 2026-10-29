import { useCallback, useState } from "react";

/**
 * Copy text to the desktop clipboard (wl-copy on Wayland, xclip on X11,
 * pbcopy on macOS), mirroring the shadcn hook's `{ isCopied, copyToClipboard }`.
 */
export function useCopyToClipboard({ timeout = 2000 }: { timeout?: number } = {}) {
  const [isCopied, setIsCopied] = useState(false);
  const copyToClipboard = useCallback(
    (value: string) => {
      if (!value) return;
      const command =
        process.platform === "darwin"
          ? ["pbcopy"]
          : process.env.WAYLAND_DISPLAY
            ? ["wl-copy"]
            : ["xclip", "-selection", "clipboard"];
      try {
        const child = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
        child.stdin.write(value);
        void child.stdin.end();
      } catch {
        // No clipboard tool installed.
      }
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), timeout);
    },
    [timeout],
  );
  return { isCopied, copyToClipboard };
}
