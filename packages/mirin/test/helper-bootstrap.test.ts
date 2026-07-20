import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface MirinBridge {
  call(method: string, input: unknown): Promise<unknown>;
}

interface BootstrapWindow {
  mirin?: MirinBridge;
  innerWidth: number;
  innerHeight: number;
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  close(): void {}
}

function bootstrapSource(): string {
  const path = resolve(import.meta.dir, "../../../crates/mirin-helper/src/bootstrap.js");
  return readFileSync(path, "utf8")
    .replace("__PORT__", "4123")
    .replace("__TOKEN__", "test-token")
    .replace("__WEBVIEW__", "7");
}

function installBridge(): {
  window: BootstrapWindow & { mirin: MirinBridge };
  reconnects: Array<() => void>;
} {
  FakeWebSocket.instances = [];
  const reconnects: Array<() => void> = [];
  const window: BootstrapWindow = { innerWidth: 800, innerHeight: 600 };
  const document = {
    documentElement: { style: { cursor: "" } },
    addEventListener: () => {},
  };
  const setTimeout = (callback: () => void): number => {
    reconnects.push(callback);
    return reconnects.length;
  };
  const execute = new Function(
    "window",
    "document",
    "WebSocket",
    "setTimeout",
    "console",
    bootstrapSource(),
  ) as (
    window: BootstrapWindow,
    document: typeof document,
    WebSocket: typeof FakeWebSocket,
    setTimeout: (callback: () => void, delay: number) => number,
    console: Console,
  ) => void;

  execute(window, document, FakeWebSocket, setTimeout, console);
  if (!window.mirin) throw new Error("bootstrap did not install window.mirin");
  return { window: window as BootstrapWindow & { mirin: MirinBridge }, reconnects };
}

test("disconnect rejects in-flight calls and does not replay them", async () => {
  const { window, reconnects } = installBridge();
  const firstSocket = FakeWebSocket.instances[0];
  expect(firstSocket).toBeDefined();

  const firstCall = window.mirin.call("notes.save", { title: "first" });
  const firstResult = firstCall.then(
    () => null,
    (error: unknown) => error,
  );
  firstSocket.onopen?.();
  expect(firstSocket.sent).toHaveLength(1);

  firstSocket.onclose?.();
  const disconnectError = await firstResult;
  expect(disconnectError).toBeInstanceOf(Error);
  expect((disconnectError as Error).message).toBe("rpc disconnected");

  const futureCall = window.mirin.call("notes.save", { title: "future" });
  expect(reconnects).toHaveLength(1);
  reconnects.shift()?.();

  const secondSocket = FakeWebSocket.instances[1];
  expect(secondSocket).toBeDefined();
  secondSocket.onopen?.();
  expect(secondSocket.sent).toHaveLength(1);

  const replayed = JSON.parse(secondSocket.sent[0]) as { id: number; input: { title: string } };
  expect(replayed.id).toBe(2);
  expect(replayed.input.title).toBe("future");

  secondSocket.onmessage?.({
    data: JSON.stringify({ kind: "response", id: 2, ok: true, result: "saved" }),
  });
  expect(await futureCall).toBe("saved");
});
