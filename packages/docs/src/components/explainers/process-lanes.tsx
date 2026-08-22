import { useState } from "react";
import { AMBER, amber, mono, rice, shell } from "./shared";

const LANES = [
  {
    id: "worker",
    name: "Your main process",
    tag: "yours",
    lang: "TypeScript",
    what: "Your code, in a Bun worker. Everything native is invoked from here.",
    details: [
      "Full Bun: Bun.*, bun:ffi, workers, sidecars, the filesystem, the network.",
      "Not the main thread — a slow handler here never freezes the window.",
      "Window and menu calls post a UI task rather than touching the platform.",
    ],
  },
  {
    id: "renderer",
    name: "Your UI",
    tag: "yours",
    lang: "any web stack",
    what: "A Chromium renderer with no privileged access. Talks over typed RPC.",
    details: [
      "Vite with HMR in dev; served from the bundle over app:// in a build.",
      "No native access by design — that boundary is the security model.",
    ],
  },
  {
    id: "host",
    name: "Mirin host",
    tag: "ours",
    lang: "Bun-compiled",
    what: "Owns the process main thread and the UI loop.",
    details: [
      "Every AppKit, Win32 and Xlib call happens here, because they must.",
      "Starts your worker, pumps the event queue back to it.",
    ],
  },
  {
    id: "core",
    name: "libmirin_core + CEF",
    tag: "ours",
    lang: "Rust",
    what: "Native windowing, the CEF browser process, and the FFI surface.",
    details: [
      "Ships prebuilt for every supported target — no Rust toolchain to install.",
      "Events reach your worker through a polled queue, never a callback across FFI.",
    ],
  },
] as const;

/** The four processes, with the two that are yours marked. */
export function ProcessLanes() {
  const [open, setOpen] = useState<string | null>("worker");
  const [onlyYours, setOnlyYours] = useState(false);

  const visible = onlyYours ? LANES.filter((l) => l.tag === "yours") : LANES;

  return (
    <div style={shell} className="my-6 not-prose">
      <div className="mb-5 flex items-end justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <div
            style={{ ...mono, color: AMBER }}
            className="text-[11px] uppercase tracking-[0.16em]"
          >
            Process model
          </div>
          <div className="text-[19px] font-bold tracking-[-0.02em]">You write in one lane.</div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Toggle on={!onlyYours} onClick={() => setOnlyYours(false)}>
            All four
          </Toggle>
          <Toggle on={onlyYours} onClick={() => setOnlyYours(true)}>
            Only yours
          </Toggle>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        {visible.map((lane) => {
          const isOpen = open === lane.id;
          const yours = lane.tag === "yours";
          return (
            <button
              type="button"
              key={lane.id}
              onClick={() => setOpen(isOpen ? null : lane.id)}
              className="rounded-xl px-5 py-4 text-left transition-colors duration-150"
              style={{
                border: `1px solid ${
                  isOpen ? (yours ? amber(0.5) : rice(0.3)) : yours ? amber(0.28) : rice(0.12)
                }`,
                background: yours ? amber(0.07) : rice(0.03),
              }}
            >
              <div className="flex items-center gap-3.5">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: yours ? AMBER : rice(0.3) }}
                />
                <div className="flex grow flex-col gap-0.5">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[17px] font-bold">{lane.name}</span>
                    <span
                      className="rounded-full px-2 py-0.5 uppercase tracking-[0.12em]"
                      style={{
                        ...mono,
                        fontSize: 10,
                        background: yours ? amber(0.18) : rice(0.07),
                        color: yours ? AMBER : rice(0.45),
                      }}
                    >
                      {lane.tag}
                    </span>
                  </div>
                  <div className="text-[13px] leading-[1.55]" style={{ color: rice(0.6) }}>
                    {lane.what}
                  </div>
                </div>
                <span
                  className="hidden whitespace-nowrap sm:block"
                  style={{ ...mono, fontSize: 11, color: rice(0.35) }}
                >
                  {lane.lang}
                </span>
              </div>

              {isOpen ? (
                <div
                  className="mt-3.5 flex flex-col gap-1.5 pt-3.5"
                  style={{ borderTop: `1px solid ${rice(0.1)}` }}
                >
                  {lane.details.map((detail) => (
                    <div key={detail} className="flex items-baseline gap-2.5">
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ background: amber(0.7) }}
                      />
                      <span className="text-[13px] leading-[1.55]" style={{ color: rice(0.72) }}>
                        {detail}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        className="mt-5 rounded-xl px-4 py-3.5 text-[13px] leading-[1.6]"
        style={{ background: amber(0.08), border: `1px solid ${amber(0.25)}`, color: rice(0.78) }}
      >
        {onlyYours
          ? "Two of the four are yours, and both are code you already know how to write."
          : "Two lanes are yours, two ship with Mirin. Tap any lane for what runs there."}
      </div>
    </div>
  );
}

function Toggle({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg px-3.5 py-2 text-[13px] transition-all duration-150"
      style={
        on
          ? { background: AMBER, color: "#14100c", border: `1px solid ${AMBER}`, fontWeight: 700 }
          : { background: "transparent", color: rice(0.7), border: `1px solid ${rice(0.18)}` }
      }
    >
      {children}
    </button>
  );
}
