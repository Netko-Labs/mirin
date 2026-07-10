import { app, clipboard, dialog, menu } from "mirinjs";
import { rpc } from "mirinjs/rpc";
import { runOnce, serverRequest, startTicker, stopTicker } from "./tools.ts";

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
  maximize: rpc.mutation(async (_: null, ctx) => {
    await callerWindow(ctx.webview)?.maximize();
  }),
  close: rpc.mutation(async (_: null, ctx) => {
    await callerWindow(ctx.webview)?.close();
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

  // --- sidecar (bundled binary spawned via app.sidecar) ---
  // One-shot: spawn with args, read stdout, exit.
  sidecarVersion: rpc.query(async () => (await runOnce(["--version"])).stdout),
  sidecarEcho: rpc.query(async (text: string) => (await runOnce(["echo", text])).stdout),
  // Error path: capture stderr + non-zero exit code.
  sidecarFail: rpc.query(async () => runOnce(["fail"])),
  // Persistent NDJSON server: one long-lived sidecar, request/response per call.
  sidecarServer: rpc.mutation(async ({ op, text }: { op: string; text: string }) =>
    serverRequest(op, text),
  ),
  // Streaming emitter: start `tool count`, forward ticks to the UI; stop kills it.
  sidecarStart: rpc.mutation(async () => {
    return startTicker((n) => app.rpc.sidecarTick?.broadcast({ n }));
  }),
  sidecarStop: rpc.mutation(async () => {
    stopTicker();
  }),

  // --- push channels (main -> UI) ---
  menuAction: rpc.event<{ action: string }>(),
  trayAction: rpc.event<{ action: string }>(),
  shortcutFired: rpc.event<{ name: string }>(),
  sidecarTick: rpc.event<{ n: string }>(),
  deepLink: rpc.event<{ url: string }>(),
});

export type Router = typeof router;
