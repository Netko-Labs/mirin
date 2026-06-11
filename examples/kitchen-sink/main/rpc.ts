import { rpc } from "mirinjs/rpc";
import { app, dialog, clipboard, menu } from "mirinjs";

/** Window controls act on the calling window (ctx.webview === window id). */
function callerWindow(webview: number) {
  return app.windows.byId(webview);
}

export const router = rpc.router({
  // --- dialogs ---
  openFile: rpc.query(async () =>
    dialog.openFile({ message: "Choose one or more files", multiple: true }),
  ),
  saveFile: rpc.query(async () => dialog.saveFile({ defaultName: "untitled.txt" })),
  messageBox: rpc.query(async () =>
    dialog.message({
      message: "Hello from mirin",
      detail: "This is a native NSAlert driven from the Bun process.",
      buttons: ["Great", "Meh", "Cancel"],
    }),
  ),

  // --- clipboard ---
  clipboardRead: rpc.query(async () => clipboard.readText()),
  clipboardWrite: rpc.mutation(async (text: string) => {
    clipboard.writeText(text);
  }),

  // --- window controls ---
  minimize: rpc.mutation(async (_: null, ctx) => {
    await callerWindow(ctx.webview)?.minimize();
  }),
  toggleFullscreen: rpc.mutation(async (_: null, ctx) => {
    await callerWindow(ctx.webview)?.toggleFullscreen();
  }),
  setAlwaysOnTop: rpc.mutation(async (on: boolean, ctx) => {
    await callerWindow(ctx.webview)?.setAlwaysOnTop(on);
  }),
  openSecondWindow: rpc.mutation(async () => {
    await app.windows.open({
      url: "app://ui/index.html",
      title: "Second Window",
      width: 560,
      height: 460,
    });
  }),

  // --- context menu ---
  showContextMenu: rpc.mutation(async () => {
    menu.popup([
      { label: "Reload", click: () => app.rpc.menuAction?.broadcast({ action: "reload" }) },
      { label: "Say Hello", click: () => app.rpc.menuAction?.broadcast({ action: "hello" }) },
      { type: "separator" },
      { role: "copy" },
      { role: "paste" },
    ]);
  }),

  // --- push channels (main -> UI) ---
  menuAction: rpc.event<{ action: string }>(),
  trayAction: rpc.event<{ action: string }>(),
  shortcutFired: rpc.event<{ name: string }>(),
});

export type Router = typeof router;
