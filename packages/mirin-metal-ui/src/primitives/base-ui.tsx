/**
 * Stand-in for `@base-ui/react` on Metal, covering the `Combobox` parts
 * shadcn's `ui/combobox.tsx` uses: Root, Input, Trigger, Clear, Value,
 * Portal, Positioner, Popup, List, Item, ItemIndicator, Group, GroupLabel,
 * Collection, Empty, Separator, Chips, Chip, ChipRemove.
 *
 * Typing in the input opens the popup and filters items by label
 * (case-insensitive substring, or `filter`); pressing an item selects it
 * (single: sets the value, fills the input, closes; `multiple`: toggles it
 * in the value array). The popup anchors under the input (or the `Chips`
 * row) and closes on an outside press. Base UI's `render` prop is honored:
 * the given element is rendered with the part's props merged in. Each part
 * namespace carries a `Props` type, like Base UI's `Combobox.Item.Props`.
 */

import type { Bounds } from "@mirinjs/metal";
import { View } from "@mirinjs/metal";
import {
  cloneElement,
  createContext,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useState,
} from "react";
import { mergeProps } from "../lib/slot.tsx";
import { useControllableState } from "../lib/state.ts";
import { DismissLayer, Portal as OverlayPortal } from "../overlay/host.tsx";
import { Popper } from "../overlay/popper.tsx";
import type { SyntheticEvent } from "../runtime/events.ts";
import { boundsOf, stripPlacement } from "./shared.tsx";

type AnyProps = Record<string, unknown>;
type Handler = ((event: SyntheticEvent) => void) | undefined;
type Side = "top" | "right" | "bottom" | "left";
type Align = "start" | "center" | "end";

/** Base UI parts accept every attribute plus `render` and `className`. */
export type PartProps = AnyProps & {
  children?: ReactNode;
  className?: string;
  render?: ReactElement | ((props: AnyProps) => ReactNode);
};

/** Render `tag`, or the `render` element/function with `props` merged in. */
function renderPart(tag: string, render: PartProps["render"], props: AnyProps): ReactNode {
  if (typeof render === "function") return render(props);
  if (isValidElement(render)) {
    const own = render.props as AnyProps;
    const merged = mergeProps(props, own);
    if (props.children !== undefined && own.children === undefined) {
      merged.children = props.children;
    }
    return cloneElement(render, merged);
  }
  const Tag = tag as "div";
  return <Tag {...(props as AnyProps)} />;
}

interface ComboboxApi {
  value: unknown;
  multiple: boolean;
  isSelected: (item: unknown) => boolean;
  toggle: (item: unknown) => void;
  remove: (item: unknown) => void;
  clear: () => void;
  inputValue: string;
  setInputValue: (value: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  anchor: Bounds | null;
  setAnchor: (bounds: Bounds | null) => void;
  /** Set by `Chips`: anchors the popup instead of the input. */
  pinned: boolean;
  setPinned: (pinned: boolean) => void;
  highlighted: unknown;
  setHighlighted: (item: unknown) => void;
  label: (item: unknown) => string;
  matches: (item: unknown) => boolean;
  items: unknown[] | undefined;
  filtered: unknown[] | undefined;
  disabled: boolean;
}

const ComboboxContext = createContext<ComboboxApi | null>(null);

function useCombobox(): ComboboxApi {
  const api = useContext(ComboboxContext);
  if (!api) throw new Error("Combobox parts must be inside <Combobox.Root>");
  return api;
}

function defaultLabel(item: unknown): string {
  if (item === null || item === undefined) return "";
  if (typeof item === "object" && "label" in item) return String(item.label);
  return String(item);
}

/** Flatten grouped items (`{ value, items: [...] }`) for filtering. */
function flatten(items: unknown[] | undefined): unknown[] | undefined {
  if (!items) return undefined;
  return items.flatMap((item) =>
    item && typeof item === "object" && "items" in item && Array.isArray(item.items)
      ? item.items
      : [item],
  );
}

export interface RootProps {
  items?: unknown[];
  value?: unknown;
  defaultValue?: unknown;
  onValueChange?: (value: unknown, details?: unknown) => void;
  inputValue?: string;
  defaultInputValue?: string;
  onInputValueChange?: (value: string, details?: unknown) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, details?: unknown) => void;
  multiple?: boolean;
  disabled?: boolean;
  itemToStringLabel?: (item: unknown) => string;
  itemToStringValue?: (item: unknown) => string;
  isItemEqualToValue?: (item: unknown, value: unknown) => boolean;
  filter?: ((item: unknown, query: string) => boolean) | null;
  autoHighlight?: boolean;
  name?: string;
  children?: ReactNode;
  [prop: string]: unknown;
}

