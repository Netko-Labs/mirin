import { render, spawnNativeHost } from "@mirinjs/metal";
import { Button } from "../src/components/button.tsx";
import { BellIcon, CheckIcon, ChevronRightIcon, MailIcon } from "../src/icons/index.ts";
import { ThemeProvider } from "../src/provider.tsx";

function Smoke() {
  return (
    <ThemeProvider>
      <div className="flex flex-col gap-6 p-8">
        <div className="flex flex-col gap-1">
          <h1 className="scroll-m-20 text-4xl font-extrabold tracking-tight text-balance">
            Taxing Laughter: The Joke Tax Chronicles
          </h1>
          <p className="text-muted-foreground text-xl">
            A modal dialog that interrupts the user with important content.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:flex-row">
          <Button>Button</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
          <Button variant="outline" size="icon" aria-label="Submit">
            <ChevronRightIcon />
          </Button>
          <Button size="sm">
            <MailIcon /> Login with Email
          </Button>
        </div>
        <blockquote className="mt-6 border-l-2 pl-6 italic">
          "After all," he said, "everyone enjoys a good joke, so it's only fair that they should pay
          for the privilege."
        </blockquote>
        <ul className="my-6 ml-6 list-disc [&>li]:mt-2">
          <li>1st level of puns: 5 gold coins</li>
          <li>2nd level of jokes: 10 gold coins</li>
          <li>3rd level of one-liners : 20 gold coins</li>
        </ul>
        <div className="grid grid-cols-3 gap-4">
          {["Notifications", "Messages", "Billing"].map((title) => (
            <div
              key={title}
              className="flex flex-col gap-2 rounded-xl border bg-card p-6 shadow-sm"
            >
              <div className="flex items-center gap-2 font-semibold">
                <BellIcon className="size-4 text-muted-foreground" /> {title}
              </div>
              <p className="text-sm text-muted-foreground">
                You have <strong className="text-foreground">3</strong> unread items.
              </p>
              <div className="flex items-center gap-1 text-sm text-emerald-500">
                <CheckIcon className="size-4" /> synced
              </div>
            </div>
          ))}
        </div>
      </div>
    </ThemeProvider>
  );
}

process.env.MIRIN_METAL_TITLE = "metal-ui smoke";
process.env.MIRIN_METAL_SIZE ??= "1200x800";
const transport = spawnNativeHost(
  Bun.argv[2] ??
    new URL("../../../crates/mirin-metal/target/debug/mirin-metal-host", import.meta.url).pathname,
);
const root = render(<Smoke />, transport);
transport.onClose(() => {
  root.unmount();
  process.exit(0);
});
