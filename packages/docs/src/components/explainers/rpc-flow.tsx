import { useEffect, useRef, useState } from "react";
import { AMBER, amber, INK, mono, PANEL, rice, shell } from "./shared";

type Phase = "idle" | "out" | "handling" | "back" | "done";

/** The typed-RPC round trip, animated on demand. */
export function RpcFlow() {
  const [phase, setPhase] = useState<Phase>("idle");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  function run() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setPhase("out");
    const at = (ms: number, next: Phase) =>
      timers.current.push(setTimeout(() => setPhase(next), ms));
    at(720, "handling");
    at(1180, "back");
    at(1900, "done");
  }

  const done = phase === "done";
  const handling = phase === "handling";
  const running = phase !== "idle" && !done;
  const returning = phase === "back" || done;

  return (
    <div style={shell} className="my-6 not-prose">
      <div className="mb-5 flex items-end justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <div
            style={{ ...mono, color: AMBER }}
            className="text-[11px] uppercase tracking-[0.16em]"
          >
            Typed RPC
          </div>
          <div className="text-[19px] font-bold tracking-[-0.02em]">One call, two processes.</div>
        </div>
        <button
          type="button"
          onClick={run}
          className="shrink-0 rounded-lg px-5 py-2.5 text-[14px] font-bold"
          style={{ background: AMBER, color: INK, opacity: running ? 0.6 : 1 }}
        >
          {running ? "Calling…" : done ? "Again" : "Call greet()"}
        </button>
      </div>

      <div className="relative grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-[90px]">
        <Panel file="ui/App.tsx" side="renderer">
          <div style={{ color: rice(0.85) }}>
            await api.<span style={{ color: "#ecbe7a" }}>greet</span>(
            <span style={{ color: "#a8c98f" }}>'world'</span>)
          </div>
          <div className="mt-2">
            <span
              className="inline-block rounded-md px-2.5 py-1 text-[11.5px] transition-opacity duration-200"
              style={{
                background: amber(0.14),
                border: `1px solid ${amber(0.35)}`,
                color: "#ecbe7a",
                opacity: done ? 1 : 0.3,
              }}
            >
              {done ? "'Hello, world!'  —  string" : "Promise<string>  —  inferred"}
            </span>
          </div>
        </Panel>

        <Panel file="main/rpc.ts" side="Bun worker">
          <div
            className="transition-all duration-200"
            style={{
              borderLeft: `2px solid ${handling ? AMBER : "transparent"}`,
              paddingLeft: 12,
              marginLeft: -14,
            }}
          >
            <div style={{ color: rice(0.85) }}>
              greet: rpc.<span style={{ color: "#ecbe7a" }}>query</span>(
              <span style={{ color: rice(0.5) }}>async</span> (name) =&gt;
            </div>
            <div style={{ color: rice(0.85) }}>
              &nbsp;&nbsp;<span style={{ color: "#a8c98f" }}>{"`Hello, ${name}!`"}</span>)
            </div>
          </div>
        </Panel>

        <div
          className="pointer-events-none absolute hidden md:block"
          style={{ left: 0, right: 0, top: 92, height: 2, background: rice(0.1) }}
        />
        <div
          className="pointer-events-none absolute hidden whitespace-nowrap rounded-full px-3 py-1 md:block"
          style={{
            top: 82,
            left: returning ? "6%" : phase === "idle" ? "6%" : "74%",
            opacity: phase === "idle" || done ? 0 : 1,
            background: AMBER,
            boxShadow: `0 6px 18px ${amber(0.35)}`,
            transition: "left 700ms cubic-bezier(0.4,0,0.2,1), opacity 200ms ease",
          }}
        >
          <span style={{ ...mono, color: INK, fontSize: 11, fontWeight: 500 }}>
            {returning ? "'Hello, world!'" : "'world'"}
          </span>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <Note title="The argument">
          Serialized over a token-gated local socket. Data only — no functions, no handles.
        </Note>
        <Note title="The handler">
          Runs in the Bun worker with the full runtime. Blocking here never freezes the window.
        </Note>
        <Note title="The type" accent>
          Never crossed anything. It came from <code style={mono}>import type</code> at build time.
        </Note>
      </div>
    </div>
  );
}

function Panel({
  file,
  side,
  children,
}: {
  file: string;
  side: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="overflow-hidden rounded-xl"
      style={{ border: `1px solid ${rice(0.14)}`, background: PANEL }}
    >
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: `1px solid ${rice(0.09)}` }}
      >
        <span style={{ ...mono, fontSize: 11.5, color: rice(0.6) }}>{file}</span>
        <span
          style={{ ...mono, fontSize: 10, color: rice(0.32) }}
          className="uppercase tracking-[0.12em]"
        >
          {side}
        </span>
      </div>
      <div className="px-4 py-4 text-[13px] leading-[1.9]" style={mono}>
        {children}
      </div>
    </div>
  );
}

function Note({
  title,
  children,
  accent,
}: {
  title: string;
  children: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      className="flex flex-col gap-1 rounded-xl px-4 py-3"
      style={{
        border: `1px solid ${accent ? amber(0.3) : rice(0.1)}`,
        background: accent ? amber(0.07) : rice(0.03),
      }}
    >
      <div className="text-[13.5px] font-bold" style={accent ? { color: AMBER } : undefined}>
        {title}
      </div>
      <div className="text-[12.5px] leading-[1.5]" style={{ color: rice(0.62) }}>
        {children}
      </div>
    </div>
  );
}
