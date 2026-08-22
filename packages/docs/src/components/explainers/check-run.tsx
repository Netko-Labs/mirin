import { useEffect, useRef, useState } from "react";
import { AMBER, INK, mono, PANEL, rice, shell } from "./shared";

const SCRIPT = [
  { text: "● brewing… bundling main process", tone: "amber" },
  { text: "✓ window ready — 1 of 1", tone: "ok" },
  { text: "✓ scenario — todo added, list length 1", tone: "ok" },
  { text: "✓ screenshot — w1.png", tone: "ok" },
  { text: "✓ no renderer errors", tone: "ok" },
  { text: "  .mirin/dev/20260821-1042/events.jsonl", tone: "dim" },
] as const;

const TONES = {
  amber: AMBER,
  ok: rice(0.75),
  dim: rice(0.4),
} as const;

/** `mirin check` replayed line by line, ending in the artifacts it leaves behind. */
export function CheckRun() {
  const [step, setStep] = useState(0);
  const [running, setRunning] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  function run() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setStep(0);
    setRunning(true);
    SCRIPT.forEach((_, i) => {
      timers.current.push(
        setTimeout(
          () => {
            setStep(i + 1);
            if (i + 1 >= SCRIPT.length) setRunning(false);
          },
          420 * (i + 1),
        ),
      );
    });
  }

  const done = step >= SCRIPT.length;
  const hasShot = step >= 4;

  return (
    <div style={shell} className="my-6 not-prose">
      <div className="mb-5 flex items-end justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <div
            style={{ ...mono, color: AMBER }}
            className="text-[11px] uppercase tracking-[0.16em]"
          >
            Agent tooling
          </div>
          <div className="text-[19px] font-bold tracking-[-0.02em]">Watch a check run.</div>
        </div>
        <button
          type="button"
          onClick={run}
          className="shrink-0 rounded-lg px-5 py-2.5 text-[14px] font-bold"
          style={{ background: AMBER, color: INK, opacity: running ? 0.6 : 1 }}
        >
          {running ? "Running…" : done ? "Run again" : "Run check"}
        </button>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[1.25fr_1fr]">
        <div
          className="overflow-hidden rounded-xl"
          style={{ border: `1px solid ${rice(0.14)}`, background: PANEL, minHeight: 250 }}
        >
          <div
            className="px-4 py-2.5"
            style={{
              ...mono,
              fontSize: 11.5,
              color: rice(0.5),
              borderBottom: `1px solid ${rice(0.09)}`,
            }}
          >
            terminal
          </div>
          <div className="px-4 py-4 text-[12.5px] leading-[2]" style={mono}>
            <div style={{ color: rice(0.9) }}>
              <span style={{ color: AMBER }}>$</span> bunx mirin check --scenario ./check.ts
            </div>
            {SCRIPT.slice(0, step).map((line) => (
              <div key={line.text} style={{ color: TONES[line.tone] }}>
                {line.text}
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2.5">
          <div
            className="overflow-hidden rounded-xl"
            style={{ border: `1px solid ${rice(0.14)}`, background: rice(0.03) }}
          >
            <div
              className="px-4 py-2.5"
              style={{
                ...mono,
                fontSize: 11.5,
                color: rice(0.5),
                borderBottom: `1px solid ${rice(0.09)}`,
              }}
            >
              {hasShot ? "screenshots/w1.png" : "screenshots/"}
            </div>
            <div className="flex h-[170px] items-center justify-center p-4">
              {hasShot ? (
                <div
                  className="w-full overflow-hidden rounded-lg"
                  style={{ border: `1px solid ${rice(0.16)}`, background: "#1c1712" }}
                >
                  <div
                    className="flex gap-1.5 px-2.5 py-2"
                    style={{ borderBottom: `1px solid ${rice(0.08)}` }}
                  >
                    <span className="size-1.5 rounded-full" style={{ background: "#ff5f57" }} />
                    <span className="size-1.5 rounded-full" style={{ background: "#febc2e" }} />
                    <span className="size-1.5 rounded-full" style={{ background: "#28c840" }} />
                  </div>
                  <div className="flex flex-col gap-1.5 p-3.5">
                    <div className="h-2 w-3/5 rounded" style={{ background: rice(0.3) }} />
                    <div className="h-2 w-5/6 rounded" style={{ background: rice(0.15) }} />
                    <div
                      className="h-2 w-2/5 rounded"
                      style={{ background: "rgba(221,154,63,0.5)" }}
                    />
                  </div>
                </div>
              ) : (
                <span style={{ ...mono, fontSize: 11.5, color: rice(0.25) }}>
                  nothing captured yet
                </span>
              )}
            </div>
          </div>

          <div
            className="rounded-xl px-4 py-3 transition-all duration-200"
            style={
              done
                ? {
                    ...mono,
                    fontSize: 12,
                    background: "rgba(79,138,91,0.12)",
                    border: "1px solid rgba(79,138,91,0.4)",
                    color: "#7cb98c",
                  }
                : {
                    ...mono,
                    fontSize: 12,
                    background: rice(0.03),
                    border: `1px solid ${rice(0.1)}`,
                    color: rice(0.35),
                  }
            }
          >
            {done ? "exit 0 — nothing broke" : "exit code pending"}
          </div>
        </div>
      </div>

      <div
        className="mt-5 rounded-xl px-4 py-3.5 text-[13px] leading-[1.6]"
        style={{ background: rice(0.04), border: `1px solid ${rice(0.1)}`, color: rice(0.72) }}
      >
        Every run leaves the same three things behind: a screenshot, an accessibility snapshot, and{" "}
        <code style={mono}>events.jsonl</code>. That is what an agent reads instead of asking you
        what happened.
      </div>
    </div>
  );
}
