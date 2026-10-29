/**
 * The overlay layer. `OverlayHost` mounts one full-window layer after the
 * app content; `Portal` renders into it with React portals, so context
 * flows through and overlays escape clipping and stacking of their trigger.
 * The layer reports its size, which is the window size popups place against.
 */

import { type Bounds, createPortal, View } from "@mirinjs/metal";
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useState,
  useSyncExternalStore,
} from "react";

export interface OverlayApi {
  layer: unknown;
  /** Window size in px (0 until the first paint). */
  size: { width: number; height: number };
}

const OverlayContext = createContext<OverlayApi>({ layer: null, size: { width: 0, height: 0 } });

export function useOverlay(): OverlayApi {
  return useContext(OverlayContext);
}

/**
 * Components every `OverlayHost` mounts after the app content, registered at
 * module load (sonner's `toast()` renders through one so examples need no
 * `<Toaster />`). They render inside the theme and overlay contexts.
 */
const ambient = new Set<ComponentType>();
const ambientListeners = new Set<() => void>();
let ambientSnapshot: ComponentType[] = [];

export function registerOverlayChild(component: ComponentType): void {
  if (ambient.has(component)) return;
  ambient.add(component);
  ambientSnapshot = [...ambient];
  for (const listener of ambientListeners) listener();
}

function useAmbient(): ComponentType[] {
  return useSyncExternalStore(
    (listener) => {
      ambientListeners.add(listener);
      return () => ambientListeners.delete(listener);
    },
    () => ambientSnapshot,
  );
}

export function OverlayHost({
  children,
  onResize,
}: {
  children: ReactNode;
  onResize?: (bounds: Bounds) => void;
}) {
  const [layer, setLayer] = useState<unknown>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const extras = useAmbient();
  return (
    <OverlayContext.Provider value={{ layer, size }}>
      <View style={{ flex: 1, flexDirection: "column", position: "relative" }}>
        {children}
        <View
          ref={setLayer as never}
          onLayout={(bounds) => {
            setSize({ width: bounds.width, height: bounds.height });
            onResize?.(bounds);
          }}
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
        />
        {extras.map((Extra, index) => (
          <Extra key={index} />
        ))}
      </View>
    </OverlayContext.Provider>
  );
}

/** Render children into the overlay layer (on top of everything rendered before). */
export function Portal({ children }: { children?: ReactNode; container?: unknown }) {
  const { layer } = useOverlay();
  if (!layer) return null;
  return createPortal(
    <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>{children}</View>,
    layer,
  );
}

/** Full-window layer under a popup: blocks the app and dismisses on press. */
export function DismissLayer({
  onDismiss,
  color,
  testID,
}: {
  onDismiss: () => void;
  color?: string;
  testID?: string;
}) {
  return (
    <View
      occlude
      testID={testID}
      onPress={() => onDismiss()}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        ...(color ? { backgroundColor: color } : {}),
      }}
    />
  );
}
