import { View } from "@mirinjs/metal";
import type { ReactNode } from "react";
import { OverlayHost } from "./lib/overlay.tsx";
import { darkTheme, type Theme, ThemeContext } from "./theme.ts";

export interface ThemeProviderProps {
  theme?: Theme;
  children: ReactNode;
}

/**
 * Wrap the app once. Provides the shadcn tokens, paints the `background`,
 * and hosts the overlay layer that dialogs, sheets, and menus render into.
 */
export function ThemeProvider({ theme = darkTheme, children }: ThemeProviderProps) {
  return (
    <ThemeContext.Provider value={theme}>
      <View style={{ flex: 1, flexDirection: "column", backgroundColor: theme.colors.background }}>
        <OverlayHost>{children}</OverlayHost>
      </View>
    </ThemeContext.Provider>
  );
}
