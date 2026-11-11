import { useTheme } from "../theme.ts";

/** Evaluate `(min-width: Npx)` / `(max-width: Npx)` against the window width. */
export function useMediaQuery(query: string): boolean {
  const width = useTheme().viewportWidth;
  const min = query.match(/min-width:\s*(\d+)px/);
  const max = query.match(/max-width:\s*(\d+)px/);
  if (min && width < Number(min[1])) return false;
  if (max && width > Number(max[1])) return false;
  return Boolean(min || max);
}
