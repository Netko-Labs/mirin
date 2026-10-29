import { createContext, type ReactNode, useContext, useState } from "react";
import { cn } from "../lib/cn.ts";
import { Box, Content } from "../lib/styled.tsx";

interface TabsApi {
  value: string;
  setValue: (value: string) => void;
}

const TabsContext = createContext<TabsApi>({ value: "", setValue: () => {} });

export interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  children?: ReactNode;
}

export function Tabs({ value, defaultValue, onValueChange, className, children }: TabsProps) {
  const [internal, setInternal] = useState(defaultValue ?? "");
  const current = value ?? internal;
  const setValue = (next: string) => {
    if (value === undefined) setInternal(next);
    onValueChange?.(next);
  };
  return (
    <TabsContext.Provider value={{ value: current, setValue }}>
      <Box className={cn("flex flex-col gap-2", className)}>{children}</Box>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <Box
      className={cn(
        "flex flex-row items-center justify-center gap-1 rounded-lg bg-muted p-[3px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </Box>
  );
}

export interface TabsTriggerProps {
  value: string;
  className?: string;
  children?: ReactNode;
  disabled?: boolean;
  testID?: string;
}

export function TabsTrigger({ value, className, children, disabled, testID }: TabsTriggerProps) {
  const tabs = useContext(TabsContext);
  const active = tabs.value === value;
  return (
    <Box
      className={cn(
        "flex flex-1 flex-row items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap",
        active ? "bg-background text-foreground border-border" : "text-muted-foreground",
        disabled && "opacity-50",
        className,
      )}
      onPress={() => {
        if (!disabled) tabs.setValue(value);
      }}
      testID={testID ?? `tab:${value}`}
    >
      <Content>{children}</Content>
    </Box>
  );
}

export function TabsContent({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children?: ReactNode;
}) {
  const tabs = useContext(TabsContext);
  if (tabs.value !== value) return null;
  return <Box className={cn("flex flex-1 flex-col", className)}>{children}</Box>;
}
