/**
 * `has-*` variants (`has-[>svg]:px-3`, `has-data-[slot=card-action]:grid-cols-[1fr_auto]`)
 * match against what an element's descendants render, which is only known
 * after they render. An element whose classes use `has-` owns a registry;
 * descendants (Boxes, svgs, icons, form controls) register their tag and
 * attributes with the nearest one after mounting, and the owner re-renders
 * once with what it learned. Elements outside any owner do no extra work.
 */

import { createContext, useContext, useId, useLayoutEffect, useRef, useState } from "react";
import type { Attrs, HasEntry } from "../tw/variants.ts";

interface Registry {
  set(id: string, entry: HasEntry | null): void;
}

interface HasScope {
  registry: Registry;
  /** Whether elements rendered here are direct children of the owner. */
  direct: boolean;
}

export const HasContext = createContext<HasScope | null>(null);

function sameEntry(a: HasEntry | undefined, b: HasEntry): boolean {
  if (!a || a.tag !== b.tag || a.direct !== b.direct) return false;
  const keys = Object.keys(b.attrs);
  return (
    keys.length === Object.keys(a.attrs).length &&
    keys.every((key) => a.attrs[key] === b.attrs[key])
  );
}

const NO_ENTRIES: ReadonlyMap<string, HasEntry> = new Map();
const NO_LIST: HasEntry[] = [];

/** What an owner keeps between renders: its scope, and what it last derived. */
interface OwnerCell {
  own: HasScope | null;
  parent: HasScope | null;
  indirect: HasScope | null;
  entries: ReadonlyMap<string, HasEntry>;
  list: HasEntry[];
}

/**
 * Own a registry when `active`. Returns the entries descendants registered
 * and the scope to provide to children (null when nothing changes). Every
 * element calls this on every render, and nearly all own nothing and sit
 * under no owner: those make nothing here.
 */
export function useHasOwner(active: boolean): {
  entries: HasEntry[];
  scope: HasScope | null;
} {
  const parent = useContext(HasContext);
  const [entries, setEntries] = useState(NO_ENTRIES);
  const kept = useRef<OwnerCell | null>(null);
  if (!active && !parent?.direct) return INERT;
  kept.current ??= { own: null, parent: null, indirect: null, entries: NO_ENTRIES, list: NO_LIST };
  const cell = kept.current;
  if (cell.entries !== entries) {
    cell.entries = entries;
    cell.list = [...entries.values()];
  }
  if (active) {
    cell.own ??= {
      registry: {
        set(id, entry) {
          setEntries((current) => {
            if (entry === null) {
              if (!current.has(id)) return current;
              const next = new Map(current);
              next.delete(id);
              return next;
            }
            if (sameEntry(current.get(id), entry)) return current;
            return new Map(current).set(id, entry);
          });
        },
      },
      direct: true,
    };
    return { entries: cell.list, scope: cell.own };
  }
  // Children of a direct child are no longer direct children of the owner.
  if (cell.parent !== parent) {
    cell.parent = parent;
    cell.indirect = parent ? { registry: parent.registry, direct: false } : null;
  }
  return { entries: cell.list, scope: cell.indirect };
}

const INERT: { entries: HasEntry[]; scope: HasScope | null } = { entries: NO_LIST, scope: null };

/** Register this element (tag + attributes) with the nearest `has-` owner. */
export function useHasRegistration(tag: string, attrs: Attrs, key: string): void {
  const scope = useContext(HasContext);
  const id = useId();
  const latest = useRef(attrs);
  latest.current = attrs;
  // biome-ignore lint/correctness/useExhaustiveDependencies: key summarizes attrs
  useLayoutEffect(() => {
    if (!scope) return;
    scope.registry.set(id, { tag, attrs: latest.current, direct: scope.direct });
    return () => scope.registry.set(id, null);
  }, [scope, id, tag, key]);
}
