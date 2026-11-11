import { View } from "@mirinjs/metal";
import { type ReactNode, useMemo, useState } from "react";
import { OverlayHost } from "./overlay/host.tsx";
import { InheritedContext } from "./runtime/context.ts";
import { createTheme, type ThemeApi, ThemeContext, type ThemeName } from "./theme.ts";

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
  const api = useMemo<ThemeApi>(
    () => ({
      ...createTheme(name, mode),
      theme: setting,
      resolvedTheme: mode,
      setTheme: setSetting,
      setThemeName: setName,
      viewportWidth,
    }),
    [name, mode, setting, viewportWidth],
  );
  return (
    <ThemeContext.Provider value={api}>
      <InheritedContext.Provider
        value={{ text: { color: api.colors.foreground, fontSize: 16 }, svg: {} }}
      >
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
    </ThemeContext.Provider>
  );
}
