import type { UpdateInfo, UpdaterStatus } from "mirinjs";
import { useEffect, useState } from "react";
import { api } from "./api.ts";

export function App() {
  const [version, setVersion] = useState("…");
  const [channel, setChannel] = useState("stable");
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<UpdaterStatus>("idle");
  const [available, setAvailable] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [downloaded, setDownloaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    api.updaterInfo(null).then((i) => {
      setVersion(i.version);
      setChannel(i.channel);
      setEnabled(i.enabled);
      setStatus(i.status);
    });
    const offs = [
      api.updaterStatus.on(({ status }) => setStatus(status)),
      api.updaterProgress.on(({ fraction }) => setProgress(fraction)),
      api.updaterError.on(({ message }) => setMessage(`Error: ${message}`)),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);

  async function check() {
    setBusy(true);
    setMessage("");
    setAvailable(null);
    setDownloaded(false);
    try {
      const info = await api.checkForUpdate(null);
      if (info) {
        setAvailable(info);
        setMessage(`Update ${info.version} available (you have ${info.currentVersion}).`);
      } else {
        setMessage("You're up to date.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setBusy(true);
    setProgress(0);
    try {
      await api.downloadUpdate(null);
      setDownloaded(true);
      setMessage("Update downloaded — restart to install.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={S.main}>
      <h1 style={S.h1}>mirin updater</h1>
      <p style={S.sub}>
        version <b>{version}</b> · channel <b>{channel}</b>
      </p>

      {!enabled && (
        <p style={S.note}>
          Updates are disabled — run a packaged build with <code>release.baseUrl</code> set (this is
          inert in <code>mirin dev</code>).
        </p>
      )}

      <div style={S.row}>
        <button type="button" style={S.btn} onClick={check} disabled={busy || !enabled}>
          {status === "checking" ? "Checking…" : "Check for updates"}
        </button>
        {available && !downloaded && (
          <button type="button" style={S.btn} onClick={download} disabled={busy}>
            {status === "downloading" ? "Downloading…" : `Download ${available.version}`}
          </button>
        )}
        {downloaded && (
          <button
            type="button"
            style={{ ...S.btn, ...S.primary }}
            onClick={() => api.applyUpdate(null)}
          >
            Restart &amp; install
          </button>
        )}
      </div>

      {status === "downloading" && (
        <div style={S.barOuter}>
          <div style={{ ...S.barInner, width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}

      {message && <p style={S.msg}>{message}</p>}
      <p style={S.status}>status: {status}</p>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  main: {
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    padding: 32,
    color: "#e7e7ea",
    background: "#16161a",
    height: "100vh",
    boxSizing: "border-box",
  },
  h1: { fontSize: 22, margin: "0 0 4px" },
  sub: { color: "#9a9aa2", margin: "0 0 20px" },
  note: { background: "#23232b", padding: "10px 12px", borderRadius: 8, color: "#c9c9d2" },
  row: { display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" },
  btn: {
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid #34343e",
    background: "#23232b",
    color: "#e7e7ea",
    cursor: "pointer",
    fontSize: 14,
  },
  primary: { background: "#5b8cff", borderColor: "#5b8cff", color: "#fff" },
  barOuter: {
    height: 8,
    background: "#23232b",
    borderRadius: 6,
    overflow: "hidden",
    marginBottom: 14,
  },
  barInner: { height: "100%", background: "#5b8cff", transition: "width 120ms linear" },
  msg: { color: "#c9c9d2" },
  status: { color: "#6a6a73", fontSize: 12, marginTop: 24 },
};
