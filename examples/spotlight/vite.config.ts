import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: ".",
  base: "./",
  server: { port: 5173, strictPort: true },
  plugins: [react()],
});
