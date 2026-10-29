/**
 * Open a link with the desktop's default handler (`<a href>` without an
 * `onClick`). Only http(s) and mailto URLs are passed on; arguments are
 * structured, never shell text.
 */

export function openExternal(href: string): void {
  if (!/^(https?:\/\/|mailto:)/i.test(href)) return;
  const command =
    process.platform === "darwin"
      ? ["open", href]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", href]
        : ["xdg-open", href];
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // No handler installed; nothing useful to do.
  }
}
