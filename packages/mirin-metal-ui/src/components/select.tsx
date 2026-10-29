import { createContext, type ReactNode, useContext, useState } from "react";
import { cn } from "../lib/cn.ts";
import { Box, Content, Txt } from "../lib/styled.tsx";

interface SelectApi {
  value: string | undefined;
  open: boolean;
  labels: Map<string, ReactNode>;
  setOpen: (open: boolean) => void;
  select: (value: string) => void;
}

const SelectContext = createContext<SelectApi | null>(null);

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children?: ReactNode;
  disabled?: boolean;
}

/**
 * The listbox opens anchored under the trigger (absolute within the Select's
 * own relative box), like a native popup, and closes on selection.
 */
export function Select({ value, defaultValue, onValueChange, children }: SelectProps) {
  const [internal, setInternal] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [labels] = useState(() => new Map<string, ReactNode>());
  const current = value ?? internal;
  const api: SelectApi = {
    value: current,
    open,
    labels,
    setOpen,
    select: (next) => {
      if (value === undefined) setInternal(next);
      onValueChange?.(next);
      setOpen(false);
    },
  };
  return (
    <SelectContext.Provider value={api}>
      <Box className="flex flex-col relative">{children}</Box>
    </SelectContext.Provider>
  );
}

export function SelectTrigger({
  className,
  children,
  testID,
}: {
  className?: string;
  children?: ReactNode;
  testID?: string;
}) {
  const select = useContext(SelectContext);
  return (
    <Box
      className={cn(
        "flex flex-row items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm h-9 whitespace-nowrap",
        className,
      )}
      onPress={() => select?.setOpen(!select.open)}
      testID={testID}
    >
      {children}
      <Txt className="text-muted-foreground">▾</Txt>
    </Box>
  );
}

export function SelectValue({ placeholder }: { placeholder?: string }) {
  const select = useContext(SelectContext);
  const label = select?.value !== undefined ? select.labels.get(select.value) : undefined;
  if (label !== undefined) return <Content>{label}</Content>;
  return <Txt className="text-muted-foreground">{placeholder ?? ""}</Txt>;
}

export function SelectContent({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const select = useContext(SelectContext);
  if (!select?.open) {
    // Still mount items invisibly so their labels register for SelectValue.
    return <Box style={{ height: 0, overflow: "hidden" }}>{children}</Box>;
  }
  return (
    <Box
      className={cn(
        "absolute flex flex-col gap-0.5 rounded-md border bg-popover text-popover-foreground p-1 min-w-32",
        className,
      )}
      style={{ top: 40, left: 0, right: 0 }}
    >
      {children}
    </Box>
  );
}

export function SelectItem({
  value,
  className,
  children,
  testID,
}: {
  value: string;
  className?: string;
  children?: ReactNode;
  testID?: string;
}) {
  const select = useContext(SelectContext);
  select?.labels.set(value, children);
  const selected = select?.value === value;
  return (
    <Box
      className={cn(
        "flex flex-row items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground",
        selected && "bg-accent",
        className,
      )}
      onPress={() => select?.select(value)}
      testID={testID ?? `select:${value}`}
    >
      <Content>{children}</Content>
      {selected ? <Txt className="text-muted-foreground">✓</Txt> : null}
    </Box>
  );
}

export function SelectGroup({ children }: { children?: ReactNode }) {
  return <Box className="flex flex-col">{children}</Box>;
}

export function SelectLabel({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <Box className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}>
      <Content>{children}</Content>
    </Box>
  );
}

export function SelectSeparator() {
  return <Box className="h-px bg-border my-1" />;
}
