import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  server: { port: 5173, strictPort: true },
  plugins: [react()],
});
