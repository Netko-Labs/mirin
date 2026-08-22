import { Link } from "@tanstack/react-router";
import { Code } from "@/components/code";
import { CheckRun } from "@/components/explainers/check-run";
import { RpcFlow } from "@/components/explainers/rpc-flow";
import { Kome } from "@/components/kome";

const AMBER = "#dd9a3f";
const INK = "#14100c";
const RICE = "#f7f4ec";

const sans = { fontFamily: "'Space Grotesk', system-ui, sans-serif" };
const serif = { fontFamily: "'Instrument Serif', Georgia, serif" };
const mono = { fontFamily: "'JetBrains Mono', ui-monospace, monospace" };

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ...mono, color: AMBER }} className="text-[11.5px] uppercase tracking-[0.16em]">
      {children}
    </div>
  );
}

function Terminal({ sample, label = "terminal" }: { sample: "install"; label?: string }) {
  return (
    <div
      className="overflow-hidden rounded-xl border text-left"
      style={{ borderColor: "rgba(247,244,236,0.14)", background: "#0f0c09" }}
    >
      <div
        className="border-b px-4 py-3 text-[12px]"
        style={{ ...mono, borderColor: "rgba(247,244,236,0.09)", color: "rgba(247,244,236,0.5)" }}
      >
        {label}
      </div>
      <Code sample={sample} />
    </div>
  );
}

