import type { WindowMaterial, WindowMaterialOptions } from "../../config/index.ts";

/** Normalize the `material` option (name or object, or null) to native form. */
export function normalizeMaterial(
  material: WindowMaterial | WindowMaterialOptions | null | undefined,
): WindowMaterialOptions | null {
  if (!material) return null;
  return typeof material === "string" ? { type: material } : material;
}
