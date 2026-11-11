import { View } from "@mirinjs/metal";
import { type ReactNode, useMemo, useState } from "react";
import { OverlayHost } from "./overlay/host.tsx";
import { type Inherited, InheritedContext } from "./runtime/context.ts";
import {
  createTheme,
  type StyleTheme,
  StyleThemeContext,
  type ThemeApi,
  ThemeContext,
  type ThemeName,
} from "./theme.ts";
import { breakpointFloor } from "./tw/index.ts";

export interface ThemeProviderProps {
  /** `"light" | "dark" | "system"` (system resolves to dark on Metal). */
  defaultTheme?: "light" | "dark" | "system";
  /** Registry palette: `neutral` (default), `zinc`, `stone`, `blue`, … */
  themeName?: ThemeName;
  children?: ReactNode;
  /** Accepted for `next-themes` parity; ignored. */
  attribute?: string;
  enableSystem?: boolean;
  disableTransitionOnChange?: boolean;
}

/**
 * Provide a theme: the whole of it to `useTheme()`, and to styling the part
 * that changes only with the palette, the mode or a breakpoint crossed
 * (`useStyleTheme`). Every provider of a theme goes through here.
 */
export function ThemeScope({ value, children }: { value: ThemeApi; children?: ReactNode }) {
  const { colors, radius, mode } = value;
  const viewportWidth = breakpointFloor(value.viewportWidth);
  const style = useMemo<StyleTheme>(
    () => ({ colors, radius, mode, viewportWidth }),
    [colors, radius, mode, viewportWidth],
  );
  return (
    <ThemeContext.Provider value={value}>
      <StyleThemeContext.Provider value={style}>{children}</StyleThemeContext.Provider>
    </ThemeContext.Provider>
  );
}

/**
 * Wrap the app once. Provides the shadcn tokens, paints `bg-background` with
 * `text-foreground`, and hosts the overlay layer that dialogs, popovers,
 * menus, and toasts render into.
 */
export function ThemeProvider({
  defaultTheme = "dark",
  themeName = "neutral",
  children,
}: ThemeProviderProps) {
  const [setting, setSetting] = useState(defaultTheme);
  const [name, setName] = useState<ThemeName>(themeName);
  const [viewportWidth, setViewportWidth] = useState(1280);
  const mode = setting === "light" ? "light" : "dark";
  // The tokens are made when the palette or the mode changes, not with the
  // window's width: elements style by their identity (`ThemeScope`).
  const base = useMemo(() => createTheme(name, mode), [name, mode]);
  const api = useMemo<ThemeApi>(
    () => ({
      ...base,
      theme: setting,
      resolvedTheme: mode,
      setTheme: setSetting,
      setThemeName: setName,
      viewportWidth,
    }),
    [base, mode, setting, viewportWidth],
  );
  const inherited = useMemo<Inherited>(
    () => ({ text: { color: base.colors.foreground, fontSize: 16 }, svg: {} }),
    [base],
  );
  return (
    <ThemeScope value={api}>
      <InheritedContext.Provider value={inherited}>
        <View style={{ flex: 1, flexDirection: "column", backgroundColor: api.colors.background }}>
          <OverlayHost
            onResize={(bounds) => {
              if (Math.abs(bounds.width - viewportWidth) >= 1) setViewportWidth(bounds.width);
            }}
          >
            {children}
          </OverlayHost>
        </View>
      </InheritedContext.Provider>
    </ThemeScope>
  );
}
