import { createContext, type ReactNode, useContext, useState } from "react";
import { cn } from "../lib/cn.ts";
import { Box, Content } from "../lib/styled.tsx";
import { Dialog, DialogContent } from "./dialog.tsx";
import { Input } from "./input.tsx";

interface CommandApi {
  query: string;
  setQuery: (query: string) => void;
}

const CommandContext = createContext<CommandApi>({ query: "", setQuery: () => {} });

/** cmdk-style palette: items filter on the typed query by their text value. */
export function Command({ className, children }: { className?: string; children?: ReactNode }) {
  const [query, setQuery] = useState("");
  return (
    <CommandContext.Provider value={{ query, setQuery }}>
      <Box
        className={cn(
          "flex flex-col rounded-md bg-popover text-popover-foreground overflow-hidden",
          className,
        )}
      >
        {children}
      </Box>
    </CommandContext.Provider>
  );
}

export function CommandDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
  title?: string;
  description?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="p-0 gap-0 w-[560px]"
        showCloseButton={false}
        testID="command-dialog"
      >
        <Command>{children}</Command>
      </DialogContent>
    </Dialog>
  );
}

export function CommandInput({ placeholder, testID }: { placeholder?: string; testID?: string }) {
  const api = useContext(CommandContext);
  return (
    <Box className="flex flex-row items-center border-b px-3">
      <Input
        value={api.query}
        placeholder={placeholder}
        autoFocus
        onChangeText={api.setQuery}
        className="border-transparent h-11"
        testID={testID ?? "command-input"}
      />
    </Box>
  );
}

export function CommandList({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <Box className={cn("flex flex-col max-h-[300px] overflow-auto p-1", className)}>{children}</Box>
  );
}

export function CommandEmpty({ children }: { children?: ReactNode }) {
  return (
    <Box className="py-6 text-center text-sm text-muted-foreground items-center">
      <Content>{children}</Content>
    </Box>
  );
}

export function CommandGroup({
  heading,
  className,
  children,
}: {
  heading?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Box className={cn("flex flex-col", className)}>
      {heading ? (
        <Box className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          <Content>{heading}</Content>
        </Box>
      ) : null}
      {children}
    </Box>
  );
}

export function CommandItem({
  value,
  className,
  children,
  onSelect,
  disabled = false,
  testID,
}: {
  value?: string;
  className?: string;
  children?: ReactNode;
  onSelect?: (value: string) => void;
  disabled?: boolean;
  testID?: string;
}) {
  const api = useContext(CommandContext);
  const label = value ?? (typeof children === "string" ? children : "");
  if (api.query && !label.toLowerCase().includes(api.query.toLowerCase())) return null;
  return (
    <Box
      className={cn(
        "flex flex-row items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground",
        disabled && "opacity-50",
        className,
      )}
      onPress={() => {
        if (!disabled) onSelect?.(label);
      }}
      testID={testID ?? `command:${label}`}
    >
      <Content>{children}</Content>
    </Box>
  );
}

export function CommandSeparator() {
  return <Box className="h-px bg-border my-1" />;
}

export function CommandShortcut({ children }: { children?: ReactNode }) {
  return (
    <Box className="ml-auto text-xs text-muted-foreground">
      <Content>{children}</Content>
    </Box>
  );
}
