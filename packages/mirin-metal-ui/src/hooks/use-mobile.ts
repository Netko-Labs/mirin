import { useTheme } from "../theme.ts";

const MOBILE_BREAKPOINT = 768;

/** Whether the window is narrower than the `md` breakpoint. */
export function useIsMobile(): boolean {
  return useTheme().viewportWidth < MOBILE_BREAKPOINT;
}
