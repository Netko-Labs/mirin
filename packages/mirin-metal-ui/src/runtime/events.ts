/**
 * Minimal DOM-event shapes for handlers written against React DOM
 * (`onClick={(e) => e.preventDefault()}`, `onChange={(e) => set(e.target.value)}`).
 * Only the members shadcn code and common form libraries touch are present.
 */

import type { Bounds } from "@mirinjs/metal";

export interface SyntheticTarget {
  value: string;
  checked: boolean;
  name?: string;
  type?: string;
  files?: never[];
  /** Window-pixel rect, for code that anchors to the clicked element. */
  getBoundingClientRect: () => DOMRectLike;
}

export interface DOMRectLike {
  x: number;
  y: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SyntheticEvent {
  type: string;
  target: SyntheticTarget;
  currentTarget: SyntheticTarget;
  defaultPrevented: boolean;
  clientX: number;
  clientY: number;
  key?: string;
  preventDefault: () => void;
  stopPropagation: () => void;
  persist: () => void;
  nativeEvent: Record<string, never>;
}

function rect(bounds: Bounds | undefined): DOMRectLike {
  const b = bounds ?? { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: b.x,
    y: b.y,
    left: b.x,
    top: b.y,
    right: b.x + b.width,
    bottom: b.y + b.height,
    width: b.width,
    height: b.height,
  };
}

export function syntheticEvent(
  type: string,
  init: {
    value?: string;
    checked?: boolean;
    name?: string;
    inputType?: string;
    bounds?: Bounds;
    x?: number;
    y?: number;
    key?: string;
  } = {},
): SyntheticEvent {
  const target: SyntheticTarget = {
    value: init.value ?? "",
    checked: init.checked ?? false,
    name: init.name,
    type: init.inputType,
    files: [],
    getBoundingClientRect: () => rect(init.bounds),
  };
  const event: SyntheticEvent = {
    type,
    target,
    currentTarget: target,
    defaultPrevented: false,
    clientX: init.x ?? (init.bounds ? init.bounds.x + init.bounds.width / 2 : 0),
    clientY: init.y ?? (init.bounds ? init.bounds.y + init.bounds.height / 2 : 0),
    key: init.key,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
    stopPropagation: () => {},
    persist: () => {},
    nativeEvent: {},
  };
  return event;
}
