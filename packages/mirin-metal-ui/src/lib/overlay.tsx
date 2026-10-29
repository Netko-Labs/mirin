/**
 * Overlay layer: dialogs, sheets, and menus render above the app. The
 * `ThemeProvider` hosts one `relative` root; `Portal` mounts its children as
 * absolute, full-window layers after the app content so they paint on top.
 */

import { View } from "@mirinjs/metal";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface OverlayEntry {
  key: number;
  node: ReactNode;
}

interface OverlayApi {
  mount(key: number, node: ReactNode): void;
  unmount(key: number): void;
}

const OverlayContext = createContext<OverlayApi | null>(null);
let nextKey = 1;

export function OverlayHost({ children }: { children: ReactNode }) {
  const [layers, setLayers] = useState<OverlayEntry[]>([]);
  const api = useMemo<OverlayApi>(
    () => ({
      mount(key, node) {
        setLayers((current) => {
          const index = current.findIndex((entry) => entry.key === key);
          if (index >= 0) {
            const next = current.slice();
            next[index] = { key, node };
            return next;
          }
          return [...current, { key, node }];
        });
      },
      unmount(key) {
        setLayers((current) => current.filter((entry) => entry.key !== key));
      },
    }),
    [],
  );
  return (
    <OverlayContext.Provider value={api}>
      <View style={{ flex: 1, position: "relative", flexDirection: "column" }}>
        {children}
        {layers.map((layer) => (
          <View
            key={layer.key}
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
          >
            {layer.node}
          </View>
        ))}
      </View>
    </OverlayContext.Provider>
  );
}

/** Mount children in the overlay layer while rendered. */
export function Portal({ children }: { children: ReactNode }) {
  const api = useContext(OverlayContext);
  const key = useRef(0);
  if (key.current === 0) key.current = nextKey++;
  const current = key.current;
  useLayoutEffect(() => {
    api?.mount(current, children);
  });
  useLayoutEffect(() => () => api?.unmount(current), [api, current]);
  return null;
}

export function useOverlayAvailable(): boolean {
  return useContext(OverlayContext) !== null;
}

/** Scrim that closes on press, used by Dialog, Sheet, and menus. */
export function Scrim({
  onPress,
  color,
  testID,
}: {
  onPress: () => void;
  color: string;
  testID?: string;
}) {
  const press = useCallback(() => onPress(), [onPress]);
  return (
    <View
      onPress={press}
      testID={testID}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: color,
      }}
    />
  );
}
