import { afterEach, describe, expect, test } from "bun:test";
import { rpcEmitters } from "../src/app/lib/rpc-emitters.ts";
import type { BroadcastEmitters } from "../src/app/types.ts";
import { type ClientFor, client } from "../src/client.ts";
import { type Router, rpc } from "../src/rpc.ts";
import { RpcServer } from "../src/rpc-server.ts";

// The router from Netko-Labs/mirin#21: two controllers composed under their names.
const windowController = rpc.router({
  min: rpc.mutation((_: null) => "minimized"),
  close: rpc.mutation((_: null) => "closed"),
  focused: rpc.event<{ id: number }>(),
});

const installController = rpc.router({
  getVersionList: rpc.query((_: null) => ["1.0.0", "1.1.0"]),
  close: rpc.mutation((_: null) => "install closed"),
  channels: rpc.router({
    get: rpc.query((name: string) => `channel ${name}`),
  }),
});

const controller = rpc.router({
  greet: rpc.query((name: string) => `Hello, ${name}!`),
  window: windowController,
  install: installController,
});

type Controller = typeof controller;

// Type-level checks: these lines fail `tsc` if the inference breaks.
type Api = ClientFor<Controller>;
const typed = {
  versions: (api: Api): Promise<string[]> => api.install.getVersionList(null),
  channel: (api: Api): Promise<string> => api.install.channels.get("beta"),
  focused: (api: Api) => api.window.focused.on((payload: { id: number }) => payload.id),
  broadcast: (emitters: BroadcastEmitters<Controller>) =>
    emitters.window.focused.broadcast({ id: 1 }),
  // @ts-expect-error: no such procedure
  missing: (api: Api) => api.window.maximize(null),
  // @ts-expect-error: channels.get takes a string
  wrongInput: (api: Api) => api.install.channels.get(1),
  // @ts-expect-error: a nested router is not callable
  router: (api: Api) => api.install(null),
  // @ts-expect-error: focused carries { id: number }
  wrongPayload: (emitters: BroadcastEmitters<Controller>) =>
    emitters.window.focused.broadcast({ id: "1" }),
};
void typed;

describe("rpc.router", () => {
  test("nested routers keep their procedures apart", () => {
    expect(controller.routes.window.routes.close).not.toBe(controller.routes.install.routes.close);
  });

  test("two procedures with the same path are an error", () => {
    expect(() =>
      rpc.router({
        "window.min": rpc.mutation((_: null) => 1),
        window: rpc.router({ min: rpc.mutation((_: null) => 2) }),
      }),
    ).toThrow('two procedures are named "window.min"');
  });

  test("a nested router can't use the names the client and emitters need", () => {
    for (const name of ["on", "then", "emit", "broadcast", "apply", "bind", "call", "toString"]) {
      expect(() =>
        rpc.router({ window: rpc.router({ [name]: rpc.query((_: null) => 1) }) }),
      ).toThrow(`"window.${name}" can't be used inside a nested router`);
    }
    // At the top level they stay allowed, as before.
    expect(() => rpc.router({ on: rpc.query((_: null) => 1) })).not.toThrow();
  });

  test("a value that is neither a procedure nor a router is an error", () => {
    const routes = { window: { min: () => 1 } } as unknown as Record<string, Router>;
    expect(() => rpc.router(routes)).toThrow('"window" is not a procedure or a router');
  });

  test("a router that contains itself is an error", () => {
    const routes: Record<string, Router> = {};
    const loop = { type: "router", routes } as const;
    routes.self = loop;
    expect(() => rpc.router({ loop })).toThrow('"loop.self" contains itself');
  });

  test("one router can be served under two names", () => {
    const shared = rpc.router({ ping: rpc.query((_: null) => "pong") });
    expect(() => rpc.router({ a: shared, b: shared })).not.toThrow();
  });
});

