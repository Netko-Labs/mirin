import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "./",
  server: { port: 5173, strictPort: true },
  plugins: [react()],
});
