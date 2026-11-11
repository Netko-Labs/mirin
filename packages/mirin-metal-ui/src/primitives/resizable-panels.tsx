/**
 * `react-resizable-panels` (v4) on Metal: `Group`, `Panel`, and `Separator`.
 * Panels size as percentages of the group (`width: "40%"` in a horizontal
 * group, `height` in a vertical one); dragging a separator moves the
 * boundary between its neighbors through `onPointerDown/Move/Up`, clamped
 * by `minSize`/`maxSize`. Size props follow v4: numbers are pixels, strings
 * without a unit or with `%` are percentages, `px`/`rem` strings are lengths.
 */

import type { Bounds } from "@mirinjs/metal";
import {
  createContext,
  type ReactNode,
  type Ref,
  useContext,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useStableId } from "../lib/state.ts";
import { Box } from "../runtime/box.tsx";
import type { SyntheticEvent } from "../runtime/events.ts";

export type Layout = Record<string, number>;
export type Orientation = "horizontal" | "vertical";
export interface PanelSize {
  asPercentage: number;
  inPixels: number;
}
export interface GroupImperativeHandle {
  getLayout(): Layout;
  setLayout(layout: Layout): Layout;
}
export interface PanelImperativeHandle {
  collapse(): void;
  expand(): void;
  getSize(): PanelSize;
  isCollapsed(): boolean;
  resize(size: number | string): void;
}

type Html = Record<string, unknown> & { className?: string; style?: Record<string, unknown> };

export type GroupProps = Html & {
  children?: ReactNode;
  orientation?: Orientation;
  defaultLayout?: Layout;
  disabled?: boolean;
  id?: string | number;
  groupRef?: Ref<GroupImperativeHandle | null>;
  elementRef?: Ref<unknown>;
  onLayoutChange?: (layout: Layout) => void;
  onLayoutChanged?: (layout: Layout, meta: { isUserInteraction: boolean }) => void;
};

export type PanelProps = Html & {
  children?: ReactNode;
  id?: string | number;
  defaultSize?: number | string;
  minSize?: number | string;
  maxSize?: number | string;
  collapsible?: boolean;
  collapsedSize?: number | string;
  disabled?: boolean;
  panelRef?: Ref<PanelImperativeHandle | null>;
  elementRef?: Ref<unknown>;
  onResize?: (
    size: PanelSize,
    id: string | number | undefined,
    previous: PanelSize | undefined,
  ) => void;
};

export type SeparatorProps = Html & {
  children?: ReactNode;
  id?: string | number;
  disabled?: boolean;
  elementRef?: Ref<unknown>;
};

interface PanelEntry {
  kind: "panel";
  id: string;
  props: PanelProps;
}
interface SeparatorEntry {
  kind: "separator";
  id: string;
}
type Entry = PanelEntry | SeparatorEntry;

interface GroupApi {
  orientation: Orientation;
  layout: Layout;
  register(entry: Entry): () => void;
  update(entry: PanelEntry): void;
  size(): number;
  beginDrag(separatorId: string, position: number): void;
  drag(position: number): void;
  endDrag(): void;
  draggingId: string | null;
  setPanelSize(id: string, percent: number): void;
}

const GroupContext = createContext<GroupApi | null>(null);

function useGroup(part: string): GroupApi {
  const group = useContext(GroupContext);
  if (!group) throw new Error(`<${part}> must be inside a <Group>`);
  return group;
}

