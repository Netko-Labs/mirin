import { rpc } from "mirinjs/rpc";

/** The app's RPC surface — imported by the main process (handlers) and, as a
 *  type only, by the UI (`mirin/client`). */
export const router = rpc.router({
  greet: rpc.query(async (name: string, ctx) => {
    return `Hello, ${name}! (from webview #${ctx.webview}, Bun ${Bun.version})`;
  }),

  // main -> UI push
  tick: rpc.event<{ count: number }>(),
});

export type Router = typeof router;
