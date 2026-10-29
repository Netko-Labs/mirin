/**
 * Stand-in for the `cmdk` package on Metal: `Command` with `Input`, `List`,
 * `Empty`, `Group`, `Item`, `Separator`, `Loading`, and `Dialog`. Items
 * register with the root; typing in the input filters them by their value
 * (the `value` prop, else their text) and `keywords`. The selected item is
 * the root `value` when it is visible, else the first visible enabled item;
 * it carries `data-selected="true"`. Hovering an item selects it, pressing it
 * (or Enter in the input) fires `onSelect(value)`.
 *
 * cmdk styles parts through attribute selectors (`[&_[cmdk-item]]:py-3`);
 * those descendant classes are collected on the root and applied to the
 * matching parts. Results keep their render order (cmdk sorts by score).
 */

import {
  Children,
  createContext,
  isValidElement,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn.ts";
import { Slot } from "../lib/slot.tsx";
import { useControllableState, useStableId } from "../lib/state.ts";
import type { SyntheticEvent } from "../runtime/events.ts";
import { splitVariants } from "../tw/variants.ts";
import { Dialog as DialogPrimitive } from "./dialog.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

interface ItemRecord {
  value: string;
  keywords: string[];
  group: string;
  disabled: boolean;
  forceMount: boolean;
}

interface CommandApi {
  search: string;
  setSearch: (search: string) => void;
  selected: string | undefined;
  setSelected: (value: string) => void;
  filter: (value: string, search: string, keywords?: string[]) => number;
  shouldFilter: boolean;
  register: (id: string, record: ItemRecord) => void;
  unregister: (id: string) => void;
  isVisible: (id: string) => boolean;
  visibleCount: () => number;
  groupVisible: (group: string) => boolean;
  selectedId: () => string | undefined;
  select: (id: string) => void;
  onSelectHandlers: Map<string, (value: string) => void>;
  descendant: Record<string, string>;
}

const CommandContext = createContext<CommandApi | null>(null);

function useCommand(): CommandApi {
  const api = useContext(CommandContext);
  if (!api) throw new Error("Command parts must be inside <Command>");
  return api;
}

const GroupContext = createContext("");

/**
 * cmdk's ranking contract (higher is better, 0 hides): a substring match
 * scores 1 (0.9 for keywords), an in-order subsequence 0.5.
 */
export function defaultFilter(value: string, search: string, keywords: string[] = []): number {
  const query = search.trim().toLowerCase();
  if (!query) return 1;
  const score = (text: string): number => {
    const haystack = text.toLowerCase();
    if (haystack.includes(query)) return 1;
    let at = 0;
    for (const ch of haystack) {
      if (ch === query[at]) at += 1;
      if (at === query.length) return 0.5;
    }
    return 0;
  };
  return Math.max(score(value), ...keywords.map((keyword) => score(keyword) * 0.9));
}

/** The text of a React subtree (cmdk falls back to an item's textContent). */
export function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return Children.toArray(props.children).map(textOf).join("");
  }
  return "";
}

const DESCENDANT = /^\[&_\[cmdk-([\w-]+)\]\]$/;

/** `[&_[cmdk-item]]:py-3` → `{ item: "py-3" }`; other tokens stay on the root. */
function splitDescendant(className: string | undefined): {
  own: string;
  parts: Record<string, string>;
} {
  const own: string[] = [];
  const parts: Record<string, string> = {};
  for (const token of (className ?? "").split(/\s+/)) {
    if (!token) continue;
    const [first, ...rest] = splitVariants(token);
    const match = first?.match(DESCENDANT);
    if (match && rest.length > 0) {
      const part = match[1] ?? "";
      parts[part] = cn(parts[part], rest.join(":"));
    } else {
      own.push(token);
    }
  }
  return { own: own.join(" "), parts };
}

