import { rpc } from "mirin/rpc";

/** The app's RPC surface — imported by the main process (handlers) and, as a
 *  type only, by the React UI (`mirin/client`). */
export const router = rpc.router({
  greet: rpc.query(async (name: string, ctx) => {
    return `Hello, ${name}! (from webview #${ctx.webview}, Bun ${Bun.version})`;
  }),

  addTodo: rpc.mutation(async (text: string) => {
    return { id: Math.floor(performance.now()), text };
  }),

  // main -> UI push
  tick: rpc.event<{ count: number }>(),
});

export type Router = typeof router;