function Root({
  items,
  value,
  defaultValue,
  onValueChange,
  inputValue,
  defaultInputValue = "",
  onInputValueChange,
  open,
  defaultOpen = false,
  onOpenChange,
  multiple = false,
  disabled = false,
  itemToStringLabel,
  isItemEqualToValue,
  filter,
  children,
}: RootProps) {
  const [selected, setSelected] = useControllableState<unknown>({
    prop: value,
    defaultProp: defaultValue ?? (multiple ? [] : null),
    onChange: onValueChange,
  });
  const [query, setQuery] = useControllableState({
    prop: inputValue,
    defaultProp: defaultInputValue,
    onChange: onInputValueChange,
  });
  const [isOpen, setOpen] = useControllableState({
    prop: open,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });
  const [anchor, setAnchor] = useState<Bounds | null>(null);
  const [pinned, setPinned] = useState(false);
  const [highlighted, setHighlighted] = useState<unknown>(undefined);
  const label = itemToStringLabel ?? defaultLabel;
  const equal = isItemEqualToValue ?? ((a: unknown, b: unknown) => Object.is(a, b));
  const values = multiple ? (Array.isArray(selected) ? selected : []) : [];
  const isSelected = (item: unknown) =>
    multiple
      ? values.some((entry) => equal(item, entry))
      : selected != null && equal(item, selected);
  // The input showing the selected label is not a search: show every item.
  const search = !multiple && selected != null && query === label(selected) ? "" : query;
  const matches = (item: unknown): boolean => {
    if (filter === null || !search) return true;
    if (filter) return filter(item, search);
    return label(item).toLowerCase().includes(search.toLowerCase());
  };
  const flat = flatten(items);
  const api: ComboboxApi = {
    value: selected,
    multiple,
    isSelected,
    toggle: (item) => {
      if (multiple) {
        setSelected(
          isSelected(item) ? values.filter((entry) => !equal(item, entry)) : [...values, item],
        );
        setQuery("");
      } else {
        setSelected(item);
        setQuery(label(item));
        setOpen(false);
      }
    },
    remove: (item) => setSelected(values.filter((entry) => !equal(item, entry))),
    clear: () => {
      setSelected(multiple ? [] : null);
      setQuery("");
    },
    inputValue: query,
    setInputValue: setQuery,
    open: isOpen,
    setOpen,
    anchor,
    setAnchor,
    pinned,
    setPinned,
    highlighted,
    setHighlighted,
    label,
    matches,
    items,
    filtered: flat?.filter(matches),
    disabled,
  };
  return <ComboboxContext.Provider value={api}>{children}</ComboboxContext.Provider>;
}

function Input({ render, onChange, disabled, ...props }: PartProps & { disabled?: boolean }) {
  const combobox = useCombobox();
  const element = renderPart("input", render, {
    ...props,
    disabled: disabled ?? combobox.disabled,
    role: "combobox",
    "aria-expanded": combobox.open,
    value: combobox.inputValue,
    onChange: (event: SyntheticEvent) => {
      (onChange as Handler)?.(event);
      combobox.setInputValue(event.target.value);
      combobox.setOpen(true);
    },
  });
  // metal: inputs report no rect, so a wrapper measures where the popup anchors.
  return (
    <View
      style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center" }}
      onLayout={(bounds) => {
        if (!combobox.pinned) combobox.setAnchor(bounds);
      }}
    >
      {element}
    </View>
  );
}

function Trigger({ render, onClick, children, ...props }: PartProps) {
  const combobox = useCombobox();
  return renderPart("button", render, {
    type: "button",
    ...props,
    children,
    "data-popup-open": combobox.open ? "" : undefined,
    "aria-expanded": combobox.open,
    onClick: (event: SyntheticEvent) => {
      (onClick as Handler)?.(event);
      if (event.defaultPrevented || combobox.disabled) return;
      if (!combobox.anchor) combobox.setAnchor(boundsOf(event));
      combobox.setOpen(!combobox.open);
    },
  });
}

