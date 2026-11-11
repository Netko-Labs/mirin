/**
 * `has-*` variants (`has-[>svg]:px-3`, `has-data-[slot=card-action]:grid-cols-[1fr_auto]`)
 * match against what an element's descendants render, which is only known
 * after they render. An element whose classes use `has-` owns a registry;
 * descendants (Boxes, svgs, icons, form controls) register their tag and
 * attributes with the nearest one after mounting, and the owner re-renders
 * once with what it learned. Elements outside any owner do no extra work.
 */

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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

/**
 * Own a registry when `active`. Returns the entries descendants registered
 * and the scope to provide to children (null when nothing changes).
 */
export function useHasOwner(active: boolean): {
  entries: HasEntry[];
  scope: HasScope | null;
} {
  const parent = useContext(HasContext);
  const [entries, setEntries] = useState<ReadonlyMap<string, HasEntry>>(() => new Map());
  const set = useCallback((id: string, entry: HasEntry | null) => {
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
  }, []);
  const own = useMemo<HasScope>(() => ({ registry: { set }, direct: true }), [set]);
  // Children of a direct child are no longer direct children of the owner.
  const indirect = useMemo<HasScope | null>(
    () => (parent?.direct ? { registry: parent.registry, direct: false } : null),
    [parent],
  );
  const list = useMemo(() => [...entries.values()], [entries]);
  if (active) return { entries: list, scope: own };
  return { entries: list, scope: indirect };
}

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