describe("the RPC server", () => {
  let server: RpcServer | undefined;
  let socket: WebSocket | undefined;

  afterEach(async () => {
    socket?.close();
    await server?.stop();
  });

  async function connect(
    router: Router,
  ): Promise<(method: string, input: unknown) => Promise<unknown>> {
    server = new RpcServer();
    server.setRouter(router);
    const port = server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${server.token}&webview=1`);
    socket = ws;
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const waiting = new Map<
      number,
      (frame: { ok: boolean; result?: unknown; error?: string }) => void
    >();
    ws.onmessage = (message) => {
      const frame = JSON.parse(String(message.data));
      waiting.get(frame.id)?.(frame);
    };
    let next = 0;
    return (method, input) => {
      const id = ++next;
      return new Promise((resolve, reject) => {
        waiting.set(id, (frame) =>
          frame.ok ? resolve(frame.result) : reject(new Error(frame.error)),
        );
        ws.send(JSON.stringify({ kind: "request", id, method, input }));
      });
    };
  }

  test("calls nested procedures by path, and flat ones by name", async () => {
    const call = await connect(controller);
    expect(await call("greet", "you")).toBe("Hello, you!");
    expect(await call("window.close", null)).toBe("closed");
    expect(await call("install.close", null)).toBe("install closed");
    expect(await call("install.channels.get", "beta")).toBe("channel beta");
  });

  test("explains paths that are not procedures", async () => {
    const call = await connect(controller);
    await expect(call("window.maximize", null)).rejects.toThrow(
      "no such procedure: window.maximize",
    );
    await expect(call("install", null)).rejects.toThrow(
      "install is a router; call one of its procedures (install.getVersionList, install.close, install.channels.get)",
    );
    await expect(call("window.focused", null)).rejects.toThrow("window.focused is an event");
    await expect(call("constructor", null)).rejects.toThrow("no such procedure: constructor");
  });

  test("lists every procedure by path for the inspector", () => {
    server = new RpcServer();
    server.setRouter(controller);
    expect(server.routes().map((route) => route.name)).toEqual([
      "greet",
      "window.min",
      "window.close",
      "window.focused",
      "install.getVersionList",
      "install.close",
      "install.channels.get",
    ]);
  });
});

describe("the UI client", () => {
  const calls: Array<[string, unknown]> = [];
  const listening: string[] = [];
  const global = globalThis as { window?: unknown };

  function api(): ClientFor<Controller> {
    calls.length = 0;
    listening.length = 0;
    global.window = {
      mirin: {
        call: async (method: string, input: unknown) => {
          calls.push([method, input]);
          return method;
        },
        onEvent: (method: string) => {
          listening.push(method);
          return () => {};
        },
      },
    };
    return client<Controller>();
  }

  afterEach(() => {
    delete global.window;
  });

  test("calls nested procedures by their path", async () => {
    const remote = api();
    await remote.greet("you");
    await remote.window.min(null);
    await remote.install.channels.get("beta");
    expect(calls).toEqual([
      ["greet", "you"],
      ["window.min", null],
      ["install.channels.get", "beta"],
    ]);
  });

  test("listens to nested events by their path", () => {
    const remote = api();
    remote.window.focused.on(() => {});
    expect(listening).toEqual(["window.focused"]);
  });

  test("a node is still a normal function, and never a promise", async () => {
    const remote = api();
    const node = remote.window as unknown as { then?: unknown };
    expect(node.then).toBeUndefined();
    expect(await Promise.resolve(remote.window)).toBe(remote.window);
    // What debounce and friends do with a function they were handed.
    await remote.greet.apply(null, ["applied"]);
    await remote.greet.call(null, "called");
    expect(calls).toEqual([
      ["greet", "applied"],
      ["greet", "called"],
    ]);
  });
});

describe("the main-process emitters", () => {
  test("send nested events by their path", () => {
    const sent: Array<[string, unknown]> = [];
    const emitters = rpcEmitters((method, payload) => sent.push([method, payload]));
    emitters.progress?.broadcast({ pct: 1 });
    emitters.window?.focused?.emit({ id: 2 });
    expect(sent).toEqual([
      ["progress", { pct: 1 }],
      ["window.focused", { id: 2 }],
    ]);
    expect((emitters.window as unknown as { then?: unknown }).then).toBeUndefined();
  });
});
