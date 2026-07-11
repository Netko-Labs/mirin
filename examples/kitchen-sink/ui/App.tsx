import { useEffect, useState } from "react";
import { api } from "./api.ts";

export function App() {
  const log = useEventLog();

  return (
    <>
      <div className="titlebar">
        <span className="titlebar-title">mirin · Kitchen Sink</span>
        <div className="titlebar-controls">
          <button type="button" title="Minimize" onClick={() => api.minimize(null)}>
            &#x2013;
          </button>
          <button type="button" title="Maximize" onClick={() => api.maximize(null)}>
            &#x25A1;
          </button>
          <button type="button" title="Close" className="close" onClick={() => api.close(null)}>
            &#x2715;
          </button>
        </div>
      </div>
      <div
        className="content"
        onContextMenu={(e) => {
          e.preventDefault();
          api.showContextMenu(null);
        }}
      >
        <h1>Native feature tour</h1>
        <p className="sub">
          Every button drives a native macOS capability from the Bun process over typed RPC.
          Right-click anywhere for a native context menu. Custom title bar above is draggable.
        </p>

        <div className="grid">
          <WindowSection />
          <DialogSection />
          <ClipboardSection />
          <SidecarSection />
          <SystemSection />
          <EventLog entries={log} />
        </div>
      </div>
    </>
  );
}

function WindowSection() {
  const [onTop, setOnTop] = useState(false);
  return (
    <section className="card">
      <h2>Window controls</h2>
      <div className="row">
        <button type="button" onClick={() => api.minimize(null)}>
          Minimize
        </button>
        <button type="button" onClick={() => api.toggleFullscreen(null)}>
          Fullscreen
        </button>
        <button
          type="button"
          onClick={() => {
            const next = !onTop;
            setOnTop(next);
            api.setAlwaysOnTop(next);
          }}
        >
          Always on top: {onTop ? "on" : "off"}
        </button>
        <button type="button" onClick={() => api.openSecondWindow(null)}>
          Open window
        </button>
      </div>
    </section>
  );
}

function DialogSection() {
  const [result, setResult] = useState("");
  return (
    <section className="card">
      <h2>Dialogs</h2>
      <div className="row">
        <button type="button" onClick={async () => setResult(fmt(await api.openFile(null)))}>
          Open file…
        </button>
        <button type="button" onClick={async () => setResult(fmt(await api.saveFile(null)))}>
          Save as…
        </button>
        <button
          type="button"
          onClick={async () => setResult(`button ${(await api.messageBox(null)).button}`)}
        >
          Message box
        </button>
        <button
          type="button"
          onClick={async () => setResult((await api.showNotification(null)) ? "sent" : "failed")}
        >
          Notification
        </button>
      </div>
      <div className="result">{result}</div>
    </section>
  );
}

function ClipboardSection() {
  const [text, setText] = useState("mirin ❤ bun");
  const [read, setRead] = useState("");
  return (
    <section className="card">
      <h2>Clipboard</h2>
      <div className="row">
        <input value={text} onChange={(e) => setText(e.target.value)} />
        <button type="button" onClick={() => api.clipboardWrite(text)}>
          Copy
        </button>
        <button type="button" onClick={async () => setRead(await api.clipboardRead(null))}>
          Read
        </button>
      </div>
      <div className="result">{read && `clipboard: ${read}`}</div>
    </section>
  );
}

function SidecarSection() {
  const [text, setText] = useState("mirin sidecar");
  const [op, setOp] = useState("upper");
  const [result, setResult] = useState("");
  const [ticking, setTicking] = useState(false);

  return (
    <section className="card sidecar">
      <h2>Sidecar (bundled binary)</h2>
      <p className="result" style={{ marginTop: 0 }}>
        A Bun-compiled <code>tool</code> binary bundled into the .app, spawned via{" "}
        <strong>app.sidecar("tool")</strong> — one-shot, a persistent NDJSON server, and a streaming
        process you can kill.
      </p>

      <div className="row">
        <input value={text} onChange={(e) => setText(e.target.value)} />
        <select value={op} onChange={(e) => setOp(e.target.value)}>
          <option value="ping">ping</option>
          <option value="upper">upper</option>
          <option value="reverse">reverse</option>
          <option value="hash">hash</option>
        </select>
        <button
          type="button"
          onClick={async () => setResult(JSON.stringify(await api.sidecarServer({ op, text })))}
        >
          Server request
        </button>
      </div>

      <div className="row">
        <button
          type="button"
          onClick={async () => setResult(`version: ${await api.sidecarVersion(null)}`)}
        >
          Version (one-shot)
        </button>
        <button
          type="button"
          onClick={async () => setResult(`echo: ${await api.sidecarEcho(text)}`)}
        >
          Echo (one-shot)
        </button>
        <button
          type="button"
          onClick={async () => setResult(`fail: ${JSON.stringify(await api.sidecarFail(null))}`)}
        >
          Fail (stderr + exit 3)
        </button>
      </div>

      <div className="row">
        <button
          type="button"
          onClick={async () => {
            const pid = await api.sidecarStart(null);
            setResult(`streaming started (pid ${pid}) — see event log`);
            setTicking(true);
          }}
          disabled={ticking}
        >
          Start stream
        </button>
        <button
          type="button"
          onClick={async () => {
            await api.sidecarStop(null);
            setResult("streaming stopped (sidecar killed)");
            setTicking(false);
          }}
          disabled={!ticking}
        >
          Stop stream
        </button>
      </div>

      <div className="result">{result}</div>
    </section>
  );
}

function SystemSection() {
  return (
    <section className="card">
      <h2>Menus · Tray · Shortcuts · Deep links</h2>
      <div className="result" style={{ marginTop: 0 }}>
        The app menu (File / Edit / View) and a 🍴 menu-bar tray are set up at launch. Try{" "}
        <strong>File → Say Hello</strong> (⌘⇧H), the tray menu, or the global hotkey{" "}
        <strong>⌘⇧K</strong>. From a terminal, <code>open "mirin-sink://hello"</code> opens a deep
        link. Each pushes an event into the log below.
      </div>
    </section>
  );
}

function EventLog({ entries }: { entries: string[] }) {
  return (
    <section className="card log">
      <h2>Events from the main process</h2>
      <ul>
        {entries.length === 0 && <li>waiting for menu / tray / shortcut events…</li>}
        {entries.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
    </section>
  );
}

function useEventLog(): string[] {
  const [entries, setEntries] = useState<string[]>([]);
  useEffect(() => {
    const add = (msg: string) => setEntries((prev) => [msg, ...prev].slice(0, 30));
    const offs = [
      api.menuAction.on(({ action }) => add(`menu: ${action}`)),
      api.trayAction.on(({ action }) => add(`tray: ${action}`)),
      api.shortcutFired.on(({ name }) => add(`shortcut: ${name}`)),
      api.sidecarTick.on(({ n }) => add(`sidecar tick: ${n}`)),
      api.deepLink.on(({ url }) => add(`deep link: ${url}`)),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);
  return entries;
}

function fmt(value: string | string[] | null): string {
  if (value === null) return "cancelled";
  return Array.isArray(value) ? value.join(", ") : value;
}