function Root({
  asChild,
  className,
  value,
  defaultValue,
  onValueChange,
  shouldFilter = true,
  filter,
  label,
  loop: _a,
  vimBindings: _b,
  disablePointerSelection: _c,
  children,
  ...props
}: Props & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  shouldFilter?: boolean;
  filter?: (value: string, search: string, keywords?: string[]) => number;
  label?: string;
  loop?: boolean;
  vimBindings?: boolean;
  disablePointerSelection?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useControllableState<string | undefined>({
    prop: value,
    defaultProp: defaultValue,
    onChange: onValueChange as ((value: string | undefined) => void) | undefined,
  });
  const items = useRef(new Map<string, ItemRecord>());
  const onSelectHandlers = useRef(new Map<string, (value: string) => void>()).current;
  const [, setVersion] = useState(0);
  const split = useMemo(() => splitDescendant(className), [className]);
  const score = filter ?? defaultFilter;

  const visible = (id: string): boolean => {
    const record = items.current.get(id);
    if (!record) return false;
    if (!shouldFilter || record.forceMount || !search) return true;
    return score(record.value, search, record.keywords) > 0;
  };
  const visibleIds = (): string[] => [...items.current.keys()].filter(visible);
  const selectedId = (): string | undefined => {
    const ids = visibleIds().filter((id) => !items.current.get(id)?.disabled);
    const match = ids.find((id) => items.current.get(id)?.value === selected);
    return match ?? ids[0];
  };

  const api: CommandApi = {
    search,
    setSearch,
    selected,
    setSelected: (next) => setSelected(next),
    filter: score,
    shouldFilter,
    register: (id, record) => {
      const previous = items.current.get(id);
      items.current.set(id, record);
      if (
        !previous ||
        previous.value !== record.value ||
        previous.disabled !== record.disabled ||
        previous.keywords.join() !== record.keywords.join()
      ) {
        setVersion((v) => v + 1);
      }
    },
    unregister: (id) => {
      if (items.current.delete(id)) setVersion((v) => v + 1);
    },
    isVisible: visible,
    visibleCount: () => visibleIds().filter((id) => !items.current.get(id)?.forceMount).length,
    groupVisible: (group) => visibleIds().some((id) => items.current.get(id)?.group === group),
    selectedId,
    select: (id) => {
      const record = items.current.get(id);
      if (!record || record.disabled) return;
      onSelectHandlers.get(id)?.(record.value);
    },
    onSelectHandlers,
    descendant: split.parts,
  };

  const shared: Props = {
    ...props,
    "cmdk-root": "",
    "aria-label": label,
    className: split.own,
  };
  return (
    <CommandContext.Provider value={api}>
      {asChild ? <Slot {...shared}>{children}</Slot> : <div {...shared}>{children}</div>}
    </CommandContext.Provider>
  );
}

