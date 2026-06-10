import { app, menu, Tray, globalShortcut } from "mirin";
import { router } from "./rpc.ts";

const mirin = app.serve(router);

let tray: Tray | undefined;

app.on("ready", () => {
  // Application menu, with click handlers routed to the UI.
  menu.setApplicationMenu([
    {
      label: "Kitchen Sink",
      submenu: [{ role: "hide" }, { type: "separator" }, { role: "quit" }],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "Cmd+N",
          click: () =>
            app.windows.open({
              url: "app://ui/index.html",
              title: "New Window",
              width: 560,
              height: 460,
            }),
        },
        {
          label: "Say Hello",
          accelerator: "Cmd+Shift+H",
          click: () => mirin.rpc.menuAction.broadcast({ action: "hello" }),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectall" },
      ],
    },
    { label: "View", submenu: [{ role: "togglefullscreen" }] },
  ]);

  // Menu-bar tray with its own menu.
  tray = new Tray({
    title: "🍴",
    tooltip: "Kitchen Sink",
    menu: [
      { label: "Say Hello", click: () => mirin.rpc.trayAction.broadcast({ action: "hello" }) },
      { type: "separator" },
      { role: "quit" },
    ],
  });

  // Global hotkey (works even when the app is in the background).
  globalShortcut.register("Cmd+Shift+K", () =>
    mirin.rpc.shortcutFired.broadcast({ name: "Cmd+Shift+K" }),
  );
});

app.on("window-all-closed", () => {
  tray?.destroy();
  app.quit();
});
