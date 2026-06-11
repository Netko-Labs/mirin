import { rpc } from "mirinjs/rpc";
import { app } from "mirinjs";
import type { WindowMaterial, WindowMaterialOptions } from "mirinjs/config";

/** The material the UI most recently asked for (echoed back on connect). */
let current: WindowMaterial | WindowMaterialOptions | null = {
  type: "liquidGlass",
  cornerRadius: 20,
};

export const router = rpc.router({
  current: rpc.query(async () => current),

  // Swap the window's native background material live. `null` removes it,
  // leaving a plain transparent (OSR) window.
  setMaterial: rpc.mutation(async (material: WindowMaterial | WindowMaterialOptions | null) => {
    current = material;
    await app.windows.get("glass").setMaterial(material);
  }),
});

export type Router = typeof router;
