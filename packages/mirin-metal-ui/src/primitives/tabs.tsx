/**
 * Radix `Tabs` on Metal: same part names and props. Triggers and contents
 * carry `data-state="active" | "inactive"` and `data-orientation`; inactive
 * content is not rendered (unless `forceMount`).
 */

import { createContext, type ReactNode, useContext } from "react";
import { Slot } from "../lib/slot.tsx";
import { useControllableState } from "../lib/state.ts";
import type { SyntheticEvent } from "../runtime/events.ts";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

type Orientation = "horizontal" | "vertical";

interface TabsApi {
  value: string;
  setValue: (value: string) => void;
  orientation: Orientation;
}

const TabsContext = createContext<TabsApi | null>(null);

function useTabs(): TabsApi {
  const api = useContext(TabsContext);
  if (!api) throw new Error("Tabs parts must be inside <Tabs.Root>");
  return api;
}

export type RootProps = Props & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: Orientation;
  activationMode?: "automatic" | "manual";
  dir?: "ltr" | "rtl";
};

function Root({
  value,
  defaultValue,
  onValueChange,
  orientation = "horizontal",
  activationMode: _mode,
  dir: _dir,
  asChild,
  ...props
}: RootProps) {
  const [current, setCurrent] = useControllableState({
    prop: value,
    defaultProp: defaultValue ?? "",
    onChange: onValueChange,
  });
  const shared: Props = { ...props, "data-orientation": orientation };
  return (
    <TabsContext.Provider value={{ value: current, setValue: setCurrent, orientation }}>
      {asChild ? <Slot {...shared} /> : <div {...shared} />}
    </TabsContext.Provider>
  );
}

function List({ asChild, loop: _loop, ...props }: Props) {
  const tabs = useTabs();
  const shared: Props = {
    ...props,
    role: "tablist",
    "aria-orientation": tabs.orientation,
    "data-orientation": tabs.orientation,
  };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

function stateOf(active: boolean): "active" | "inactive" {
  return active ? "active" : "inactive";
}

function Trigger({ value, disabled, asChild, onClick, ...props }: Props & { value: string }) {
  const tabs = useTabs();
  const active = tabs.value === value;
  const shared: Props = {
    ...props,
    role: "tab",
    "aria-selected": active,
    "data-state": stateOf(active),
    "data-orientation": tabs.orientation,
    disabled: disabled === true || undefined,
    ...(disabled === true ? { "data-disabled": "" } : {}),
    onClick: (event: SyntheticEvent) => {
      (onClick as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (!event.defaultPrevented && disabled !== true) tabs.setValue(value);
    },
  };
  return asChild ? <Slot {...shared} /> : <button type="button" {...shared} />;
}

function Content({
  value,
  forceMount,
  asChild,
  ...props
}: Props & { value: string; forceMount?: boolean }) {
  const tabs = useTabs();
  const active = tabs.value === value;
  if (!active && !forceMount) return null;
  const shared: Props = {
    ...props,
    role: "tabpanel",
    "data-state": stateOf(active),
    "data-orientation": tabs.orientation,
  };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

export const Tabs = { Root, List, Trigger, Content };