function Clear({ render, onClick, ...props }: PartProps) {
  const combobox = useCombobox();
  const hasValue = combobox.multiple
    ? Array.isArray(combobox.value) && combobox.value.length > 0
    : combobox.value != null || combobox.inputValue !== "";
  if (!hasValue) return null;
  return renderPart("button", render, {
    type: "button",
    "aria-label": "Clear",
    ...props,
    onClick: (event: SyntheticEvent) => {
      (onClick as Handler)?.(event);
      if (!event.defaultPrevented) combobox.clear();
    },
  });
}

const ChipContext = createContext<unknown>(undefined);

function Value({
  children,
  placeholder,
}: {
  children?: ReactNode | ((value: unknown) => ReactNode);
  placeholder?: ReactNode;
  [prop: string]: unknown;
}) {
  const combobox = useCombobox();
  if (typeof children === "function") {
    const rendered = children(combobox.value);
    if (combobox.multiple && Array.isArray(rendered) && Array.isArray(combobox.value)) {
      const values = combobox.value;
      return (
        <>
          {rendered.map((node, index) => (
            <ChipContext.Provider
              key={isValidElement(node) && node.key !== null ? node.key : index}
              value={values[index]}
            >
              {node}
            </ChipContext.Provider>
          ))}
        </>
      );
    }
    return <>{rendered}</>;
  }
  if (children !== undefined) return <>{children}</>;
  if (combobox.value == null || (Array.isArray(combobox.value) && combobox.value.length === 0)) {
    return <>{placeholder ?? null}</>;
  }
  return (
    <>
      {Array.isArray(combobox.value)
        ? combobox.value.map(combobox.label).join(", ")
        : combobox.label(combobox.value)}
    </>
  );
}

function Portal({ children }: { children?: ReactNode; [prop: string]: unknown }) {
  return <>{children}</>;
}

const SideContext = createContext<Side>("bottom");

function Positioner({
  side = "bottom",
  align = "center",
  sideOffset = 0,
  alignOffset = 0,
  anchor: _anchor,
  children,
}: PartProps & {
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  anchor?: unknown;
}) {
  const combobox = useCombobox();
  if (!combobox.open || !combobox.anchor) return null;
  return (
    <OverlayPortal>
      <DismissLayer testID="combobox-dismiss" onDismiss={() => combobox.setOpen(false)} />
      <Popper
        anchor={combobox.anchor}
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        matchWidth
      >
        <SideContext.Provider value={side}>{children}</SideContext.Provider>
      </Popper>
    </OverlayPortal>
  );
}

function Popup({ render, className, ...props }: PartProps) {
  const combobox = useCombobox();
  const side = useContext(SideContext);
  const empty = combobox.filtered ? combobox.filtered.length === 0 : false;
  return renderPart("div", render, {
    ...props,
    role: "listbox",
    "data-open": "",
    "data-side": side,
    "data-empty": empty ? "" : undefined,
    className: stripPlacement(className),
  });
}

function List({
  render,
  children,
  ...props
}: AnyProps & {
  className?: string;
  render?: PartProps["render"];
  children?: ReactNode | ((item: unknown, index: number) => ReactNode);
}) {
  const combobox = useCombobox();
  const empty = combobox.filtered ? combobox.filtered.length === 0 : false;
  let body: ReactNode;
  if (typeof children === "function") {
    body = (combobox.items ?? []).flatMap((item, index) => {
      const grouped =
        item && typeof item === "object" && "items" in item && Array.isArray(item.items);
      if (!grouped && !combobox.matches(item)) return [];
      return [children(item, index)];
    });
  } else {
    body = children;
  }
  return renderPart("div", render, {
    ...props,
    "data-empty": empty ? "" : undefined,
    children: body,
  });
}

const GroupItemsContext = createContext<unknown[] | undefined>(undefined);

function Group({ render, items, ...props }: PartProps & { items?: unknown[] }) {
  const combobox = useCombobox();
  if (items && !items.some(combobox.matches)) return null;
  return (
    <GroupItemsContext.Provider value={items}>
      {renderPart("div", render, { role: "group", ...props })}
    </GroupItemsContext.Provider>
  );
}

function GroupLabel({ render, ...props }: PartProps) {
  return renderPart("div", render, props);
}

function Collection({
  children,
}: {
  children?: (item: unknown, index: number) => ReactNode;
  [prop: string]: unknown;
}) {
  const combobox = useCombobox();
  const items = useContext(GroupItemsContext) ?? combobox.items ?? [];
  return <>{items.filter(combobox.matches).map((item, index) => children?.(item, index))}</>;
}

