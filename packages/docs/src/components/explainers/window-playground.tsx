import { useState } from "react";
import { AMBER, amber, mono, PANEL, rice, shell } from "./shared";

const MATERIALS = {
  none: { bg: "#1c1712", label: "none" },
  liquidGlass: { bg: rice(0.13), label: "liquidGlass" },
  hud: { bg: "rgba(20,16,12,0.55)", label: "hud" },
  sidebar: { bg: rice(0.08), label: "sidebar" },
} as const;

type TitleBar = "default" | "hidden" | "hiddenInset";
type Material = keyof typeof MATERIALS;

const TITLE_BAR_NOTES: Record<TitleBar, string> = {
  default: "The platform draws the title bar. Nothing to build, nothing to maintain.",
  hidden: "No title bar at all — you draw the whole chrome, traffic lights included.",
  hiddenInset: "macOS keeps its traffic lights and insets them; you own the rest of the bar.",
};

/** Config on the left, the window it describes on the right. */
export function WindowPlayground() {
  const [titleBar, setTitleBar] = useState<TitleBar>("default");
  const [material, setMaterial] = useState<Material>("none");
  const [drag, setDrag] = useState(false);

  const mat = MATERIALS[material];
  const glassy = material !== "none";

  const note = glassy
    ? "A material implies a transparent window, rendered off-screen so the OS draws the blur. Your page must paint no background, or there is nothing to see through. macOS and Windows only."
    : drag
      ? "The dashed area is draggable: the whole background moves the window, which a custom title bar needs."
      : TITLE_BAR_NOTES[titleBar];

  return (
    <div style={shell} className="my-6 not-prose">
      <div className="mb-5 flex flex-col gap-1.5">
        <div style={{ ...mono, color: AMBER }} className="text-[11px] uppercase tracking-[0.16em]">
          Declarative windows
        </div>
        <div className="text-[19px] font-bold tracking-[-0.02em]">
          Change the config. Watch the window.
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2">
        <div className="flex flex-col gap-3.5">
          <div
            className="overflow-hidden rounded-xl"
            style={{ border: `1px solid ${rice(0.14)}`, background: PANEL }}
          >
            <div
              className="px-4 py-2.5"
              style={{
                ...mono,
                fontSize: 11.5,
                color: rice(0.6),
                borderBottom: `1px solid ${rice(0.09)}`,
              }}
            >
              mirin.config.ts
            </div>
            <div
              className="px-4 py-4 text-[12.5px] leading-[1.85]"
              style={{ ...mono, color: rice(0.85) }}
            >
              <div>windows: {"{"}</div>
              <div>&nbsp;&nbsp;main: {"{"}</div>
              <div>
                &nbsp;&nbsp;&nbsp;&nbsp;url:{" "}
                <span style={{ color: "#a8c98f" }}>'app://ui/index.html'</span>,
              </div>
              <div style={{ opacity: titleBar === "default" ? 0.32 : 1 }}>
                &nbsp;&nbsp;&nbsp;&nbsp;titleBarStyle:{" "}
                <span style={{ color: "#a8c98f" }}>'{titleBar}'</span>,
              </div>
              <div style={{ opacity: glassy ? 1 : 0.32 }}>
                &nbsp;&nbsp;&nbsp;&nbsp;material:{" "}
                <span style={{ color: "#a8c98f" }}>'{mat.label}'</span>,
              </div>
              <div style={{ opacity: drag ? 1 : 0.32 }}>
                &nbsp;&nbsp;&nbsp;&nbsp;movableByBackground:{" "}
                <span style={{ color: "#ecbe7a" }}>{String(drag)}</span>,
              </div>
              <div>&nbsp;&nbsp;{"},"}</div>
              <div>{"},"}</div>
            </div>
          </div>

          <Row label="titleBarStyle">
            {(["default", "hidden", "hiddenInset"] as const).map((v) => (
              <Chip key={v} on={titleBar === v} onClick={() => setTitleBar(v)}>
                {v}
              </Chip>
            ))}
          </Row>
          <Row label="material">
            {(Object.keys(MATERIALS) as Material[]).map((v) => (
              <Chip key={v} on={material === v} onClick={() => setMaterial(v)}>
                {v}
              </Chip>
            ))}
          </Row>
          <Row label="movableByBackground">
            <Chip on={!drag} onClick={() => setDrag(false)}>
              false
            </Chip>
            <Chip on={drag} onClick={() => setDrag(true)}>
              true
            </Chip>
          </Row>
        </div>

        <div className="flex flex-col gap-2.5">
          <div
            className="rounded-2xl p-6"
            style={{
              background: "linear-gradient(150deg, #2a2118, #14100c)",
              border: `1px solid ${rice(0.08)}`,
            }}
          >
            <div
              className="relative overflow-hidden rounded-xl transition-all duration-300"
              style={{
                background: mat.bg,
                backdropFilter: glassy ? "blur(12px)" : undefined,
                border: `1px solid ${glassy ? rice(0.22) : rice(0.12)}`,
                boxShadow: glassy ? "0 20px 50px rgba(0,0,0,0.5)" : "0 14px 34px rgba(0,0,0,0.45)",
              }}
            >
              <div
                className="flex items-center justify-between transition-all duration-200"
                style={
                  titleBar === "default"
                    ? {
                        padding: "11px 14px",
                        background: rice(0.06),
                        borderBottom: `1px solid ${rice(0.1)}`,
                      }
                    : { padding: titleBar === "hiddenInset" ? "16px 18px" : "12px 14px" }
                }
              >
                <div className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full" style={{ background: "#ff5f57" }} />
                  <span className="size-2.5 rounded-full" style={{ background: "#febc2e" }} />
                  <span className="size-2.5 rounded-full" style={{ background: "#28c840" }} />
                </div>
                {titleBar === "default" ? (
                  <span className="text-[12.5px]" style={{ color: rice(0.75) }}>
                    My App
                  </span>
                ) : null}
                <span className="w-10" />
              </div>
              <div className="flex flex-col gap-2 p-5">
                <div className="h-2 w-[55%] rounded" style={{ background: rice(0.28) }} />
                <div className="h-2 w-[78%] rounded" style={{ background: rice(0.16) }} />
                <div className="h-2 w-2/5 rounded" style={{ background: rice(0.16) }} />
              </div>
              {drag ? (
                <div
                  className="pointer-events-none absolute inset-0 rounded-xl"
                  style={{ border: `1px dashed ${amber(0.5)}` }}
                />
              ) : null}
            </div>
          </div>
          <div
            className="rounded-xl px-4 py-3.5 text-[13px] leading-[1.6]"
            style={{ background: rice(0.04), border: `1px solid ${rice(0.1)}`, color: rice(0.72) }}
          >
            {note}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        style={{ ...mono, fontSize: 10, color: rice(0.4) }}
        className="uppercase tracking-[0.14em]"
      >
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
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
      className="rounded-lg px-3 py-1.5 transition-all duration-150"
      style={{
        ...mono,
        fontSize: 11.5,
        background: on ? amber(0.2) : "transparent",
        color: on ? AMBER : rice(0.55),
        border: `1px solid ${on ? amber(0.55) : rice(0.14)}`,
      }}
    >
      {children}
    </button>
  );
}
