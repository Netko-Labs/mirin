import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Uses rolldown-vite (the Rust-powered Vite) via the `vite` npm alias in
// package.json. The mirin dev window loads this dev server for HMR.
export default defineConfig({
  root: ".",
  server: { port: 5173, strictPort: true },
  plugins: [react()],
});