export function Landing() {
  return (
    <main style={{ ...sans, background: INK, color: RICE }} className="min-h-screen">
      <header className="mx-auto flex max-w-[1180px] items-center justify-between px-6 py-5">
        <div className="flex items-center gap-3">
          <Kome />
          <span className="text-[20px] font-bold tracking-[-0.045em]">Mirin</span>
        </div>
        <nav
          className="flex items-center gap-7 text-[14.5px]"
          style={{ color: "rgba(247,244,236,0.65)" }}
        >
          <Link to="/docs/$" params={{ _splat: "" }}>
            Docs
          </Link>
          <a href="https://github.com/Netko-Labs/mirin">GitHub</a>
          <Link
            to="/docs/$"
            params={{ _splat: "start/install" }}
            className="rounded-lg px-5 py-2.5 font-bold"
            style={{ background: AMBER, color: INK }}
          >
            Get started
          </Link>
        </nav>
      </header>

      <section className="relative overflow-hidden px-6 pt-16 pb-20">
        <div
          className="pointer-events-none absolute left-1/2 -top-[300px] h-[700px] w-[1040px] -translate-x-1/2"
          style={{
            background: "radial-gradient(ellipse, rgba(221,154,63,0.19), rgba(221,154,63,0) 62%)",
          }}
        />
        <div className="relative mx-auto flex max-w-[720px] flex-col items-center gap-6 text-center">
          <div
            className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11.5px]"
            style={{ ...mono, borderColor: "rgba(221,154,63,0.42)", color: AMBER }}
          >
            <span className="h-[5px] w-[5px] rounded-full" style={{ background: AMBER }} />
            open source · MIT · pre-alpha
          </div>
          <h1 style={serif} className="text-[74px] leading-[1.02] tracking-[-0.015em]">
            Desktop apps, brewed in <em style={{ color: AMBER }}>Bun</em>.
          </h1>
          <p
            className="max-w-[52ch] text-[18px] leading-[1.6]"
            style={{ color: "rgba(247,244,236,0.72)" }}
          >
            The main process is Bun, not Node. The UI is real Chromium on macOS, Windows and Linux.
            Typed RPC between them, and a CLI your coding agent can actually drive.
          </p>
          <div className="mt-2 w-full max-w-[420px]">
            <Terminal label="three commands, one window" sample="install" />
          </div>
          <div className="flex gap-3">
            <Link
              to="/docs/$"
              params={{ _splat: "" }}
              className="rounded-lg px-6 py-3 text-[15px] font-bold"
              style={{ background: AMBER, color: INK }}
            >
              Read the docs
            </Link>
            <a
              href="https://github.com/Netko-Labs/mirin"
              className="rounded-lg border px-6 py-3 text-[15px]"
              style={{ borderColor: "rgba(247,244,236,0.18)" }}
            >
              GitHub
            </a>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1180px] px-6 pb-24">
        <div className="grid items-center gap-16 md:grid-cols-[400px_1fr]">
          <div className="flex flex-col gap-4">
            <Eyebrow>Typed RPC</Eyebrow>
            <h2 style={serif} className="text-[46px] leading-[1.06]">
              Define it once. The UI already knows.
            </h2>
            <p className="text-[16px] leading-[1.65]" style={{ color: "rgba(247,244,236,0.65)" }}>
              One router in the main process. The renderer imports its <em>type</em>, never its code
              — no codegen step, no channel strings, no drift between the two halves of your app.
            </p>
          </div>
          <RpcFlow />
        </div>
      </section>

      <section
        className="border-y px-6 py-24"
        style={{ borderColor: "rgba(247,244,236,0.1)", background: "rgba(247,244,236,0.03)" }}
      >
        <div className="mx-auto grid max-w-[1180px] items-center gap-16 md:grid-cols-[1fr_400px]">
          <CheckRun />
          <div className="flex flex-col gap-4">
            <Eyebrow>Agent tooling</Eyebrow>
            <h2 style={serif} className="text-[46px] leading-[1.06]">
              Your agent can see the app run.
            </h2>
            <p className="text-[16px] leading-[1.65]" style={{ color: "rgba(247,244,236,0.65)" }}>
              Most desktop frameworks are a black box to a coding agent — it writes, you run, you
              describe what happened. Mirin closes that loop.
            </p>
            <Link
              to="/docs/$"
              params={{ _splat: "agents" }}
              className="text-[15px]"
              style={{ color: AMBER }}
            >
              Read the agent devtools guide →
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1180px] px-6 py-24">
        <h2 style={serif} className="mb-8 text-[46px] leading-[1.06]">
          Built with Mirin
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <AppCard
            image="/anko.png"
            alt="Anko, a SQL client, showing a connections sidebar and query tabs over a result grid"
            name="Anko"
            body="A SQL client for PostgreSQL, MySQL and SQLite, with authenticated MCP access so your coding agent queries the same databases you do."
          />
          <AppCard
            image="/washi.png"
            alt="Washi, a knowledge base, showing a note composed of cards beside a page sidebar"
            name="Washi"
            body="An agent-first knowledge base. Notes are JSX rendered by a component registry, so an agent can compose a page as precisely as a person can."
          />
        </div>
      </section>

      <section
        className="border-t px-6 py-24 text-center"
        style={{ borderColor: "rgba(247,244,236,0.1)" }}
      >
        <div className="mx-auto flex max-w-[680px] flex-col items-center gap-5">
          <h2 style={serif} className="text-[48px] leading-[1.06]">
            Pre-alpha, and the version number means it.
          </h2>
          <p className="text-[16.5px] leading-[1.65]" style={{ color: "rgba(247,244,236,0.62)" }}>
            Scaffold, dev with HMR, build a standalone app, cut a release with an updater — the
            whole loop works today on macOS arm64, Windows and Linux on x64 and arm64. The API will
            still move.
          </p>
          <Link
            to="/docs/$"
            params={{ _splat: "start/install" }}
            className="rounded-lg px-7 py-3.5 text-[15.5px] font-bold"
            style={{ background: AMBER, color: INK }}
          >
            Get started
          </Link>
        </div>
      </section>

      <footer className="border-t px-6 py-8" style={{ borderColor: "rgba(247,244,236,0.1)" }}>
        <div
          className="mx-auto flex max-w-[1180px] items-center justify-between text-[13.5px]"
          style={{ color: "rgba(247,244,236,0.45)" }}
        >
          <div className="flex items-center gap-2.5">
            <Kome size={18} />
            <span>Mirin — Netko Labs, MIT</span>
          </div>
          <div className="flex gap-6">
            <Link to="/docs/$" params={{ _splat: "" }}>
              Docs
            </Link>
            <a href="https://github.com/Netko-Labs/mirin">GitHub</a>
            <a href="/llms.txt">llms.txt</a>
          </div>
        </div>
      </footer>
    </main>
  );
}

function AppCard({
  name,
  body,
  image,
  alt,
}: {
  name: string;
  body: string;
  image: string;
  alt: string;
}) {
  return (
    <div
      className="overflow-hidden rounded-2xl border"
      style={{ borderColor: "rgba(247,244,236,0.12)", background: "rgba(247,244,236,0.03)" }}
    >
      <div
        className="h-[240px] overflow-hidden border-b"
        style={{ borderColor: "rgba(247,244,236,0.1)" }}
      >
        <img
          src={image}
          alt={alt}
          loading="lazy"
          width={1400}
          height={240}
          className="h-full w-full object-cover object-top"
        />
      </div>
      <div className="flex flex-col gap-2 px-6 py-6">
        <div className="text-[22px] font-bold tracking-[-0.025em]">{name}</div>
        <p className="text-[14.5px] leading-[1.6]" style={{ color: "rgba(247,244,236,0.6)" }}>
          {body}
        </p>
      </div>
    </div>
  );
}
