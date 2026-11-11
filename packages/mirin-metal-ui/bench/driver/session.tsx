/**
 * The example browser on a stand-in host, driven the way a person would:
 * switch example, type in the search field, toggle the theme. No process and
 * no compositor: what is timed (or recorded) is the driver alone.
 */

import { type NativeEvent, type NativeRoot, render } from "@mirinjs/metal";
import {
  quiet,
  type StandIn,
  type StandInOptions,
  standIn,
} from "../../../mirin-metal/bench/lib/standin.ts";
import { Browser, listExamples } from "../../demo/browser.tsx";
import { ThemeProvider } from "../../src/provider.tsx";

const PRESS_BOUNDS = { x: 10, y: 10, width: 80, height: 30 };
const WINDOW = { x: 0, y: 0, width: 1280, height: 800 };

export interface Session {
  host: StandIn;
  root: NativeRoot;
  examples: string[];
  /** A press on the node with `testID`; throws when nothing has it. */
  pressOf(testID: string): NativeEvent;
  /** The field with `testID` typed in (the whole new value). */
  changeOf(testID: string, value: string): NativeEvent;
  /** Press the node with `testID`; false when nothing has it. */
  press(testID: string): boolean;
  /** Type into the field with `testID` (the whole new value). */
  type(testID: string, value: string): boolean;
  /** Wait for the driver to go quiet, answering each new `onLayout` node as a host would. */
  settle(): Promise<void>;
}

export interface SessionOptions extends StandInOptions {
  initial?: string;
  /** How long without a send counts as quiet. */
  quietMs?: number;
}

export async function openBrowser(options: SessionOptions = {}): Promise<Session> {
  const measured = new Set<string>();
  const pending: string[] = [];
  const host = standIn({
    ...options,
    onSend(line) {
      // The ids of views that ask for their layout, as the host would answer them.
      for (const match of line.matchAll(/"id":"(\d+)"[^{}]*?"onLayout":true/g)) {
        const id = match[1];
        if (id !== undefined && !measured.has(id)) {
          measured.add(id);
          pending.push(id);
        }
      }
      options.onSend?.(line);
    },
  });
  const root = render(
    <ThemeProvider>
      <Browser initial={options.initial ?? "button-demo"} />
    </ThemeProvider>,
    host.transport,
  );
  let first = true;
  const session: Session = {
    host,
    root,
    examples: listExamples(),
    pressOf(testID) {
      const id = root.nodeId(testID);
      if (!id) throw new Error(`no node with testID ${testID}`);
      return { type: "press", nodeId: id, bounds: PRESS_BOUNDS };
    },
    changeOf(testID, value) {
      const id = root.nodeId(testID);
      if (!id) throw new Error(`no node with testID ${testID}`);
      return { type: "change", nodeId: id, value };
    },
    press(testID) {
      if (!root.nodeId(testID)) return false;
      host.emit(session.pressOf(testID));
      return true;
    },
    type(testID, value) {
      if (!root.nodeId(testID)) return false;
      host.emit(session.changeOf(testID, value));
      return true;
    },
    async settle() {
      for (let round = 0; round < 8; round += 1) {
        await quiet(host, options.quietMs ?? 30);
        if (pending.length === 0) return;
        for (const id of pending.splice(0)) {
          // The first is the window's own view; the rest are popups and panels.
          const bounds = first ? WINDOW : { ...WINDOW, width: 200, height: 120 };
          first = false;
          host.emit({ type: "resize", nodeId: id, bounds });
        }
      }
    },
  };
  await session.settle();
  return session;
}