function Input({
  className,
  value,
  onValueChange,
  onChange,
  onKeyDown,
  ...props
}: Props & { value?: string; onValueChange?: (search: string) => void }) {
  const command = useCommand();
  const controlled = value !== undefined;
  // A controlled input drives the root search.
  useLayoutEffect(() => {
    if (controlled && value !== command.search) command.setSearch(value);
  });
  const shared: Props = {
    ...props,
    "cmdk-input": "",
    role: "combobox",
    "aria-autocomplete": "list",
    className: cn(command.descendant.input, className),
    value: controlled ? value : command.search,
    onChange: (event: SyntheticEvent) => {
      (onChange as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (!controlled) command.setSearch(event.target.value);
      onValueChange?.(event.target.value);
    },
    onKeyDown: (event: SyntheticEvent) => {
      (onKeyDown as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (event.defaultPrevented || event.key !== "Enter") return;
      const id = command.selectedId();
      if (id) command.select(id);
    },
  };
  return <input {...shared} />;
}

function List({ asChild, label: _label, ...props }: Props & { label?: string }) {
  const shared: Props = { ...props, "cmdk-list": "", role: "listbox" };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

function Empty({ asChild, ...props }: Props) {
  const command = useCommand();
  if (command.visibleCount() > 0) return null;
  const shared: Props = { ...props, "cmdk-empty": "", role: "presentation" };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

function Loading({ asChild, progress, label: _l, ...props }: Props & { progress?: number }) {
  const shared: Props = {
    ...props,
    "cmdk-loading": "",
    role: "progressbar",
    "aria-valuenow": progress,
  };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

function Group({
  asChild,
  heading,
  value: _value,
  forceMount = false,
  children,
  className,
  ...props
}: Props & { heading?: ReactNode; value?: string; forceMount?: boolean }) {
  const command = useCommand();
  const id = useStableId("cmdk-group");
  const hidden = !forceMount && command.search !== "" && !command.groupVisible(id);
  const split = splitDescendant(cn(command.descendant.group, className));
  const shared: Props = {
    ...props,
    "cmdk-group": "",
    role: "presentation",
    className: split.own,
  };
  // metal: a filtered-out group stays mounted (its items keep registering so
  // it can reappear) but drops its heading and classes, collapsing to nothing.
  if (hidden) {
    return (
      <GroupContext.Provider value={id}>
        <div cmdk-group="" hidden>
          {children}
        </div>
      </GroupContext.Provider>
    );
  }
  const body = (
    <>
      {heading !== undefined && heading !== null ? (
        <div
          cmdk-group-heading=""
          aria-hidden
          className={cn(command.descendant["group-heading"], split.parts["group-heading"])}
        >
          {heading}
        </div>
      ) : null}
      <div cmdk-group-items="" role="group" className="flex flex-col">
        {children}
      </div>
    </>
  );
  return (
    <GroupContext.Provider value={id}>
      {asChild ? <Slot {...shared}>{body}</Slot> : <div {...shared}>{body}</div>}
    </GroupContext.Provider>
  );
}

function Item({
  asChild,
  value,
  keywords,
  disabled = false,
  onSelect,
  forceMount = false,
  className,
  children,
  onClick,
  onMouseEnter,
  ...props
}: Props & {
  value?: string;
  keywords?: string[];
  disabled?: boolean;
  onSelect?: (value: string) => void;
  forceMount?: boolean;
}) {
  const command = useCommand();
  const group = useContext(GroupContext);
  const id = useStableId("cmdk-item");
  const resolved = (value ?? textOf(children)).trim();
  const keywordKey = (keywords ?? []).join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keywordKey summarizes keywords
  useLayoutEffect(() => {
    command.register(id, {
      value: resolved,
      keywords: keywords ?? [],
      group,
      disabled,
      forceMount,
    });
  }, [id, resolved, keywordKey, group, disabled, forceMount]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: unregister once on unmount
  useLayoutEffect(() => () => command.unregister(id), [id]);
  if (onSelect) command.onSelectHandlers.set(id, onSelect);
  else command.onSelectHandlers.delete(id);

  if (!command.isVisible(id) && command.search !== "") return null;
  const selected = command.selectedId() === id;
  const shared: Props = {
    ...props,
    "cmdk-item": "",
    role: "option",
    "data-value": resolved,
    "data-selected": selected ? "true" : "false",
    "aria-selected": selected,
    "data-disabled": disabled ? "true" : "false",
    "aria-disabled": disabled ? "true" : undefined,
    className: cn(command.descendant.item, className),
    onMouseEnter: (event: SyntheticEvent) => {
      (onMouseEnter as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (!disabled) command.setSelected(resolved);
    },
    onClick: (event: SyntheticEvent) => {
      (onClick as ((e: SyntheticEvent) => void) | undefined)?.(event);
      if (!disabled) command.select(id);
    },
  };
  return asChild ? <Slot {...shared}>{children}</Slot> : <div {...shared}>{children}</div>;
}

function Separator({
  asChild,
  alwaysRender = false,
  ...props
}: Props & { alwaysRender?: boolean }) {
  const command = useCommand();
  if (!alwaysRender && command.search !== "") return null;
  const shared: Props = { ...props, "cmdk-separator": "", role: "separator" };
  return asChild ? <Slot {...shared} /> : <div {...shared} />;
}

/** `Command.Dialog`: a Command inside a Radix-style dialog. */
function CommandDialog({
  open,
  defaultOpen,
  onOpenChange,
  overlayClassName,
  contentClassName,
  container: _container,
  children,
  ...props
}: Props & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  overlayClassName?: string;
  contentClassName?: string;
  container?: unknown;
}) {
  return (
    <DialogPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay cmdk-overlay="" className={overlayClassName} />
        <DialogPrimitive.Content cmdk-dialog="" className={contentClassName}>
          <Root {...props}>{children}</Root>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** cmdk's `useCommandState(selector)`, over the parts of the state Metal tracks. */
export function useCommandState<T>(
  selector: (state: {
    search: string;
    value: string | undefined;
    filtered: { count: number };
  }) => T,
): T {
  const command = useCommand();
  return selector({
    search: command.search,
    value: command.selected,
    filtered: { count: command.visibleCount() },
  });
}

export const Command = Object.assign(Root, {
  Input,
  List,
  Empty,
  Loading,
  Group,
  Item,
  Separator,
  Dialog: CommandDialog,
});

export {
  Root as CommandRoot,
  Input as CommandInput,
  List as CommandList,
  Empty as CommandEmpty,
  Loading as CommandLoading,
  Group as CommandGroup,
  Item as CommandItem,
  Separator as CommandSeparator,
  CommandDialog,
};
