/**
 * The kitchen-sink sidecar — a self-contained binary bundled into the .app and
 * spawned via `app.sidecar("tool")`. It has no mirin imports; it's a plain CLI,
 * compiled to a Mach-O with `bun build --compile` (see package.json build:sidecar).
 *
 * It demonstrates the shapes real sidecars take:
 *   tool --version          one-shot, prints + exits 0
 *   tool echo <text…>       one-shot, echoes args
 *   tool hash <text…>       one-shot, sha256 of args
 *   tool count              long-running: a number every 500ms until killed
 *   tool fail               writes to stderr, exits 3 (error/exit-code demo)
 *   tool serve  (default)   long-lived NDJSON server on stdin/stdout
 *
 * In `serve` mode it reads one JSON request per line and writes one JSON reply
 * per line: {op:"ping"|"upper"|"reverse"|"hash", text?} -> {ok, result?, error?}.
 */

const VERSION = "1.0.0";

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

function respond(line: string): void {
  let req: { op?: string; text?: string };
  try {
    req = JSON.parse(line);
  } catch {
    out(JSON.stringify({ ok: false, error: "invalid json" }));
    return;
  }
  const text = req.text ?? "";
  switch (req.op) {
    case "ping":
      out(JSON.stringify({ ok: true, result: "pong", pid: process.pid }));
      break;
    case "upper":
      out(JSON.stringify({ ok: true, result: text.toUpperCase() }));
      break;
    case "reverse":
      out(JSON.stringify({ ok: true, result: [...text].reverse().join("") }));
      break;
    case "hash":
      out(JSON.stringify({ ok: true, result: sha256(text) }));
      break;
    default:
      out(JSON.stringify({ ok: false, error: `unknown op: ${req.op ?? "?"}` }));
  }
}

async function serve(): Promise<void> {
  err("[tool] NDJSON server ready");
  const reader = Bun.stdin.stream().getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) respond(line);
      nl = buf.indexOf("\n");
    }
  }
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "--version":
  case "version":
    out(VERSION);
    break;
  case "echo":
    out(rest.join(" "));
    break;
  case "hash":
    out(sha256(rest.join(" ")));
    break;
  case "count": {
    let n = 0;
    setInterval(() => out(String(++n)), 500); // ref'd → keeps the process alive until killed
    break;
  }
  case "fail":
    err("tool: simulated failure");
    process.exit(3);
    break;
  case undefined:
  case "serve":
    await serve();
    break;
  default:
    err(`tool: unknown command "${cmd}"`);
    process.exit(2);
}
