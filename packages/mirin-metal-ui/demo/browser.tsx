/**
 * metal-ui example browser: every ported shadcn example, rendered natively.
 * The list on the left filters as you type; the selected example renders in
 * the preview on the right, inside the same theme it would get on the web.
 *
 *   cd crates/mirin-metal && cargo build --bin mirin-metal-host
 *   cd packages/mirin-metal-ui && bun demo/browser.tsx [host-binary] [example]
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { render, spawnNativeHost } from "@mirinjs/metal";
import { Component, type ComponentType, type ReactNode, useEffect, useState } from "react";
import { Button } from "../src/components/button.tsx";
import { SearchIcon } from "../src/icons/index.ts";
import { ThemeProvider } from "../src/provider.tsx";
import { useTheme } from "../src/theme.ts";

const EXAMPLES_DIR = join(import.meta.dir, "examples");

export function listExamples(): string[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => file.replace(/\.tsx$/, ""))
    .sort();
}

/** Group by component: `button-group-demo` → `button-group`. */
function groupOf(name: string): string {
  return name.replace(/-(demo|with-.+|disabled|outline|sm|lg|.+-demo)$/, "");
}

class Boundary extends Component<{ name: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  componentDidUpdate(previous: { name: string }) {
    if (previous.name !== this.props.name && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/50 p-4 text-sm">
          <p className="font-medium text-destructive">This example failed to render</p>
          <p className="font-mono text-xs text-muted-foreground">{this.state.error}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function Preview({ name }: { name: string }) {
  const [Example, setExample] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setExample(null);
    setError(null);
    import(join(EXAMPLES_DIR, `${name}.tsx`))
      .then((mod: { default?: ComponentType }) => {
        if (live && mod.default) setExample(() => mod.default as ComponentType);
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      live = false;
    };
  }, [name]);
  if (error) {
    return <p className="font-mono text-xs text-destructive">{error}</p>;
  }
  if (!Example) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <Boundary name={name}>
      <Example />
    </Boundary>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      data-testid="toggle-theme"
    >
      {resolvedTheme === "dark" ? "Light" : "Dark"}
    </Button>
  );
}

export function Browser({ initial }: { initial?: string }) {
  const examples = listExamples();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(
    initial && examples.includes(initial) ? initial : (examples[0] ?? ""),
  );
  const visible = examples.filter((name) => name.includes(query.trim().toLowerCase()));
  return (
    <div className="flex flex-1 flex-row">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-sidebar">
        <div className="flex flex-col gap-3 border-b p-4">
          <div className="flex flex-row items-center justify-between">
            <p className="text-sm font-semibold">metal-ui</p>
            <span className="text-xs text-muted-foreground">{`${examples.length} examples`}</span>
          </div>
          <div className="flex flex-row items-center gap-2 rounded-md border bg-background px-2">
            <SearchIcon className="size-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(event: { target: { value: string } }) => setQuery(event.target.value)}
              placeholder="Search examples…"
              className="h-8 flex-1 border-0 bg-transparent text-sm"
              data-testid="search"
            />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {visible.map((name, index) => {
            const group = groupOf(name);
            const startsGroup = index === 0 || groupOf(visible[index - 1] ?? "") !== group;
            return (
              <div key={name} className="flex flex-col">
                {startsGroup ? (
                  <p className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground uppercase">
                    {group}
                  </p>
                ) : null}
                <button
                  type="button"
                  onClick={() => setSelected(name)}
                  data-testid={`example:${name}`}
                  className={`flex flex-row rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent ${name === selected ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-sidebar-foreground"}`}
                >
                  {name}
                </button>
              </div>
            );
          })}
        </div>
      </aside>
      <main className="flex flex-1 flex-col">
        <header className="flex h-14 shrink-0 flex-row items-center justify-between border-b px-6">
          <p className="font-mono text-sm">{selected}</p>
          <ThemeToggle />
        </header>
        <div className="flex flex-1 flex-col items-center justify-center overflow-auto p-10">
          {selected ? <Preview name={selected} /> : null}
        </div>
      </main>
    </div>
  );
}

if (import.meta.main) {
  const binary =
    Bun.argv[2] ??
    new URL("../../../crates/mirin-metal/target/debug/mirin-metal-host", import.meta.url).pathname;
  process.env.MIRIN_METAL_TITLE = "metal-ui examples";
  process.env.MIRIN_METAL_SIZE ??= "1440x900";
  const transport = spawnNativeHost(binary);
  const root = render(
    <ThemeProvider>
      <Browser initial={Bun.argv[3]} />
    </ThemeProvider>,
    transport,
  );
  transport.onClose(() => {
    root.unmount();
    process.exit(0);
  });
}
