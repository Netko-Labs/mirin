import { app, devtools, globalShortcut, menu, Tray } from "mirinjs";
import { router } from "./rpc.ts";

const mirin = app.serve(router);

/** The global hotkey, named once so the devtools slice below cannot drift from it. */
const HOTKEY = "Cmd+Shift+K";

const deepLinks: string[] = [];

// Deep links: `mirin-sink://…` (declared in mirin.config.ts urlSchemes) launches
// or focuses the app; forward each URL to the UI's event log. Try, in a terminal:
//   open "mirin-sink://hello?from=terminal"
app.on("open-url", (url) => {
  deepLinks.push(url);
  mirin.rpc.deepLink.broadcast({ url });
  // Deep links are invisible in the page, so surface them on the stream. The stream
  // is plaintext on disk — a sensitive URL (OAuth redirect) should log only its path.
  devtools.event({ type: "deep-link", msg: url });
});

let tray: Tray | undefined;

// The app shell is invisible to the DOM; `expose` lifts it into the inspector's
// `/state` (docs/agent-devtools.md).
devtools.expose("shell", () => ({
  tray: tray !== undefined,
  hotkey: HOTKEY,
  deepLinks,
  windows: app.windows.all().map((window) => ({ id: window.id, name: window.name })),
}));

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
  globalShortcut.register(HOTKEY, () => mirin.rpc.shortcutFired.broadcast({ name: HOTKEY }));
});

app.on("window-all-closed", () => {
  tray?.destroy();
  app.quit();
});