const ItemContext = createContext(false);

function Item({
  render,
  value,
  disabled = false,
  onClick,
  onMouseEnter,
  index: _index,
  ...props
}: PartProps & { value?: unknown; disabled?: boolean; index?: number }) {
  const combobox = useCombobox();
  if (!combobox.items && !combobox.matches(value)) return null;
  const selected = combobox.isSelected(value);
  const highlighted = Object.is(combobox.highlighted, value);
  return (
    <ItemContext.Provider value={selected}>
      {renderPart("div", render, {
        ...props,
        role: "option",
        "aria-selected": selected,
        "data-selected": selected ? "" : undefined,
        "data-highlighted": highlighted ? "" : undefined,
        "data-disabled": disabled ? "" : undefined,
        onMouseEnter: (event: SyntheticEvent) => {
          (onMouseEnter as Handler)?.(event);
          combobox.setHighlighted(value);
        },
        onClick: (event: SyntheticEvent) => {
          (onClick as Handler)?.(event);
          if (!disabled && !event.defaultPrevented) combobox.toggle(value);
        },
      })}
    </ItemContext.Provider>
  );
}

function ItemIndicator({
  render,
  keepMounted = false,
  ...props
}: PartProps & { keepMounted?: boolean }) {
  const selected = useContext(ItemContext);
  if (!selected && !keepMounted) return null;
  return renderPart("span", render, { "aria-hidden": true, ...props });
}

function Empty({ render, children, ...props }: PartProps) {
  const combobox = useCombobox();
  const empty = combobox.filtered ? combobox.filtered.length === 0 : false;
  return renderPart("div", render, { ...props, children: empty ? children : null });
}

function Separator({ render, ...props }: PartProps) {
  return renderPart("div", render, { role: "separator", ...props });
}

function Chips({ render, ...props }: PartProps) {
  const combobox = useCombobox();
  return renderPart("div", render, {
    ...props,
    onLayout: (bounds: Bounds) => {
      combobox.setPinned(true);
      combobox.setAnchor(bounds);
    },
  });
}

function Chip({ render, ...props }: PartProps) {
  return renderPart("div", render, props);
}

function ChipRemove({ render, onClick, ...props }: PartProps) {
  const combobox = useCombobox();
  const value = useContext(ChipContext);
  return renderPart("button", render, {
    type: "button",
    "aria-label": "Remove",
    ...props,
    onClick: (event: SyntheticEvent) => {
      (onClick as Handler)?.(event);
      if (!event.defaultPrevented) combobox.remove(value);
    },
  });
}

export const Combobox = {
  Root,
  Input,
  Trigger,
  Clear,
  Value,
  Portal,
  Positioner,
  Popup,
  List,
  Item,
  ItemIndicator,
  Group,
  GroupLabel,
  Collection,
  Empty,
  Separator,
  Chips,
  Chip,
  ChipRemove,
};

type ValueProps = Parameters<typeof Value>[0];
type ListProps = Parameters<typeof List>[0];
type CollectionProps = Parameters<typeof Collection>[0];
type PositionerProps = Parameters<typeof Positioner>[0];

/** Base UI's `Combobox.<Part>.Props` types (type-only; merges with the value above). */
export declare namespace Combobox {
  namespace Root {
    type Props = RootProps;
  }
  namespace Input {
    type Props = PartProps & { disabled?: boolean };
  }
  namespace Trigger {
    type Props = PartProps;
  }
  namespace Clear {
    type Props = PartProps;
  }
  namespace Value {
    type Props = ValueProps;
  }
  namespace Positioner {
    type Props = PositionerProps;
  }
  namespace Popup {
    type Props = PartProps;
  }
  namespace List {
    type Props = ListProps;
  }
  namespace Item {
    type Props = PartProps & { value?: unknown; disabled?: boolean; index?: number };
  }
  namespace ItemIndicator {
    type Props = PartProps & { keepMounted?: boolean };
  }
  namespace Group {
    type Props = PartProps & { items?: unknown[] };
  }
  namespace GroupLabel {
    type Props = PartProps;
  }
  namespace Collection {
    type Props = CollectionProps;
  }
  namespace Empty {
    type Props = PartProps;
  }
  namespace Separator {
    type Props = PartProps;
  }
  namespace Chips {
    type Props = PartProps;
  }
  namespace Chip {
    type Props = PartProps;
  }
  namespace ChipRemove {
    type Props = PartProps;
  }
}
