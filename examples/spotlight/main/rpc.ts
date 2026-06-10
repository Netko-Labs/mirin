import { rpc } from "mirin/rpc";
import { app } from "mirin";

/** A tiny demo "index" the panel searches over. */
const COMMANDS = [
  "Open Settings",
  "New Document",
  "Toggle Dark Mode",
  "Search Files…",
  "Run Build",
  "Restart App",
  "Copy Current URL",
  "Show Downloads",
  "Lock Screen",
  "Empty Trash",
];

export const router = rpc.router({
  search: rpc.query(async (query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMANDS.slice(0, 6);
    return COMMANDS.filter((c) => c.toLowerCase().includes(q));
  }),

  // Esc / clicking away hides the panel.
  hide: rpc.mutation(async () => {
    await app.windows.get("panel").hide();
  }),

  // Picking a command just confirms via the panel title (demo).
  run: rpc.mutation(async (command: string) => {
    console.log(`[spotlight] run: ${command}`);
    await app.windows.get("panel").hide();
  }),
});

export type Router = typeof router;
