import { useState } from "react";
import { AMBER, amber, mono, rice, shell } from "./shared";

const DATA = {
  macos: {
    name: "macOS",
    badge: "most exercised",
    arch: "arm64 · Apple Silicon only",
    summary: "The platform Mirin is developed on. Every app-shell capability lands here first.",
    warning:
      "Liquid Glass needs macOS 26 or newer; below that a window falls back to frosted vibrancy rather than failing. Intel is not built, and App Store packaging is not implemented.",
    tone: "info" as const,
    features: {
      "Windows and controls": "yes",
      "Custom title bar": "yes",
      "Typed RPC": "yes",
      "Application menu": "yes",
      Tray: "yes",
      Dialogs: "yes",
      Clipboard: "yes",
      "Global shortcuts": "yes",
      "Deep links": "yes",
      "Transparency and materials": "yes",
      Installers: "DMG",
      Updater: "full + delta",
    },
    notes: {
      "Transparency and materials": "Liquid Glass, HUD, sidebar, popover, vibrancy",
    } as Record<string, string>,
  },
  windows: {
    name: "Windows",
    badge: "implemented",
    arch: "x64 · arm64 · Windows 10 and 11",
    summary:
      "Every app-shell capability is implemented, and less exercised than macOS. Expect rough edges and report them.",
    warning:
      "No application menu bar — frameless apps put menus in the UI, so setApplicationMenu is a no-op. The .exe file icon in Explorer is unset, and the updater in-place swap is implemented but not verified end to end.",
    tone: "warn" as const,
    features: {
      "Windows and controls": "yes",
      "Custom title bar": "yes",
      "Typed RPC": "yes",
      "Application menu": "no",
      Tray: "yes",
      Dialogs: "yes",
      Clipboard: "yes",
      "Global shortcuts": "yes",
      "Deep links": "yes",
      "Transparency and materials": "yes",
      Installers: "Inno · NSIS · zip",
      Updater: "unverified",
    },
    notes: {
      "Custom title bar": "aero snap and double-click-to-maximize work",
      "Transparency and materials": "layered window with a DWM acrylic backdrop",
      "Application menu": "popup and context menus do work",
    } as Record<string, string>,
  },
  linux: {
    name: "Linux",
    badge: "core loop only",
    arch: "x64 · arm64 · X11",
    summary:
      "Window, dev, build and release are complete. Several app-shell features are not ported, and they no-op rather than throw.",
    warning:
      "Transparency is not a small gap here: a windowed X11 CEF browser is always opaque, and the off-screen path the other platforms use does not exist on Linux. Do not design a Linux UI around a transparent window.",
    tone: "error" as const,
    features: {
      "Windows and controls": "yes",
      "Custom title bar": "yes",
      "Typed RPC": "yes",
      "Application menu": "no",
      Tray: "no",
      Dialogs: "no",
      Clipboard: "no",
      "Global shortcuts": "no",
      "Deep links": "no",
      "Transparency and materials": "no",
      Installers: "AppImage · deb · rpm",
      Updater: "yes",
    },
    notes: {
      Tray: "needs StatusNotifierItem",
      Dialogs: "needs xdg-desktop-portal",
      "Deep links": "needs .desktop MIME registration",
    } as Record<string, string>,
  },
};

const WARN_TONES = {
  info: { background: rice(0.04), border: `1px solid ${rice(0.1)}`, color: rice(0.72) },
  warn: { background: amber(0.08), border: `1px solid ${amber(0.3)}`, color: rice(0.8) },
  error: {
    background: "rgba(194,72,44,0.09)",
    border: "1px solid rgba(194,72,44,0.35)",
    color: rice(0.85),
  },
};

type PlatformId = keyof typeof DATA;

/** One platform at a time, with its real gaps instead of a parity table. */
export function PlatformPicker() {
  const [platform, setPlatform] = useState<PlatformId>("macos");
  const d = DATA[platform];

  return (
    <div style={shell} className="my-6 not-prose">
      <div className="mb-4 flex flex-col gap-1.5">
        <div style={{ ...mono, color: AMBER }} className="text-[11px] uppercase tracking-[0.16em]">
          Platform support
        </div>
        <div className="text-[19px] font-bold tracking-[-0.02em]">
          Pick your target. Get the gaps.
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {(Object.keys(DATA) as PlatformId[]).map((id) => {
          const on = id === platform;
          return (
            <button
              type="button"
              key={id}
              onClick={() => setPlatform(id)}
              className="flex flex-col items-start gap-1 rounded-xl px-4 py-3 text-left transition-all duration-150"
              style={{
                background: on ? amber(0.12) : "transparent",
                border: `1px solid ${on ? amber(0.5) : rice(0.12)}`,
                color: on ? rice(1) : rice(0.6),
              }}
            >
              <span className="text-[14px] font-bold">{DATA[id].name}</span>
              <span
                style={{ ...mono, fontSize: 10, color: on ? AMBER : rice(0.35) }}
                className="uppercase tracking-[0.1em]"
              >
                {DATA[id].badge}
              </span>
            </button>
          );
        })}
      </div>

      <div
        className="mb-4 flex flex-col gap-1.5 rounded-xl px-4 py-4"
        style={{ border: `1px solid ${rice(0.12)}`, background: rice(0.03) }}
      >
        <div style={{ ...mono, fontSize: 11.5, color: rice(0.5) }}>{d.arch}</div>
        <div className="text-[14.5px] leading-[1.6]" style={{ color: rice(0.78) }}>
          {d.summary}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {Object.entries(d.features).map(([name, value]) => {
          const missing = value === "no";
          const plain = value === "yes";
          const note = d.notes[name];
          return (
            <div
              key={name}
              className="rounded-xl px-3.5 py-3"
              style={{
                border: `1px solid ${missing ? "rgba(194,72,44,0.3)" : rice(0.1)}`,
                background: missing ? "rgba(194,72,44,0.06)" : rice(0.025),
              }}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: missing ? "#c2482c" : plain ? "#4f8a5b" : AMBER }}
                />
                <span className="grow text-[13.5px]">{name}</span>
                <span
                  style={{
                    ...mono,
                    fontSize: 10.5,
                    color: missing ? "#c2482c" : plain ? rice(0.4) : AMBER,
                  }}
                >
                  {plain ? "yes" : missing ? "not yet" : value}
                </span>
              </div>
              {note ? (
                <div
                  className="mt-1.5 pl-[18px] text-[12px] leading-[1.5]"
                  style={{ color: rice(0.5) }}
                >
                  {note}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div
        className="mt-4 rounded-xl px-4 py-3.5 text-[13px] leading-[1.6]"
        style={WARN_TONES[d.tone]}
      >
        {d.warning}
      </div>
    </div>
  );
}
