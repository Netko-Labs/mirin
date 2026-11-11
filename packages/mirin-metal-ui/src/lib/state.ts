/** Controlled/uncontrolled state, the `useControllableState` every Radix primitive uses. */

import { useCallback, useRef, useState } from "react";

export function useControllableState<T>({
  prop,
  defaultProp,
  onChange,
}: {
  prop?: T;
  defaultProp: T;
  onChange?: (value: T) => void;
}): [T, (next: T | ((previous: T) => T)) => void] {
  const [own, setOwn] = useState<T>(defaultProp);
  const controlled = prop !== undefined;
  const value = controlled ? (prop as T) : own;
  const latest = useRef(value);
  latest.current = value;
  const set = useCallback(
    (next: T | ((previous: T) => T)) => {
      const resolved =
        typeof next === "function" ? (next as (previous: T) => T)(latest.current) : next;
      if (Object.is(resolved, latest.current)) return;
      if (!controlled) setOwn(resolved);
      onChange?.(resolved);
    },
    [controlled, onChange],
  );
  return [value, set];
}

let counter = 0;
/** Stable id for the lifetime of a component (`React.useId` without colons). */
export function useStableId(prefix = "m"): string {
  const ref = useRef<string | null>(null);
  if (ref.current === null) {
    counter += 1;
    ref.current = `${prefix}${counter}`;
  }
  return ref.current;
}