/** A size prop as a percentage of `total` px (undefined when unparseable). */
export function toPercent(value: number | string | undefined, total: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return total > 0 ? (value / total) * 100 : undefined;
  const match = value.trim().match(/^(-?\d*\.?\d+)\s*(%|px|rem|em)?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] ?? "%";
  if (unit === "%") return amount;
  const px = unit === "px" ? amount : amount * 16;
  return total > 0 ? (px / total) * 100 : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function initialLayout(panels: PanelEntry[], total: number, saved: Layout | undefined): Layout {
  const layout: Layout = {};
  let assigned = 0;
  const open: PanelEntry[] = [];
  for (const panel of panels) {
    const size = saved?.[panel.id] ?? toPercent(panel.props.defaultSize, total);
    if (size === undefined) open.push(panel);
    else {
      layout[panel.id] = size;
      assigned += size;
    }
  }
  const share = open.length > 0 ? Math.max(0, 100 - assigned) / open.length : 0;
  for (const panel of open) layout[panel.id] = share;
  return layout;
}

export function Group({
  children,
  orientation = "horizontal",
  defaultLayout,
  disabled,
  id,
  groupRef,
  elementRef,
  onLayoutChange,
  onLayoutChanged,
  className,
  style,
  ...rest
}: GroupProps) {
  const entries = useRef<Entry[]>([]);
  const [layout, setLayout] = useState<Layout>({});
  const [version, setVersion] = useState(0);
  const [total, setTotal] = useState(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const drag = useRef<{ id: string; start: number; layout: Layout } | null>(null);
  const latest = useRef(layout);
  latest.current = layout;
  const horizontal = orientation === "horizontal";

  const panels = () => entries.current.filter((e): e is PanelEntry => e.kind === "panel");
  const commit = (next: Layout, user: boolean, done: boolean) => {
    setLayout(next);
    latest.current = next;
    onLayoutChange?.(next);
    if (done) onLayoutChanged?.(next, { isUserInteraction: user });
  };

  // Lay out once every child has registered (and again when the set changes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: version tracks registration
  useLayoutEffect(() => {
    const list = panels();
    const known = list.every((panel) => latest.current[panel.id] !== undefined);
    if (known && list.length === Object.keys(latest.current).length) return;
    commit(initialLayout(list, total, defaultLayout), false, true);
  }, [version]);

  useImperativeHandle(groupRef, () => ({
    getLayout: () => latest.current,
    setLayout: (next: Layout) => {
      commit({ ...latest.current, ...next }, false, true);
      return latest.current;
    },
  }));

  const api: GroupApi = {
    orientation,
    layout,
    draggingId,
    register(entry) {
      entries.current = [...entries.current, entry];
      setVersion((v) => v + 1);
      return () => {
        entries.current = entries.current.filter((e) => e.id !== entry.id);
        setVersion((v) => v + 1);
      };
    },
    update(entry) {
      entries.current = entries.current.map((e) => (e.id === entry.id ? entry : e));
    },
    size: () => total,
    beginDrag(separatorId, position) {
      if (disabled) return;
      drag.current = { id: separatorId, start: position, layout: latest.current };
      setDraggingId(separatorId);
    },
    drag(position) {
      const state = drag.current;
      if (!state || total <= 0) return;
      const index = entries.current.findIndex((e) => e.id === state.id);
      const before = entries.current
        .slice(0, index)
        .filter((e): e is PanelEntry => e.kind === "panel")
        .at(-1);
      const after = entries.current
        .slice(index + 1)
        .find((e): e is PanelEntry => e.kind === "panel");
      if (!before || !after || before.props.disabled || after.props.disabled) return;
      const a = state.layout[before.id] ?? 0;
      const b = state.layout[after.id] ?? 0;
      const pair = a + b;
      const bound = (panel: PanelEntry, key: "minSize" | "maxSize", fallback: number) =>
        toPercent(panel.props[key], total) ?? fallback;
      const low = Math.max(bound(before, "minSize", 0), pair - bound(after, "maxSize", 100));
      const high = Math.min(bound(before, "maxSize", 100), pair - bound(after, "minSize", 0));
      const nextA = clamp(a + ((position - state.start) / total) * 100, low, high);
      commit(
        { ...latest.current, [before.id]: round(nextA), [after.id]: round(pair - nextA) },
        true,
        false,
      );
    },
    endDrag() {
      if (!drag.current) return;
      drag.current = null;
      setDraggingId(null);
      onLayoutChanged?.(latest.current, { isUserInteraction: true });
    },
    setPanelSize(panelId, percent) {
      const list = panels();
      const index = list.findIndex((panel) => panel.id === panelId);
      const neighbor = list[index + 1] ?? list[index - 1];
      if (index < 0 || !neighbor) return;
      const current = latest.current[panelId] ?? 0;
      const other = latest.current[neighbor.id] ?? 0;
      const next = clamp(percent, 0, current + other);
      commit(
        { ...latest.current, [panelId]: round(next), [neighbor.id]: round(current + other - next) },
        false,
        true,
      );
    },
  };

  const groupId = id === undefined ? undefined : String(id);
  return (
    <GroupContext.Provider value={api}>
      <Box
        {...rest}
        ref={elementRef}
        id={groupId}
        data-testid={groupId}
        data-group=""
        aria-orientation={orientation}
        className={className}
        style={style}
        viewStyle={{ flexDirection: horizontal ? "row" : "column", overflow: "hidden" }}
        onLayout={(bounds: Bounds) => setTotal(horizontal ? bounds.width : bounds.height)}
      >
        {children}
      </Box>
    </GroupContext.Provider>
  );
}

export function Panel({
  children,
  id,
  className,
  style,
  panelRef,
  elementRef,
  defaultSize,
  minSize,
  maxSize,
  collapsible,
  collapsedSize,
  disabled,
  onResize,
  ...rest
}: PanelProps) {
  const group = useGroup("Panel");
  const stableId = useStableId("panel");
  const panelId = id === undefined ? stableId : String(id);
  const entry: PanelEntry = {
    kind: "panel",
    id: panelId,
    props: { defaultSize, minSize, maxSize, collapsible, collapsedSize, disabled },
  };
  group.update(entry);
  // biome-ignore lint/correctness/useExhaustiveDependencies: register once per id
  useLayoutEffect(() => group.register(entry), [panelId]);

  const size = group.layout[panelId] ?? toPercent(defaultSize, group.size());
  const previous = useRef<PanelSize | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire on size changes only
  useLayoutEffect(() => {
    if (size === undefined) return;
    const next = { asPercentage: size, inPixels: (size / 100) * group.size() };
    if (previous.current?.asPercentage === next.asPercentage) return;
    onResize?.(next, id, previous.current);
    previous.current = next;
  }, [size]);
  const restore = useRef<number | undefined>(undefined);
  useImperativeHandle(panelRef, () => ({
    collapse: () => {
      restore.current = size;
      group.setPanelSize(panelId, toPercent(collapsedSize, group.size()) ?? 0);
    },
    expand: () =>
      group.setPanelSize(panelId, restore.current ?? toPercent(minSize, group.size()) ?? 50),
    getSize: () => ({ asPercentage: size ?? 0, inPixels: ((size ?? 0) / 100) * group.size() }),
    isCollapsed: () => (size ?? 0) <= (toPercent(collapsedSize, group.size()) ?? 0),
    resize: (next) => {
      const percent = toPercent(next, group.size());
      if (percent !== undefined) group.setPanelSize(panelId, percent);
    },
  }));

  const horizontal = group.orientation === "horizontal";
  const extent =
    size === undefined ? { flex: 1 } : { [horizontal ? "width" : "height"]: `${round(size)}%` };
  return (
    <Box
      {...rest}
      ref={elementRef}
      id={id === undefined ? undefined : panelId}
      data-panel=""
      viewStyle={{ ...extent, flexShrink: 1, overflow: "hidden", flexDirection: "column" }}
    >
      <Box className={className} style={style} viewStyle={{ width: "100%", height: "100%" }}>
        {children}
      </Box>
    </Box>
  );
}

export function Separator({
  children,
  id,
  disabled,
  elementRef,
  className,
  style,
  ...rest
}: SeparatorProps) {
  const group = useGroup("Separator");
  const stableId = useStableId("separator");
  const separatorId = id === undefined ? stableId : String(id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: register once per id
  useLayoutEffect(() => group.register({ kind: "separator", id: separatorId }), [separatorId]);
  const horizontal = group.orientation === "horizontal";
  const along = (event: SyntheticEvent) => (horizontal ? event.clientX : event.clientY);
  const handlers = disabled
    ? {}
    : {
        onPointerDown: (event: SyntheticEvent) => group.beginDrag(separatorId, along(event)),
        onPointerMove: (event: SyntheticEvent) => group.drag(along(event)),
        onPointerUp: () => group.endDrag(),
      };
  const active = group.draggingId === separatorId;
  return (
    <Box
      {...rest}
      ref={elementRef}
      id={id === undefined ? undefined : separatorId}
      role="separator"
      data-separator={active ? "active" : "inactive"}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-disabled={disabled || undefined}
      className={className}
      style={style}
      viewStyle={{ flexShrink: 0 }}
      {...handlers}
    >
      {/* metal: the web's `after:` pseudo-element widens the hit area; a transparent box does here. */}
      <Box
        viewStyle={
          horizontal
            ? { position: "absolute", top: 0, bottom: 0, left: -4, width: 9 }
            : { position: "absolute", left: 0, right: 0, top: -4, height: 9 }
        }
        {...handlers}
      />
      {children}
    </Box>
  );
}

export function useGroupRef() {
  return useRef<GroupImperativeHandle | null>(null);
}

export function usePanelRef() {
  return useRef<PanelImperativeHandle | null>(null);
}

/** v3 names, for code written against `PanelGroup`/`PanelResizeHandle`. */
export { Group as PanelGroup, Separator as PanelResizeHandle };
